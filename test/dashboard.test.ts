import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { DomainManager } from "../src/orchestrator/domainManager.js";
import { createDashboardServer } from "../src/orchestrator/dashboard.js";

describe("dashboard server", () => {
  const TOKEN = "test-token";
  let baseUrl: string;
  let manager: DomainManager;
  let server: ReturnType<typeof createDashboardServer>;

  beforeAll(async () => {
    process.env.JARVIS_DASHBOARD_TOKEN = TOKEN;
    // pg.Pool connects lazily, so constructing these doesn't require a live DB —
    // safe as long as this test only hits routes that never issue a query
    // (health/scripts are in-memory or static; the domain-validation 404
    // happens before any handler that would query).
    manager = new DomainManager();
    server = createDashboardServer(manager);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    server.close();
    await manager.shutdown();
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
    expect(body).toEqual({});
  });

  it("lists the fixed script registry, unauthenticated routes excluded", async () => {
    const res = await fetch(`${baseUrl}/api/scripts`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const scripts = (await res.json()) as Array<{ name: string }>;
    expect(scripts.map((s) => s.name).sort()).toEqual(["apply-migration", "vacuum-analyze"]);
  });

  it("rejects an unknown domain before touching the database", async () => {
    const res = await fetch(`${baseUrl}/api/domains/bogus/capabilities`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  it("serves the static dashboard page", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("JARVIS v2");
  });
});
