import { describe, expect, it, vi } from "vitest";
import { DOMAINS } from "../src/config/domains.js";
import { SecurityAccess } from "../src/core/security.js";
import { Reviewer, type ErrorLogCounts } from "../src/core/reviewer.js";
import { SelfHeal } from "../src/core/selfHeal.js";
import { ApprovalGate, PushoverApprovalNotifier, type ApprovalNotifier } from "../src/core/approvalGate.js";
import { CapabilityRegistry as RegistryCtor } from "../src/domain/capabilityRegistry.js";
import type { CapabilityRegistry, CapabilityRow } from "../src/domain/capabilityRegistry.js";
import type { CredentialStore } from "../src/domain/credentialStore.js";
import type { MemoryStore } from "../src/domain/memoryStore.js";
import type { CredentialStatusSummary } from "../src/orchestrator/operationalMetadata.js";

/**
 * These four files had no executable coverage at all, which is why an empty
 * capability registry could report perfect health for four days in
 * production. Every test here pins a case where "we did not measure" must
 * not be returned as "we measured and found nothing wrong".
 */

const WORK = DOMAINS.work;

function capability(overrides: Partial<CapabilityRow> = {}): CapabilityRow {
  return {
    id: "cap-1",
    name: "nzb-connector",
    enabled: true,
    priority: 100,
    schemaDef: {},
    systemPrompt: null,
    toolConfig: {},
    modelOverride: null,
    credentialRef: "nzb-oauth",
    modulePath: "./x.js",
    ...overrides,
  } as CapabilityRow;
}

function fakeRegistry(rows: CapabilityRow[]): CapabilityRegistry {
  return { list: async () => rows } as unknown as CapabilityRegistry;
}

function fakeCredentials(statuses: CredentialStatusSummary[]): CredentialStore {
  return {
    auditStatuses: (refs: string[]) => statuses.filter((s) => refs.includes(s.credentialRef)),
  } as unknown as CredentialStore;
}

