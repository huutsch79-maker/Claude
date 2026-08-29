import * as http from "node:http";
import { isDomainId, type DomainId } from "../config/domains.js";
import { buildDashboardState } from "./readModel.js";
import { assertDashboardPayloadShape, type DashboardSource } from "./types.js";
import { DASHBOARD_HTML } from "./page.js";
import { validateAttachments, type ChatAttachmentInput, type ChatBackend } from "./chat.js";

export interface DashboardServerOptions {
  healthIntervalMs: number;
  /** Defaults to healthIntervalMs when omitted — see readModel.ts's ReadModelOptions. */
  contentIntervalMs?: number;
  chatBackend: ChatBackend;
}

const DASHBOARD_HEADER = "x-jarvis-dashboard";

/** How many prior turns are replayed as LLM context ahead of a new chat message. */
const CHAT_CONTEXT_LIMIT = 20;

/** Hard cap on a raw request body, well above MAX_DOCUMENT_BYTES/its base64 inflation, to bound an unbounded read. */
const MAX_CHAT_BODY_BYTES = 16 * 1024 * 1024;

/**
 * node:http only — no new npm dependency. Reads exclusively through the
 * DashboardSource passed in; never touches a domain instance, its stores,
 * or the database driver directly.
 *
 * Phase 1 is read-only: no approve/reject routes are registered. The POST
 * guard below still runs for any POST request (there just aren't any POST
 * routes yet to protect), so it's ready for Phase 2 without changes here.
 */
export function createDashboardServer(source: DashboardSource, opts: DashboardServerOptions): http.Server {
  return http.createServer((req, res) => {
    void handleRequest(source, opts, req, res);
  });
}

/**
 * http.Server.close()'s callback does not fire while any connection is
 * still open (idle-keepalive or mid-request) — a single stalled client
 * (flaky network, slow client, slowloris) would otherwise block shutdown
 * forever. Bounded here: give in-flight requests a grace period, then
 * force-close any sockets still open so close() can resolve. Exported so
 * it can be exercised directly against a real stalled connection in tests,
 * not just trusted by inspection.
 */
export function closeServer(server: http.Server, graceMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const forceTimer = setTimeout(() => server.closeAllConnections(), graceMs);
    server.close((err) => {
      clearTimeout(forceTimer);
      if (err) reject(err);
      else resolve();
    });
  });
}

async function handleRequest(
  source: DashboardSource,
  opts: DashboardServerOptions,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    // HEAD is routed exactly like GET (so uptime probes that default to
    // HEAD get a real status instead of a blanket 405) but the body is
    // omitted from the response, per HTTP semantics.
    const isHead = method === "HEAD";
    const routeMethod = isHead ? "GET" : method;

    // CORS-preflight protection (not auth): the server sends no CORS
    // headers of its own, so without this a cross-origin browser POST could
    // reach it blind. This guard runs before route dispatch, for any POST
    // to any path.
    if (method === "POST") {
      const header = req.headers[DASHBOARD_HEADER];
      if (header !== "1") {
        writeJson(res, 403, { error: "missing X-Jarvis-Dashboard header" }, isHead);
        return;
      }
    }

    if (pathname === "/") {
      if (routeMethod !== "GET") {
        writeJson(res, 405, { error: "method not allowed" }, isHead);
        return;
      }
      writeHtml(res, 200, DASHBOARD_HTML, isHead);
      return;
    }

    if (pathname === "/api/state") {
      if (routeMethod !== "GET") {
        writeJson(res, 405, { error: "method not allowed" }, isHead);
        return;
      }
      const payload = buildDashboardState(source, {
        healthIntervalMs: opts.healthIntervalMs,
        contentIntervalMs: opts.contentIntervalMs,
      });
      assertDashboardPayloadShape(payload);
      writeJson(res, 200, payload, isHead);
      return;
    }

    if (pathname === "/api/healthz") {
      if (routeMethod !== "GET") {
        writeJson(res, 405, { error: "method not allowed" }, isHead);
        return;
      }
      writeJson(res, 200, { ok: true }, isHead);
      return;
    }

    const chatMatch = matchChatPath(pathname);
    if (chatMatch) {
      await handleChatRoute(source, opts, req, res, method, isHead, chatMatch);
      return;
    }

    writeJson(res, 404, { error: "not found" }, isHead);
  } catch (err) {
    console.error("[dashboard] request handler error", err);
    if (!res.headersSent) {
      writeJson(res, 500, { error: "internal error" }, req.method === "HEAD");
    }
  }
}

