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

  app.get("/api/proposals", async (req, res) => {
    const status = req.query.status as "pending" | "approved" | "rejected" | "applied" | undefined;
    res.json(await jarvis.ops.listReviewerProposals(status));
  });

  app.post("/api/proposals/:id/approve", async (req, res) => {
    const ok = await jarvis.ops.setReviewerProposalStatus(req.params.id!, "approved");
    res.status(ok ? 200 : 404).json({ ok });
  });

  app.post("/api/proposals/:id/reject", async (req, res) => {
    const ok = await jarvis.ops.setReviewerProposalStatus(req.params.id!, "rejected");
    res.status(ok ? 200 : 404).json({ ok });
  });

  app.get("/api/script-runs", async (_req, res) => {
    res.json(await jarvis.ops.listScriptRuns());
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
  });

  app.post("/api/capabilities/:name/enabled", async (req, res) => {
    const enabled = Boolean(req.body?.enabled);
    await jarvis.registry.setEnabled(req.params.name!, enabled);
    res.json({ ok: true });
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

  app.post("/api/chat", async (req, res) => {
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
    try {
      const result = await jarvis.chat.converse(sessionId, message, attachments);
      res.json(result);
    } catch (err) {
      console.error("[chat] /api/chat failed:", err);
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return createServer(app);
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
