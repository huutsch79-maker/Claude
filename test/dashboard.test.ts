import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import type { DomainId } from "../src/config/domains.js";
import type { OperationalMetadata } from "../src/orchestrator/operationalMetadata.js";
import type { ApprovalRequest } from "../src/core/approvalGate.js";
import { assertDashboardPayloadShape, type DashboardSource, type DashboardStatePayload } from "../src/dashboard/types.js";
import { buildDashboardState } from "../src/dashboard/readModel.js";
import { createDashboardServer } from "../src/dashboard/server.js";

function validMetadata(domain: DomainId): OperationalMetadata {
  return {
    domain,
    reportedAt: new Date().toISOString(),
    moduleHealth: [{ moduleId: "m1", status: "healthy", lastRestartAt: null, restartCount24h: 0 }],
    credentialStatus: [{ credentialRef: "ref1", status: "valid", expiresAt: null }],
    errorCounts: { transient24h: 0, fatal24h: 0 },
  };
}

function makeFakeSource(opts: {
  domains?: { id: DomainId; label: string }[];
  metadata?: Map<DomainId, OperationalMetadata>;
  pending?: Map<DomainId, Map<string, ApprovalRequest>>;
  snapshotImpl?: () => ReadonlyMap<DomainId, OperationalMetadata>;
} = {}): DashboardSource {
  const domains = opts.domains ?? [
    { id: "work" as DomainId, label: "NZB (work)" },
    { id: "personal" as DomainId, label: "Personal" },
  ];
  const metadata = opts.metadata ?? new Map<DomainId, OperationalMetadata>();
  const pending = opts.pending ?? new Map<DomainId, Map<string, ApprovalRequest>>();
  return {
    listDomains: () => domains,
    snapshot: opts.snapshotImpl ?? (() => metadata),
    listPending: (domainId: DomainId) => pending.get(domainId) ?? new Map(),
  };
}

describe("dashboard payload shape", () => {
  it("accepts a well-formed payload built from a real read model", () => {
    const metadata = new Map<DomainId, OperationalMetadata>([
      ["work", validMetadata("work")],
      ["personal", validMetadata("personal")],
    ]);
    const source = makeFakeSource({ metadata });
    const payload = buildDashboardState(source, { healthIntervalMs: 5 * 60 * 1000 });
    expect(() => assertDashboardPayloadShape(payload)).not.toThrow();
  });

  it("rejects a deliberately-poisoned payload with an extra top-level key", () => {
    const metadata = new Map<DomainId, OperationalMetadata>([["work", validMetadata("work")]]);
    const source = makeFakeSource({ domains: [{ id: "work", label: "NZB (work)" }], metadata });
    const payload = buildDashboardState(source, { healthIntervalMs: 5 * 60 * 1000 });
    const bad = { ...payload, lastUserMessage: "some content leaking across" };
    expect(() => assertDashboardPayloadShape(bad)).toThrow(/disallowed field/);
  });

  it("rejects a poisoned domain entry (extra field one level down)", () => {
    const metadata = new Map<DomainId, OperationalMetadata>([["work", validMetadata("work")]]);
    const source = makeFakeSource({ domains: [{ id: "work", label: "NZB (work)" }], metadata });
    const payload = buildDashboardState(source, { healthIntervalMs: 5 * 60 * 1000 });
    const bad: unknown = {
      domains: [{ ...payload.domains[0], debugContext: "conversation excerpt" }],
    };
    expect(() => assertDashboardPayloadShape(bad)).toThrow(/disallowed field/);
  });

  it("rejects a poisoned moduleHealth entry (nested two levels down)", () => {
    const metadata = new Map<DomainId, OperationalMetadata>([["work", validMetadata("work")]]);
    const source = makeFakeSource({ domains: [{ id: "work", label: "NZB (work)" }], metadata });
    const payload = buildDashboardState(source, { healthIntervalMs: 5 * 60 * 1000 });
    const poisonedModule = { ...payload.domains[0]!.moduleHealth[0], secretValue: "sk-abc123" };
    const bad: unknown = {
      domains: [{ ...payload.domains[0], moduleHealth: [poisonedModule] }],
    };
    expect(() => assertDashboardPayloadShape(bad)).toThrow(/disallowed field/);
  });

  it("serialized payload's key set is exactly the whitelist at every nesting level", () => {
    const pending = new Map<DomainId, Map<string, ApprovalRequest>>([
      ["work", new Map([["a1", { domain: "work", summary: "restart foo", kind: "module_add", proposedAt: new Date().toISOString() }]])],
    ]);
    const metadata = new Map<DomainId, OperationalMetadata>([["work", validMetadata("work")]]);
    const source = makeFakeSource({ domains: [{ id: "work", label: "NZB (work)" }], metadata, pending });
    const payload = buildDashboardState(source, { healthIntervalMs: 5 * 60 * 1000 });

    // Round-trip through JSON, exactly as the HTTP layer would serialize it.
    const round: DashboardStatePayload = JSON.parse(JSON.stringify(payload));
    expect(() => assertDashboardPayloadShape(round)).not.toThrow();

    expect(Object.keys(round).sort()).toEqual(["domains"]);

    const domainEntry = round.domains[0]!;
    expect(Object.keys(domainEntry).sort()).toEqual(
      ["approvals", "credentialStatus", "domain", "errorCounts", "moduleHealth", "reportedAt", "ageMs", "stale", "awaitingFirstReport"].sort(),
    );
    expect(Object.keys(domainEntry.moduleHealth[0]!).sort()).toEqual(
      ["moduleId", "status", "lastRestartAt", "restartCount24h"].sort(),
    );
    expect(Object.keys(domainEntry.credentialStatus[0]!).sort()).toEqual(
      ["credentialRef", "status", "expiresAt"].sort(),
    );
    expect(Object.keys(domainEntry.errorCounts).sort()).toEqual(["transient24h", "fatal24h"].sort());
    expect(Object.keys(domainEntry.approvals[0]!).sort()).toEqual(["id", "kind", "summary", "proposedAt"].sort());
  });
});