function writeJson(res: http.ServerResponse, status: number, body: unknown, omitBody = false): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(omitBody ? undefined : data);
}

function writeHtml(res: http.ServerResponse, status: number, html: string, omitBody = false): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(omitBody ? undefined : html);
}

function matchChatPath(pathname: string): { domainParam: string; kind: "send" | "history" } | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 3 && parts[0] === "api" && parts[1] === "chat") {
    return { domainParam: parts[2]!, kind: "send" };
  }
  if (parts.length === 4 && parts[0] === "api" && parts[1] === "chat" && parts[3] === "history") {
    return { domainParam: parts[2]!, kind: "history" };
  }
  return null;
}

async function handleChatRoute(
  source: DashboardSource,
  opts: DashboardServerOptions,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  isHead: boolean,
  match: { domainParam: string; kind: "send" | "history" },
): Promise<void> {
  if (!isDomainId(match.domainParam)) {
    writeJson(res, 404, { error: "unknown domain" }, isHead);
    return;
  }
  const domainId: DomainId = match.domainParam;

  if (match.kind === "history") {
    if (method !== "GET") {
      writeJson(res, 405, { error: "method not allowed" }, isHead);
      return;
    }
    const messages = await source.recentChatHistory(domainId);
    writeJson(res, 200, { messages }, isHead);
    return;
  }

  // kind === "send"
  if (method !== "POST") {
    writeJson(res, 405, { error: "method not allowed" }, isHead);
    return;
  }

  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(req, MAX_CHAT_BODY_BYTES);
  } catch (err) {
    writeJson(res, 400, { error: err instanceof Error ? err.message : "invalid request body" }, isHead);
    return;
  }

  const parsed = parseChatRequestBody(rawBody);
  if (!parsed.ok) {
    writeJson(res, 400, { error: parsed.reason }, isHead);
    return;
  }

  // Attachment validation (server-side, on DECODED byte size) runs BEFORE
  // the backend is ever called — an oversized/invalid attachment never
  // reaches AnthropicChatBackend or gets persisted.
  const validation = validateAttachments(parsed.attachments);
  if (!validation.ok) {
    writeJson(res, 400, { error: validation.reason }, isHead);
    return;
  }

  const priorEntries = await source.recentChatHistory(domainId, CHAT_CONTEXT_LIMIT);
  const priorMessages = priorEntries.map((e) => ({ role: e.role, content: e.content }));

  // Persist metadata only — filename/mediaType/sizeBytes, never dataBase64/raw bytes.
  const attachmentMeta = validation.attachments.map((a) => ({ filename: a.filename, mediaType: a.mediaType, sizeBytes: a.sizeBytes }));
  await source.appendChatMessage(domainId, { role: "user", content: parsed.message, attachments: attachmentMeta });

  const reply = await opts.chatBackend.send(domainId, parsed.message, validation.attachments, priorMessages);
  const createdAt = new Date().toISOString();
  await source.appendChatMessage(domainId, { role: "assistant", content: reply.text, attachments: [] });

  writeJson(res, 200, { reply: { text: reply.text, createdAt } }, isHead);
}

type ParsedChatBody = { ok: true; message: string; attachments: ChatAttachmentInput[] } | { ok: false; reason: string };

function parseChatRequestBody(body: unknown): ParsedChatBody {
  if (typeof body !== "object" || body === null) {
    return { ok: false, reason: "request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.message !== "string" || b.message.trim().length === 0) {
    return { ok: false, reason: "message must be a non-empty string" };
  }

  const rawAttachments = b.attachments;
  if (rawAttachments === undefined) {
    return { ok: true, message: b.message, attachments: [] };
  }
  if (!Array.isArray(rawAttachments)) {
    return { ok: false, reason: "attachments must be an array" };
  }

  const attachments: ChatAttachmentInput[] = [];
  for (const item of rawAttachments) {
    if (typeof item !== "object" || item === null) {
      return { ok: false, reason: "each attachment must be an object" };
    }
    const i = item as Record<string, unknown>;
    if (typeof i.filename !== "string" || typeof i.mediaType !== "string" || typeof i.dataBase64 !== "string") {
      return { ok: false, reason: "each attachment must have filename, mediaType, and dataBase64 as strings" };
    }
    attachments.push({ filename: i.filename, mediaType: i.mediaType, dataBase64: i.dataBase64 });
  }
  return { ok: true, message: b.message, attachments };
}

/** No streaming body parser dependency: node:http gives raw chunks, so this reads + size-bounds + JSON.parses them directly. */
function readJsonBody(req: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}
