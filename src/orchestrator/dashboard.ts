import { createServer, type Server } from "node:http";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { listScripts } from "../core/scriptRegistry.js";
import type { ChatAttachment } from "../chat/chatService.js";
import type { Orchestrator } from "./orchestrator.js";

/**
 * Ops dashboard: chat, plus read-only visibility into operational metadata
 * (health, pending reviewer proposals, script run history, capability
 * registry listing) and the approve/reject/run actions that were
 * previously only reachable by editing the database or waiting for
 * Pushover. Every non-chat route below reads only from OperationalBus, the
 * jarvis.reviewer_proposals/script_runs tables, or capability *metadata*
 * (name/enabled/priority/credential ref — never a credential value).
 */
export function createDashboardServer(orchestrator: Orchestrator): Server {
  const app = express();
  app.use(express.json({ limit: "15mb" })); // headroom for base64 image/PDF chat attachments
  app.use(express.static(path.join(process.cwd(), "public")));

  const token = process.env.JARVIS_DASHBOARD_TOKEN;
  if (!token) {
    console.warn(
      "[dashboard] JARVIS_DASHBOARD_TOKEN is not set — the dashboard API is running WITHOUT auth. " +
        "Fine for localhost-only access during development; set this before exposing the dashboard beyond 127.0.0.1.",
    );
  }

  app.use("/api", (req: Request, res: Response, next: NextFunction) => {
    // Hit directly by Microsoft's browser redirect after OAuth consent — a
    // top-level navigation can't carry an Authorization header, so this one
    // route can't sit behind bearer auth. Its security comes from the
    // single-use `state` param instead (OAuthCredentialStore.completeAuthorization).
    if (req.path === "/oauth/callback") return next();
    if (!token) return next(); // dev mode, see warning above
    const header = req.header("authorization");
    if (header === `Bearer ${token}`) return next();
    res.status(401).json({ error: "unauthorized" });
  });

  const jarvis = orchestrator.jarvis;

  app.get("/api/health", (_req, res) => {
    res.json(orchestrator.bus.snapshot());
  });

  app.get("/api/scripts", (_req, res) => {
    res.json(listScripts().map((s) => ({ name: s.name, description: s.description, trustTier: s.trustTier })));
  });

  // Every DB-backed route below is wrapped in try/catch for the same
  // reason the scripts approve/reject routes already were: an async
  // Express handler that awaits a rejected promise with no try/catch of
  // its own becomes an unhandled rejection, and Node terminates the
  // whole process on those by default (Express 4 doesn't catch async
  // handler rejections itself — that's an Express 5 behavior). A
  // transient DB blip must degrade one dashboard panel, not take down
  // chat and everything else running in this same process.
  app.get("/api/proposals", async (req, res) => {
    try {
      const status = req.query.status as "pending" | "approved" | "rejected" | "applied" | undefined;
      res.json(await jarvis.ops.listReviewerProposals(status));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/proposals/:id/approve", async (req, res) => {
    try {
      const ok = await jarvis.ops.setReviewerProposalStatus(req.params.id!, "approved");
      res.status(ok ? 200 : 404).json({ ok });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/proposals/:id/reject", async (req, res) => {
    try {
      const ok = await jarvis.ops.setReviewerProposalStatus(req.params.id!, "rejected");
      res.status(ok ? 200 : 404).json({ ok });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/script-runs", async (_req, res) => {
    try {
      res.json(await jarvis.ops.listScriptRuns());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/scripts/:name/run", async (req, res) => {
    const args = (req.body?.args ?? {}) as Record<string, string>;
    try {
      const result = await jarvis.selfHeal.runScript(req.params.name!, args);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/scripts/:id/approve", async (req, res) => {
    // executeAndRecord (called by approveScript) deliberately re-throws
    // after recording the failure, so callers running scripts directly
    // (tests, future non-HTTP callers) still see the error — but an
    // Express handler that awaits a rejected promise without its own
    // try/catch becomes an unhandled rejection, and Node terminates the
    // whole process on those by default. A script failing during
    // approval (a bad file, deploy-agent unreachable, anything) must
    // never take down chat and the dashboard along with it.
    try {
      const ok = await jarvis.selfHeal.approveScript(req.params.id!);
      // A 404 here almost always means this request predates the last
      // orchestrator restart — ApprovalGate's pending map is in-memory
      // only (see its docstring), so a restart silently orphans anything
      // proposed before it. The fix is a fresh request, not retrying this
      // one. Worth spelling out since the alternative is a bare "HTTP 404".
      res.status(ok ? 200 : 404).json({
        ok,
        error: ok ? undefined : "no pending approval with that id — it likely predates the last orchestrator restart; ask for a fresh one",
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/scripts/:id/reject", async (req, res) => {
    try {
      const ok = await jarvis.selfHeal.rejectScript(req.params.id!);
      res.status(ok ? 200 : 404).json({
        ok,
        error: ok ? undefined : "no pending approval with that id — it likely predates the last orchestrator restart",
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/capabilities", async (_req, res) => {
    try {
      const rows = await jarvis.registry.list();
      const withCaps = await Promise.all(
        rows.map(async (r) => ({
          name: r.name,
          category: r.category,
          enabled: r.enabled,
          priority: r.priority,
          credentialRef: r.credentialRef,
          modelOverride: r.modelOverride,
          oauthConfigured: r.credentialRef ? jarvis.oauthCredentials.isConfigured(r.credentialRef) : false,
          oauthConnected: r.credentialRef ? await jarvis.oauthCredentials.isConnected(r.credentialRef) : false,
        })),
      );
      res.json(withCaps);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/capabilities/:name/enabled", async (req, res) => {
    try {
      const enabled = Boolean(req.body?.enabled);
      await jarvis.registry.setEnabled(req.params.name!, enabled);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Fetched via authenticated JS (not a raw browser nav) so it stays behind
  // the same bearer-token check as every other /api route — the browser
  // then does window.location = url itself to actually leave for Microsoft.
  app.get("/api/oauth/:ref/authorize-url", (req, res) => {
    const ref = req.params.ref!;
    if (!jarvis.oauthCredentials.isConfigured(ref)) {
      res.status(400).json({ error: `no OAuth app configured for "${ref}"` });
      return;
    }
    const url = jarvis.oauthCredentials.buildAuthorizeUrl(ref);
    res.json({ url });
  });

  // Hit directly by Microsoft's redirect after the user completes consent —
  // a plain browser GET with no Authorization header, so this route can't
  // sit behind the bearer-token middleware above. Its security comes from
  // the `state` parameter instead: unguessable, single-use, issued only to
  // an already-authenticated dashboard session, expires in 10 minutes. See
  // OAuthCredentialStore.completeAuthorization.
  app.get("/api/oauth/callback", async (req, res) => {
    const { code, state, error, error_description: errorDescription } = req.query;
    if (error) {
      // error alone (e.g. "invalid_request") is rarely enough to act on —
      // error_description carries Microsoft's actual specific reason.
      res.status(400).send(`OAuth error from Microsoft: ${error}${errorDescription ? ` — ${errorDescription}` : ""}`);
      return;
    }
    if (typeof code !== "string" || typeof state !== "string") {
      res.status(400).send("missing code or state");
      return;
    }
    try {
      const { ref } = await jarvis.oauthCredentials.completeAuthorization(state, code);
      res.redirect(`/?oauth_connected=${encodeURIComponent(ref)}`);
    } catch (err) {
      res.status(400).send(err instanceof Error ? err.message : String(err));
    }
  });

  // Starts a turn and returns immediately — does NOT wait for it to
  // finish. A multi-tool-call turn (several sequential capability calls,
  // each its own model round-trip plus an external API call) can
  // genuinely take longer than Cloudflare's ~100s edge timeout on a
  // proxied request; nothing on this side can extend that limit, so
  // instead the dashboard polls GET /api/chat/:sessionId/poll for the
  // result. No request stays open long enough to hit any timeout,
  // regardless of how long the turn actually takes.
  app.post("/api/chat", (req, res) => {
    const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId : null;
    const message = typeof req.body?.message === "string" ? req.body.message : null;
    if (!sessionId || !message) {
      res.status(400).json({ error: "sessionId and message are required strings" });
      return;
    }
    const attachments = parseAttachments(req.body?.attachments);
    if (attachments === "invalid") {
      res.status(400).json({ error: "each attachment needs mediaType and base64Data strings" });
      return;
    }
    if (!jarvis.chat) {
      res.status(503).json({ error: "chat is not configured (ANTHROPIC_API_KEY unset)" });
      return;
    }
    jarvis.chat.startTurn(sessionId, message, attachments);
    res.status(202).json({ accepted: true });
  });

  app.get("/api/chat/:sessionId/poll", (req, res) => {
    if (!jarvis.chat) {
      res.status(503).json({ error: "chat is not configured (ANTHROPIC_API_KEY unset)" });
      return;
    }
    res.json(jarvis.chat.pollTurn(req.params.sessionId!));
  });

  // Structured stats for the dashboard's insight tiles (unread email
  // counts, Azure spend, what's waiting on the user) — deterministic,
  // no LLM call, unlike asking JARVIS the same thing in chat. Each
  // source is fetched independently and never allowed to fail the
  // others: a missing OAuth connection or one flaky API must degrade
  // one tile, not the whole panel.
  app.get("/api/insights", async (_req, res) => {
    const [personalUnread, workUnread, azureCost, needsAttention, credentialHealth, scriptRunHistory, usageWaste] = await Promise.all([
      fetchUnreadCount(jarvis, "hotmail-outlook", "email.unreadCount"),
      fetchUnreadCount(jarvis, "nzb-m365-connector", "m365.mail.unreadCount"),
      fetchAzureCost(jarvis),
      fetchNeedsAttention(jarvis),
      fetchCredentialHealth(jarvis),
      fetchScriptRunHistory(jarvis),
      fetchUsageWaste(jarvis),
    ]);
    res.json({ personalUnread, workUnread, azureCost, needsAttention, credentialHealth, scriptRunHistory, usageWaste });
  });

  return createServer(app);
}

type InsightTile<T> = { status: "ok"; data: T } | { status: "not_connected" } | { status: "error"; message: string };

/**
 * Calls one capability's handle() directly — the same credential
 * resolution + module load ChatService's tool loop uses, but without
 * going through Claude at all, since these are exact, structured values
 * with one right answer (an unread count, a dollar figure), not
 * something worth an LLM round-trip to fetch on every dashboard load.
 */
async function callCapabilityDirect(jarvis: Orchestrator["jarvis"], name: string, intent: string, payload: unknown): Promise<unknown> {
  const rows = await jarvis.registry.list({ enabledOnly: true });
  const row = rows.find((r) => r.name === name);
  if (!row) throw Object.assign(new Error(`capability "${name}" is disabled or not registered`), { code: "NOT_CONNECTED" });

  const credential = row.credentialRef
    ? ((await jarvis.oauthCredentials.getValidToken(row.credentialRef)) ?? jarvis.credentials.get(row.credentialRef))
    : null;
  if (row.credentialRef && !credential) {
    throw Object.assign(new Error(`"${name}" has no valid credential — not connected yet`), { code: "NOT_CONNECTED" });
  }

  const module = await jarvis.registry.loadModule(row);
  return module.handle({ intent, payload }, { credential, attachments: [] });
}

function isNotConnected(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: string }).code === "NOT_CONNECTED";
}

async function fetchUnreadCount(jarvis: Orchestrator["jarvis"], capability: string, intent: string): Promise<InsightTile<{ unreadCount: number; totalCount: number }>> {
  try {
    const result = (await callCapabilityDirect(jarvis, capability, intent, {})) as { unreadCount: number; totalCount: number };
    return { status: "ok", data: result };
  } catch (err) {
    if (isNotConnected(err)) return { status: "not_connected" };
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The Cost Management API groups by resource group (see
 * nzb-azure-insights/index.ts), so this is a total across whatever rows
 * came back, column position resolved by name rather than assumed —
 * Cost Management doesn't guarantee column order.
 */
function sumAzureCostRows(raw: unknown): { total: number; currency: string } {
  const body = raw as { properties?: { columns?: Array<{ name: string }>; rows?: unknown[][] } };
  const columns = body.properties?.columns ?? [];
  const rows = body.properties?.rows ?? [];
  const costIdx = columns.findIndex((c) => c.name === "Cost");
  const currencyIdx = columns.findIndex((c) => c.name === "Currency");
  let total = 0;
  for (const row of rows) {
    const value = costIdx >= 0 ? Number(row[costIdx]) : 0;
    if (Number.isFinite(value)) total += value;
  }
  const currency = currencyIdx >= 0 && rows[0] ? String(rows[0][currencyIdx]) : "";
  return { total, currency };
}

async function fetchAzureCost(jarvis: Orchestrator["jarvis"]): Promise<InsightTile<{ monthToDate: number; lastMonth: number; currency: string }>> {
  try {
    const [mtdRaw, lastMonthRaw] = await Promise.all([
      callCapabilityDirect(jarvis, "nzb-azure-cost-insights", "azure.cost.summary", { timeframe: "MonthToDate" }),
      callCapabilityDirect(jarvis, "nzb-azure-cost-insights", "azure.cost.summary", { timeframe: "TheLastMonth" }),
    ]);
    const mtd = sumAzureCostRows(mtdRaw);
    const lastMonth = sumAzureCostRows(lastMonthRaw);
    return { status: "ok", data: { monthToDate: mtd.total, lastMonth: lastMonth.total, currency: mtd.currency || lastMonth.currency } };
  } catch (err) {
    if (isNotConnected(err)) return { status: "not_connected" };
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

async function fetchNeedsAttention(jarvis: Orchestrator["jarvis"]): Promise<InsightTile<{ pendingProposals: number; pendingScripts: number }>> {
  try {
    const [proposals, runs] = await Promise.all([jarvis.ops.listReviewerProposals("pending"), jarvis.ops.listScriptRuns()]);
    const pendingScripts = runs.filter((r) => r.status === "pending_approval").length;
    return { status: "ok", data: { pendingProposals: proposals.length, pendingScripts } };
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Only ever flags credentials the static JARVIS_CRED_* audit actually
 * covers (see SecurityAccess.auditCredentials) — an OAuth-managed ref
 * that's connected is already reported "valid" there with no expiry to
 * chase, so it never shows up here; one that was never connected shows up
 * as "invalid" the same as a missing static credential would.
 */
async function fetchCredentialHealth(
  jarvis: Orchestrator["jarvis"],
): Promise<InsightTile<{ totalTracked: number; atRisk: Array<{ credentialRef: string; status: string; daysRemaining: number | null }> }>> {
  try {
    const { statuses } = await jarvis.security.auditCredentials();
    const now = Date.now();
    const atRisk = statuses
      .filter((s) => s.status !== "valid")
      .map((s) => ({
        credentialRef: s.credentialRef,
        status: s.status,
        daysRemaining: s.expiresAt ? Math.floor((Date.parse(s.expiresAt) - now) / 86_400_000) : null,
      }));
    return { status: "ok", data: { totalTracked: statuses.length, atRisk } };
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

/** Counts, not the full list — the sidebar just needs "how healthy has self-heal been lately," not a log viewer. */
async function fetchScriptRunHistory(
  jarvis: Orchestrator["jarvis"],
): Promise<InsightTile<{ applied: number; failed: number; pending: number; rejected: number }>> {
  try {
    const runs = await jarvis.ops.listScriptRuns(20);
    const counts = { applied: 0, failed: 0, pending: 0, rejected: 0 };
    for (const run of runs) {
      if (run.status === "applied") counts.applied++;
      else if (run.status === "failed") counts.failed++;
      else if (run.status === "pending_approval") counts.pending++;
      else if (run.status === "rejected") counts.rejected++;
    }
    return { status: "ok", data: counts };
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Minimal RFC4180-ish CSV parser — Graph's usage-report CSVs quote any
 * field that itself contains a comma (display names, mainly), so a naive
 * split(",") would misalign columns on exactly the rows worth reading.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell !== "")) rows.push(row);
  }
  return rows;
}

/**
 * "Inactive" here means Graph's own getMailboxUsageDetail already reported
 * no activity in the requested period (D30) — a blank Last Activity Date
 * for a non-deleted mailbox, not something computed from timestamps here.
 * Flags cleanup candidates only; never touches licenses or mailboxes
 * itself (see nzb-usage-report/manifest.ts).
 */
async function fetchUsageWaste(jarvis: Orchestrator["jarvis"]): Promise<InsightTile<{ inactiveMailboxes: number; totalMailboxes: number }>> {
  try {
    const raw = (await callCapabilityDirect(jarvis, "nzb-m365-usage-report", "m365.usage.report", {
      report: "getMailboxUsageDetail",
      period: "D30",
    })) as { data: string };
    const rows = parseCsv(raw.data);
    const header = rows[0] ?? [];
    const deletedIdx = header.indexOf("Is Deleted");
    const lastActivityIdx = header.indexOf("Last Activity Date");
    let total = 0;
    let inactive = 0;
    for (const row of rows.slice(1)) {
      if (deletedIdx >= 0 && row[deletedIdx]?.toLowerCase() === "true") continue;
      total++;
      if (lastActivityIdx < 0 || !row[lastActivityIdx]) inactive++;
    }
    return { status: "ok", data: { inactiveMailboxes: inactive, totalMailboxes: total } };
  } catch (err) {
    if (isNotConnected(err)) return { status: "not_connected" };
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

function parseAttachments(body: unknown): ChatAttachment[] | "invalid" {
  if (body === undefined) return [];
  if (!Array.isArray(body)) return "invalid";
  const attachments: ChatAttachment[] = [];
  for (const item of body) {
    if (typeof item?.mediaType !== "string" || typeof item?.base64Data !== "string") return "invalid";
    attachments.push({
      mediaType: item.mediaType,
      base64Data: item.base64Data,
      filename: typeof item.filename === "string" ? item.filename : undefined,
    });
  }
  return attachments;
}
