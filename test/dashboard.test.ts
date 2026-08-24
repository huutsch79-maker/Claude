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
    expect(scripts.map((s) => s.name).sort()).toEqual(["apply-migration", "vacuum-analyze"]);
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

  it("serves the static dashboard page", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("JARVIS");
  });
});
