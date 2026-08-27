import * as http from "node:http";
import { buildDashboardState } from "./readModel.js";
import { assertDashboardPayloadShape, type DashboardSource } from "./types.js";
import { DASHBOARD_HTML } from "./page.js";

export interface DashboardServerOptions {
  healthIntervalMs: number;
}

const DASHBOARD_HEADER = "x-jarvis-dashboard";

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

    // CORS-preflight protection (not auth): the server sends no CORS
    // headers of its own, so without this a cross-origin browser POST could
    // reach it blind. This guard runs before route dispatch, for any POST
    // to any path.
    if (method === "POST") {
      const header = req.headers[DASHBOARD_HEADER];
      if (header !== "1") {
        writeJson(res, 403, { error: "missing X-Jarvis-Dashboard header" });
        return;
      }
    }

    if (pathname === "/") {
      if (method !== "GET") {
        writeJson(res, 405, { error: "method not allowed" });
        return;
      }
      writeHtml(res, 200, DASHBOARD_HTML);
      return;
    }

    if (pathname === "/api/state") {
      if (method !== "GET") {
        writeJson(res, 405, { error: "method not allowed" });
        return;
      }
      const payload = buildDashboardState(source, { healthIntervalMs: opts.healthIntervalMs });
      assertDashboardPayloadShape(payload);
      writeJson(res, 200, payload);
      return;
    }

    if (pathname === "/api/healthz") {
      if (method !== "GET") {
        writeJson(res, 405, { error: "method not allowed" });
        return;
      }
      writeJson(res, 200, { ok: true });
      return;
    }

    writeJson(res, 404, { error: "not found" });
  } catch (err) {
    console.error("[dashboard] request handler error", err);
    if (!res.headersSent) {
      writeJson(res, 500, { error: "internal error" });
    }
  }
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(data);
}

function writeHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}
