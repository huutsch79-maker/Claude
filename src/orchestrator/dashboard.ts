import { createServer, type Server } from "node:http";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { isDomainId } from "../config/domains.js";
import { listScripts } from "../core/scriptRegistry.js";
import type { DomainManager } from "./domainManager.js";

/**
 * Ops dashboard: read-only visibility into operational metadata (health,
 * pending reviewer proposals, script run history, capability registry
 * listing) plus the approve/reject/run actions that were previously only
 * reachable by editing the database or waiting for Pushover. This is core
 * layer code — every route below reads only from OperationalBus, the
 * shared `core` tables, or capability *metadata* (name/enabled/priority/
 * credential ref — never a credential value, never memory or relations
 * content). If a future route ever needs to touch `.memory` or
 * `.relations`, that's a domain-boundary violation and shouldn't ship.
 */
export function createDashboardServer(domainManager: DomainManager): Server {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(process.cwd(), "public")));

  const token = process.env.JARVIS_DASHBOARD_TOKEN;
  if (!token) {
    console.warn(
      "[dashboard] JARVIS_DASHBOARD_TOKEN is not set — the dashboard API is running WITHOUT auth. " +
        "Fine for localhost-only access during development; set this before exposing the dashboard beyond 127.0.0.1.",
    );
  }

  app.use("/api", (req: Request, res: Response, next: NextFunction) => {
    if (!token) return next(); // dev mode, see warning above
    const header = req.header("authorization");
    if (header === `Bearer ${token}`) return next();
    res.status(401).json({ error: "unauthorized" });
  });

  const domainParam = (req: Request, res: Response, next: NextFunction) => {
    if (!isDomainId(req.params.domain ?? "")) {
      res.status(404).json({ error: `unknown domain "${req.params.domain}"` });
      return;
    }
    next();
  };

  app.get("/api/health", (_req, res) => {
    const snapshot = domainManager.bus.snapshot();
    res.json(Object.fromEntries(snapshot));
  });

  app.get("/api/scripts", (_req, res) => {
    res.json(listScripts().map((s) => ({ name: s.name, description: s.description, trustTier: s.trustTier })));
  });

  app.get("/api/domains/:domain/proposals", domainParam, async (req, res) => {
    const domain = domainManager.get(req.params.domain as never);
    const status = req.query.status as "pending" | "approved" | "rejected" | "applied" | undefined;
    res.json(await domain.ops.listReviewerProposals(status));
  });

  app.post("/api/domains/:domain/proposals/:id/approve", domainParam, async (req, res) => {
    const domain = domainManager.get(req.params.domain as never);
    const ok = await domain.ops.setReviewerProposalStatus(req.params.id!, "approved");
    res.status(ok ? 200 : 404).json({ ok });
  });

  app.post("/api/domains/:domain/proposals/:id/reject", domainParam, async (req, res) => {
    const domain = domainManager.get(req.params.domain as never);
    const ok = await domain.ops.setReviewerProposalStatus(req.params.id!, "rejected");
    res.status(ok ? 200 : 404).json({ ok });
  });

  app.get("/api/domains/:domain/script-runs", domainParam, async (req, res) => {
    const domain = domainManager.get(req.params.domain as never);
    res.json(await domain.ops.listScriptRuns());
  });

  app.post("/api/domains/:domain/scripts/:name/run", domainParam, async (req, res) => {
    const domain = domainManager.get(req.params.domain as never);
    const args = (req.body?.args ?? {}) as Record<string, string>;
    try {
      const result = await domain.selfHeal.runScript(req.params.name!, args);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/domains/:domain/scripts/:id/approve", domainParam, async (req, res) => {
    const domain = domainManager.get(req.params.domain as never);
    const ok = await domain.selfHeal.approveScript(req.params.id!);
    res.status(ok ? 200 : 404).json({ ok });
  });

  app.post("/api/domains/:domain/scripts/:id/reject", domainParam, async (req, res) => {
    const domain = domainManager.get(req.params.domain as never);
    const ok = await domain.selfHeal.rejectScript(req.params.id!);
    res.status(ok ? 200 : 404).json({ ok });
  });

  app.get("/api/domains/:domain/capabilities", domainParam, async (req, res) => {
    const domain = domainManager.get(req.params.domain as never);
    const rows = await domain.registry.list();
    res.json(
      rows.map((r) => ({
        name: r.name,
        enabled: r.enabled,
        priority: r.priority,
        credentialRef: r.credentialRef,
        modelOverride: r.modelOverride,
      })),
    );
  });

  app.post("/api/domains/:domain/capabilities/:name/enabled", domainParam, async (req, res) => {
    const domain = domainManager.get(req.params.domain as never);
    const enabled = Boolean(req.body?.enabled);
    await domain.registry.setEnabled(req.params.name!, enabled);
    res.json({ ok: true });
  });

  app.post("/api/domains/:domain/chat", domainParam, async (req, res) => {
    const domain = domainManager.get(req.params.domain as never);
    if (!domain.chat) {
      res.status(503).json({ error: "chat is not configured for this instance (ANTHROPIC_API_KEY unset)" });
      return;
    }
    const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId : null;
    const message = typeof req.body?.message === "string" ? req.body.message : null;
    if (!sessionId || !message) {
      res.status(400).json({ error: "sessionId and message are required strings" });
      return;
    }
    try {
      const result = await domain.chat.converse(sessionId, message);
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return createServer(app);
}