describe("dashboard read model", () => {
  it("keeps work and personal as separate entries, never merged", () => {
    const metadata = new Map<DomainId, OperationalMetadata>([
      ["work", validMetadata("work")],
      ["personal", validMetadata("personal")],
    ]);
    const source = makeFakeSource({ metadata });
    const payload = buildDashboardState(source, { healthIntervalMs: 5 * 60 * 1000 });

    expect(payload.domains).toHaveLength(2);
    const work = payload.domains.find((d) => d.domain === "work");
    const personal = payload.domains.find((d) => d.domain === "personal");
    expect(work).toBeDefined();
    expect(personal).toBeDefined();
    expect(work).not.toBe(personal);
    expect(work!.domain).toBe("work");
    expect(personal!.domain).toBe("personal");
  });

  it("produces a clean awaiting-first-report shape for a domain with no snapshot yet", () => {
    const source = makeFakeSource({ metadata: new Map() });
    const payload = buildDashboardState(source, { healthIntervalMs: 5 * 60 * 1000 });
    for (const d of payload.domains) {
      expect(d.reportedAt).toBeNull();
      expect(d.ageMs).toBeNull();
      expect(d.stale).toBe(true);
      expect(d.awaitingFirstReport).toBe(true);
      expect(d.moduleHealth).toEqual([]);
      expect(d.credentialStatus).toEqual([]);
      expect(d.errorCounts).toEqual({ transient24h: 0, fatal24h: 0 });
      expect(d.approvals).toEqual([]);
    }
    expect(() => assertDashboardPayloadShape(payload)).not.toThrow();
  });

  it("marks a domain stale once its report is older than 2x the health interval", () => {
    const staleMetadata = validMetadata("work");
    staleMetadata.reportedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20 min ago
    const source = makeFakeSource({
      domains: [{ id: "work", label: "NZB (work)" }],
      metadata: new Map([["work", staleMetadata]]),
    });
    const payload = buildDashboardState(source, { healthIntervalMs: 5 * 60 * 1000 }); // stale threshold: 10 min
    expect(payload.domains[0]!.stale).toBe(true);
    expect(payload.domains[0]!.awaitingFirstReport).toBe(false);
  });

  it("sorts credential status worst-first: expired > invalid > expiring_soon > valid", () => {
    const metadata = validMetadata("work");
    metadata.credentialStatus = [
      { credentialRef: "c-valid", status: "valid", expiresAt: null },
      { credentialRef: "c-expired", status: "expired", expiresAt: null },
      { credentialRef: "c-expiring", status: "expiring_soon", expiresAt: null },
      { credentialRef: "c-invalid", status: "invalid", expiresAt: null },
    ];
    const source = makeFakeSource({
      domains: [{ id: "work", label: "NZB (work)" }],
      metadata: new Map([["work", metadata]]),
    });
    const payload = buildDashboardState(source, { healthIntervalMs: 5 * 60 * 1000 });
    expect(payload.domains[0]!.credentialStatus.map((c) => c.status)).toEqual([
      "expired",
      "invalid",
      "expiring_soon",
      "valid",
    ]);
  });
});

