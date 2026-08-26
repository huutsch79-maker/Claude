import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { createDashboardServer } from "../src/orchestrator/dashboard.js";

describe("dashboard server", () => {
  const TOKEN = "test-token";
  let baseUrl: string;
  let orchestrator: Orchestrator;
  let server: ReturnType<typeof createDashboardServer>;

  beforeAll(async () => {
    process.env.JARVIS_DASHBOARD_TOKEN = TOKEN;
    // pg.Pool connects lazily, so constructing these doesn't require a live DB —
    // safe as long as this test only hits routes that never issue a query
    // (health/scripts are in-memory or static).
    orchestrator = new Orchestrator();
    server = createDashboardServer(orchestrator);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    server.close();
    await orchestrator.shutdown();
    delete process.env.JARVIS_DASHBOARD_TOKEN;
  });

  it("rejects unauthenticated API requests", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(401);
  });

  it("rejects the wrong token", async () => {
    const res = await fetch(`${baseUrl}/api/health`, { headers: { authorization: "Bearer wrong" } });
    expect(res.status).toBe(401);
  });

  it("accepts the correct token", async () => {
    const res = await fetch(`${baseUrl}/api/health`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeNull(); // no health cycle has run yet in this test
  });

  it("lists the fixed script registry", async () => {
    const res = await fetch(`${baseUrl}/api/scripts`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const scripts = (await res.json()) as Array<{ name: string }>;
    expect(scripts.map((s) => s.name).sort()).toEqual([
      "apply-migration",
      "apply-website-file",
      "redeploy-jarvis",
      "vacuum-analyze",
    ]);
  });

  it("rejects an unconfigured chat request with 503, not a crash", async () => {
    // ANTHROPIC_API_KEY is unset in the test env, so jarvis.chat is null
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", message: "hi" }),
    });
    expect(res.status).toBe(503);
  });

  it("rejects a malformed attachments payload with 400", async () => {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", message: "hi", attachments: [{ oops: true }] }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a poll for an unconfigured chat with 503", async () => {
    const res = await fetch(`${baseUrl}/api/chat/s1/poll`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(503);
  });

  it("reaches /api/oauth/callback without a bearer token (Microsoft's redirect can't carry one)", async () => {
    const res = await fetch(`${baseUrl}/api/oauth/callback`);
    expect(res.status).not.toBe(401); // 400 (missing code/state) is fine — the point is it's not rejected by auth
  });

  it("still requires auth for the authorize-url route (fetched via authenticated JS, not a raw redirect)", async () => {
    const res = await fetch(`${baseUrl}/api/oauth/hotmail-oauth/authorize-url`);
    expect(res.status).toBe(401);
  });

  it("serves the static dashboard page", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("JARVIS");
  });

  it("a failing script approval returns 500 instead of crashing the process", async () => {
    // Regression: this exact shape of failure (a requires_approval script's
    // run() rejecting — e.g. redeploy-jarvis when deploy-agent is
    // unreachable) took down the whole orchestrator in production, because
    // executeAndRecord() deliberately re-throws after recording the
    // failure, and this route awaited that without its own try/catch —
    // an unhandled rejection in an async Express handler, which Node
    // terminates the process on by default.
    orchestrator.jarvis.selfHeal.approveScript = (async () => {
      throw new Error("deploy-agent unreachable");
    }) as typeof orchestrator.jarvis.selfHeal.approveScript;

    const res = await fetch(`${baseUrl}/api/scripts/some-id/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("deploy-agent unreachable");

    // The server must still be alive and answering after that failure.
    const health = await fetch(`${baseUrl}/api/health`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(health.status).toBe(200);
  });

  // Same regression class as above, found by accident while testing the
  // dashboard's frontend rewrite against a real orchestrator with no
  // database reachable: every DB-backed route here awaited a rejected
  // promise with no try/catch of its own, so a plain DB outage (not even
  // a bug — just Postgres being briefly unreachable) crashed the whole
  // process. One test per route, each confirming a 500 (not a crash) and
  // that the server is still answering afterward.
  it("a failing GET /api/proposals returns 500 instead of crashing the process", async () => {
    orchestrator.jarvis.ops.listReviewerProposals = (async () => {
      throw new Error("db unreachable");
    }) as typeof orchestrator.jarvis.ops.listReviewerProposals;

    const res = await fetch(`${baseUrl}/api/proposals`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("db unreachable");

    const health = await fetch(`${baseUrl}/api/health`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(health.status).toBe(200);
  });

  it("a failing proposal approve/reject returns 500 instead of crashing the process", async () => {
    orchestrator.jarvis.ops.setReviewerProposalStatus = (async () => {
      throw new Error("db unreachable");
    }) as typeof orchestrator.jarvis.ops.setReviewerProposalStatus;

    for (const action of ["approve", "reject"] as const) {
      const res = await fetch(`${baseUrl}/api/proposals/some-id/${action}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: string }).error).toContain("db unreachable");
    }

    const health = await fetch(`${baseUrl}/api/health`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(health.status).toBe(200);
  });

  it("a failing GET /api/script-runs returns 500 instead of crashing the process", async () => {
    orchestrator.jarvis.ops.listScriptRuns = (async () => {
      throw new Error("db unreachable");
    }) as typeof orchestrator.jarvis.ops.listScriptRuns;

    const res = await fetch(`${baseUrl}/api/script-runs`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("db unreachable");

    const health = await fetch(`${baseUrl}/api/health`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(health.status).toBe(200);
  });

  it("a failing GET /api/capabilities returns 500 instead of crashing the process", async () => {
    orchestrator.jarvis.registry.list = (async () => {
      throw new Error("db unreachable");
    }) as typeof orchestrator.jarvis.registry.list;

    const res = await fetch(`${baseUrl}/api/capabilities`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("db unreachable");

    const health = await fetch(`${baseUrl}/api/health`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(health.status).toBe(200);
  });

  it("a failing capability enable/disable returns 500 instead of crashing the process", async () => {
    orchestrator.jarvis.registry.setEnabled = (async () => {
      throw new Error("db unreachable");
    }) as typeof orchestrator.jarvis.registry.setEnabled;

    const res = await fetch(`${baseUrl}/api/capabilities/farm-website/enabled`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("db unreachable");

    const health = await fetch(`${baseUrl}/api/health`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(health.status).toBe(200);
  });
});