/** Records every statement so a test can assert the transaction actually wrapped the insert. */
function fakePool(statements: string[] = []) {
  const client = {
    query: vi.fn(async (sql: string) => {
      statements.push(sql.trim().split(/\s+/).slice(0, 2).join(" ").toLowerCase());
      if (sql.startsWith("insert")) return { rows: [{ id: "row-1" }, { id: "row-2" }, { id: "row-3" }, { id: "row-4" }] };
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return { pool: { connect: async () => client } as never, client, statements };
}

function reviewerWith(rows: CapabilityRow[], statuses: CredentialStatusSummary[] = [], memoryCount = 5) {
  const registry = fakeRegistry(rows);
  const security = new SecurityAccess(WORK, fakeCredentials(statuses), registry);
  const memory = { countSince: async () => memoryCount } as unknown as MemoryStore;
  const { pool, statements } = fakePool();
  return { reviewer: new Reviewer(WORK, pool, registry, memory, security), statements };
}

const MEASURED: ErrorLogCounts = { measured: true, transient24h: 0, fatal24h: 0 };

describe("SecurityAccess — an empty audit says how much it audited", () => {
  it("an empty registry reports the counts, not just an empty array", async () => {
    const audit = await new SecurityAccess(WORK, fakeCredentials([]), fakeRegistry([])).auditCredentials();
    expect(audit.capabilityCount).toBe(0);
    expect(audit.auditedRefCount).toBe(0);
    expect(audit.statuses).toEqual([]);
  });

  it("a caller can tell 'audited two, all valid' from 'audited nothing'", async () => {
    const populated = await new SecurityAccess(
      WORK,
      fakeCredentials([
        { credentialRef: "a", status: "valid", expiresAt: null },
        { credentialRef: "b", status: "valid", expiresAt: null },
      ]),
      fakeRegistry([capability({ credentialRef: "a" }), capability({ id: "c2", name: "n2", credentialRef: "b" })]),
    ).auditCredentials();
    const empty = await new SecurityAccess(WORK, fakeCredentials([]), fakeRegistry([])).auditCredentials();

    // Both have zero findings. Only auditedRefCount separates them.
    expect(populated.findings).toEqual([]);
    expect(empty.findings).toEqual([]);
    expect(populated.auditedRefCount).toBe(2);
    expect(empty.auditedRefCount).toBe(0);
  });

  it("capabilities that reference no credential are visible as a zero ref count", async () => {
    const audit = await new SecurityAccess(
      WORK,
      fakeCredentials([]),
      fakeRegistry([capability({ credentialRef: null }), capability({ id: "c2", credentialRef: null })]),
    ).auditCredentials();
    expect(audit.capabilityCount).toBe(2);
    expect(audit.auditedRefCount).toBe(0);
  });
});

describe("Reviewer — the empty-registry watchdog actually fires", () => {
  it("an empty registry raises a proposal (the four-day production bug)", async () => {
    const { reviewer } = reviewerWith([]);
    const proposals = await reviewer.runCycle(MEASURED);
    const registryProposal = proposals.find((p) => p.summary.includes("registry is empty"));
    expect(registryProposal).toBeDefined();
    expect(registryProposal!.trustTier).toBe("requires_approval");
  });

  it("all-disabled still raises its own, distinct proposal", async () => {
    const { reviewer } = reviewerWith([capability({ enabled: false })]);
    const proposals = await reviewer.runCycle(MEASURED);
    expect(proposals.some((p) => p.summary.includes("are disabled"))).toBe(true);
    expect(proposals.some((p) => p.summary.includes("registry is empty"))).toBe(false);
  });

  it("capabilities present but no credential referenced raises a proposal — the schema-drift case", async () => {
    const { reviewer } = reviewerWith([capability({ credentialRef: null })]);
    const proposals = await reviewer.runCycle(MEASURED);
    expect(proposals.some((p) => p.summary.includes("none references a credential"))).toBe(true);
  });

  it("an unmeasured error log raises a proposal instead of comparing a constant to a threshold", async () => {
    const { reviewer } = reviewerWith([capability()], [{ credentialRef: "nzb-oauth", status: "valid", expiresAt: null }]);
    const proposals = await reviewer.runCycle({ measured: false, transient24h: 0, fatal24h: 0 });
    expect(proposals.some((p) => p.category === "error_log" && p.summary.includes("not being measured"))).toBe(true);
  });

  it("a healthy domain with everything measured produces no proposals at all", async () => {
    const { reviewer } = reviewerWith([capability()], [{ credentialRef: "nzb-oauth", status: "valid", expiresAt: null }]);
    expect(await reviewer.runCycle(MEASURED)).toEqual([]);
  });

  it("every credential finding kind reaches a proposal — including the one that used to be dropped", async () => {
    const { reviewer } = reviewerWith(
      [capability({ enabled: false, credentialRef: "unused-ref" })],
      [{ credentialRef: "unused-ref", status: "valid", expiresAt: null }],
    );
    const proposals = await reviewer.runCycle(MEASURED);
    // unused_by_any_enabled_capability was computed by the auditor and
    // matched by none of the reviewer's branches before this fix.
    expect(proposals.some((p) => p.summary.includes("referenced only by disabled capabilities"))).toBe(true);
  });

  it("persists the whole cycle in one transaction and back-fills the generated ids", async () => {
    const { reviewer, statements } = reviewerWith([]);
    const proposals = await reviewer.runCycle({ measured: false, transient24h: 0, fatal24h: 0 });
    expect(proposals.length).toBeGreaterThan(1);
    expect(statements[0]).toBe("begin");
    expect(statements).toContain("commit");
    // exactly one insert for the whole cycle, not one per proposal
    expect(statements.filter((s) => s.startsWith("insert")).length).toBe(1);
    for (const p of proposals) expect(p.id).toBeTruthy();
  });
});

describe("SelfHeal.applyApproved — the approval survives a failing apply", () => {
  function harness() {
    const notifier: ApprovalNotifier = { notify: async () => {} };
    const gate = new ApprovalGate(notifier);
    const selfHeal = new SelfHeal(
      WORK,
      gate,
      { restartModule: async () => {}, clearCache: async () => {}, cleanupDuplicateMemory: async () => 0 },
    );
    return { gate, selfHeal };
  }

  it("a throwing apply leaves the approval pending instead of consuming it", async () => {
    const { gate, selfHeal } = harness();
    await gate.propose("p1", { domain: "work", summary: "restart", kind: "module_crash_restart" });

    const result = await selfHeal.applyApproved("p1", "module_crash_restart", async () => {
      throw new Error("restart failed");
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: "apply_failed" });
    // The whole point: still recoverable, still visible on the dashboard.
    expect(gate.peek("p1")).not.toBeNull();
  });

  it("a successful apply consumes the approval exactly once", async () => {
    const { gate, selfHeal } = harness();
    await gate.propose("p1", { domain: "work", summary: "restart", kind: "module_crash_restart" });
    const applied = await selfHeal.applyApproved("p1", "module_crash_restart", async () => {});
    expect(applied).toEqual({ ok: true });
    expect(gate.peek("p1")).toBeNull();
  });

  it("refuses to apply an action the human did not approve", async () => {
    const { gate, selfHeal } = harness();
    await gate.propose("p1", { domain: "work", summary: "restart a module", kind: "module_crash_restart" });
    const ran = vi.fn(async () => {});

    const result = await selfHeal.applyApproved("p1", "stale_cache_clear", ran);

    expect(result).toEqual({ ok: false, reason: "wrong_kind" });
    expect(ran).not.toHaveBeenCalled();
    expect(gate.peek("p1")).not.toBeNull();
  });

  it("refuses an approval belonging to the other domain, and never runs it", async () => {
    const { gate, selfHeal } = harness();
    await gate.propose("p1", { domain: "personal", summary: "x", kind: "module_crash_restart" });
    const ran = vi.fn(async () => {});

    const result = await selfHeal.applyApproved("p1", "module_crash_restart", ran);

    expect(result).toEqual({ ok: false, reason: "wrong_domain" });
    expect(ran).not.toHaveBeenCalled();
  });

  it("distinguishes an unknown id from every other failure", async () => {
    const { selfHeal } = harness();
    expect(await selfHeal.applyApproved("nope", "module_crash_restart", async () => {})).toEqual({
      ok: false,
      reason: "unknown_id",
    });
  });

  it("a missing cacheScope throws rather than silently clearing the wrong cache", async () => {
    const cleared: string[] = [];
    const selfHeal = new SelfHeal(WORK, new ApprovalGate({ notify: async () => {} }), {
      restartModule: async () => {},
      clearCache: async (scope) => void cleared.push(scope),
      cleanupDuplicateMemory: async () => 0,
    });
    await expect(selfHeal.handle("stale_cache_clear", { summary: "stale" })).rejects.toThrow(/requires cacheScope/);
    expect(cleared).toEqual([]);
  });
});

describe("PushoverApprovalNotifier — a failed page is not a delivered page", () => {
  const env = { JARVIS_WORK_PUSHOVER_TOKEN: "t", JARVIS_WORK_PUSHOVER_USER: "u" };
  const request = { domain: "work", summary: "s", kind: "k", proposedAt: new Date().toISOString() };

  it("throws on a non-2xx response instead of resolving as if a human were paged", async () => {
    const notifier = new PushoverApprovalNotifier(WORK, env, (async () => ({
      ok: false,
      status: 401,
      text: async () => '{"errors":["application token is invalid"]}',
    })) as unknown as typeof fetch);

    await expect(notifier.notify(request)).rejects.toThrow(/401/);
  });

  it("resolves quietly on success", async () => {
    const notifier = new PushoverApprovalNotifier(WORK, env, (async () => ({
      ok: true,
      status: 200,
      text: async () => "{}",
    })) as unknown as typeof fetch);

    await expect(notifier.notify(request)).resolves.toBeUndefined();
  });
});

describe("CapabilityRegistry — schema drift fails loudly, not quietly", () => {
  function registryOver(rows: Record<string, unknown>[]): CapabilityRegistry {
    const pool = { query: async () => ({ rows }) } as never;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return new (RegistryCtor as never as { new (c: typeof WORK, p: never): CapabilityRegistry })(WORK, pool);
  }

  const fullRow = {
    id: "1",
    name: "n",
    enabled: true,
    priority: 100,
    schema_def: {},
    system_prompt: null,
    tool_config: {},
    model_override: null,
    credential_ref: "nzb-oauth",
    module_path: "./m.js",
  };

  it("a present-but-NULL credential_ref is allowed through as null", async () => {
    const rows = await registryOver([{ ...fullRow, credential_ref: null }]).list();
    expect(rows[0]!.credentialRef).toBeNull();
  });

  it("a MISSING credential_ref column throws instead of reading as null", async () => {
    // Without this, a renamed or dropped column silently switches off
    // credential auditing for one domain while the other keeps working —
    // which looks like configuration, not a bug.
    const { credential_ref, ...withoutColumn } = fullRow;
    void credential_ref;
    await expect(registryOver([withoutColumn]).list()).rejects.toThrow(/schema drift/);
  });
});