describe("dashboard structural isolation (static analysis)", () => {
  const forbidden = [
    "Domain.js",
    "memoryStore.js",
    "relationsStore.js",
    "credentialStore.js",
    "capabilityRegistry.js",
    'from "pg"',
    'require("pg")',
  ];

  const dashboardDir = path.resolve(__dirname, "../src/dashboard");
  const files = fs.readdirSync(dashboardDir).filter((f) => f.endsWith(".ts"));

  it("finds the expected dashboard source files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} never imports a domain-internal store or pg`, () => {
      const contents = fs.readFileSync(path.join(dashboardDir, file), "utf8");
      for (const needle of forbidden) {
        expect(contents.includes(needle), `${file} must not contain "${needle}"`).toBe(false);
      }
    });
  }
});

describe("dashboard HTTP server", () => {
  async function withServer<T>(
    source: DashboardSource,
    fn: (baseUrl: string) => Promise<T>,
  ): Promise<T> {
    const server = createDashboardServer(source, { healthIntervalMs: 5 * 60 * 1000 });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      return await fn(baseUrl);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  }

  it("GET /api/state returns 200 with both domains and nothing else", async () => {
    const metadata = new Map<DomainId, OperationalMetadata>([
      ["work", validMetadata("work")],
      ["personal", validMetadata("personal")],
    ]);
    const source = makeFakeSource({ metadata });
    await withServer(source, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/state`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = (await res.json()) as DashboardStatePayload;
      expect(() => assertDashboardPayloadShape(body)).not.toThrow();
      expect(body.domains.map((d) => d.domain).sort()).toEqual(["personal", "work"]);
    });
  });

  it("GET /api/healthz returns { ok: true }", async () => {
    const source = makeFakeSource();
    await withServer(source, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/healthz`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });
  });

  it("GET / returns the dashboard HTML with both domain labels and the poll script", async () => {
    const source = makeFakeSource();
    await withServer(source, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const body = await res.text();
      expect(body).toContain("<!doctype html>");
      expect(body).toContain("work");
      expect(body).toContain("personal");
      expect(body).toContain("/api/state");
      expect(body).toContain("setInterval");
    });
  });

  it("unknown path returns 404 JSON", async () => {
    const source = makeFakeSource();
    await withServer(source, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/nope`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not found" });
    });
  });

  it("wrong method on a known path returns 405", async () => {
    const source = makeFakeSource();
    await withServer(source, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/state`, { method: "PUT" });
      expect(res.status).toBe(405);
    });
  });

  it("POST without the X-Jarvis-Dashboard header returns 403, on any path", async () => {
    const source = makeFakeSource();
    await withServer(source, async (baseUrl) => {
      const res1 = await fetch(`${baseUrl}/api/state`, { method: "POST" });
      expect(res1.status).toBe(403);
      const res2 = await fetch(`${baseUrl}/anything`, { method: "POST" });
      expect(res2.status).toBe(403);
    });
  });

  it("a source whose snapshot() throws returns 500, not a crash", async () => {
    const source = makeFakeSource({
      snapshotImpl: () => {
        throw new Error("db is down");
      },
    });
    await withServer(source, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/state`);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "internal error" });
    });
  });
});
