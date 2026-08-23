import { describe, expect, it } from "vitest";
import { DOMAINS } from "../src/config/domains.js";
import { assertOperationalMetadataShape, type OperationalMetadata } from "../src/orchestrator/operationalMetadata.js";
import { OperationalBus } from "../src/orchestrator/operationalBus.js";
import { CredentialStore } from "../src/domain/credentialStore.js";
import { RelationsStore } from "../src/domain/relationsStore.js";
import { classifyTrustTier } from "../src/core/trustTiers.js";
import { CapabilityRegistry, type CapabilityRow } from "../src/domain/capabilityRegistry.js";

function validMetadata(domain: "work" | "personal"): OperationalMetadata {
  return {
    domain,
    reportedAt: new Date().toISOString(),
    moduleHealth: [{ moduleId: "m1", status: "healthy", lastRestartAt: null, restartCount24h: 0 }],
    credentialStatus: [{ credentialRef: "ref1", status: "valid", expiresAt: null }],
    errorCounts: { transient24h: 0, fatal24h: 0 },
  };
}

describe("operational metadata boundary", () => {
  it("accepts well-formed metadata", () => {
    expect(() => assertOperationalMetadataShape(validMetadata("work"))).not.toThrow();
  });

  it("rejects a stray top-level content field", () => {
    const bad = { ...validMetadata("work"), lastUserMessage: "some memory content leaking across" };
    expect(() => assertOperationalMetadataShape(bad)).toThrow(/disallowed field/);
  });

  it("rejects content smuggled into a moduleHealth entry", () => {
    const bad = validMetadata("personal");
    (bad.moduleHealth[0] as unknown as Record<string, unknown>).debugContext = "conversation excerpt";
    expect(() => assertOperationalMetadataShape(bad)).toThrow(/disallowed field/);
  });

  it("rejects a credential value smuggled into credentialStatus", () => {
    const bad = validMetadata("work");
    (bad.credentialStatus[0] as unknown as Record<string, unknown>).secretValue = "sk-abc123";
    expect(() => assertOperationalMetadataShape(bad)).toThrow(/disallowed field/);
  });

  it("OperationalBus refuses to publish malformed metadata", () => {
    const bus = new OperationalBus();
    const bad = { ...validMetadata("work"), extra: "nope" } as unknown as OperationalMetadata;
    expect(() => bus.publish(bad)).toThrow();
  });

  it("OperationalBus keeps each domain's snapshot separate", () => {
    const bus = new OperationalBus();
    bus.publish(validMetadata("work"));
    bus.publish(validMetadata("personal"));
    const snapshot = bus.snapshot();
    expect(snapshot.get("work")?.domain).toBe("work");
    expect(snapshot.get("personal")?.domain).toBe("personal");
    expect(snapshot.size).toBe(2);
  });
});

describe("credential store isolation", () => {
  it("only reads env vars under its own domain prefix", () => {
    const env = {
      JARVIS_WORK_NZB_TOKEN: "work-secret",
      JARVIS_PERSONAL_NZB_TOKEN: "personal-secret",
    };
    const workStore = new CredentialStore(DOMAINS.work, env as NodeJS.ProcessEnv);
    expect(workStore.get("nzb-token")?.value).toBe("work-secret");

    const personalStore = new CredentialStore(DOMAINS.personal, env as NodeJS.ProcessEnv);
    expect(personalStore.get("nzb-token")?.value).toBe("personal-secret");
  });

  it("never returns the other domain's value for the same ref", () => {
    const env = {
      JARVIS_WORK_SHARED_NAME_TOKEN: "work-secret",
      // no JARVIS_PERSONAL_SHARED_NAME_TOKEN set
    };
    const personalStore = new CredentialStore(DOMAINS.personal, env as NodeJS.ProcessEnv);
    expect(personalStore.get("shared-name-token")).toBeNull();
  });

  it("work and personal domain configs use disjoint env prefixes and schemas", () => {
    expect(DOMAINS.work.credentialEnvPrefix).not.toBe(DOMAINS.personal.credentialEnvPrefix);
    expect(DOMAINS.work.schema).not.toBe(DOMAINS.personal.schema);
  });
});

describe("relations store only allows batch writes", () => {
  it("exposes writeBatch but no live single-write method", () => {
    const proto = RelationsStore.prototype as unknown as Record<string, unknown>;
    expect(typeof proto.writeBatch).toBe("function");
    expect(proto.writeRelation).toBeUndefined();
    expect(proto.writeLive).toBeUndefined();
  });
});

describe("self-heal trust tiers", () => {
  it("classifies reversible single-domain actions as auto_fix", () => {
    expect(classifyTrustTier("module_crash_restart")).toBe("auto_fix");
    expect(classifyTrustTier("stale_cache_clear")).toBe("auto_fix");
    expect(classifyTrustTier("high_confidence_duplicate_memory_cleanup")).toBe("auto_fix");
    expect(classifyTrustTier("transient_api_retry")).toBe("auto_fix");
  });

  it("classifies credential/structural/module actions as requires_approval", () => {
    expect(classifyTrustTier("credential_rotation")).toBe("requires_approval");
    expect(classifyTrustTier("credential_revocation")).toBe("requires_approval");
    expect(classifyTrustTier("domain_boundary_change")).toBe("requires_approval");
    expect(classifyTrustTier("schema_migration")).toBe("requires_approval");
    expect(classifyTrustTier("module_add")).toBe("requires_approval");
    expect(classifyTrustTier("module_remove")).toBe("requires_approval");
  });
});

describe("capability conflict resolution", () => {
  function row(name: string, priority: number): CapabilityRow {
    return {
      id: name,
      name,
      enabled: true,
      priority,
      schemaDef: {},
      systemPrompt: null,
      toolConfig: {},
      modelOverride: null,
      credentialRef: null,
      modulePath: "/dev/null",
    };
  }

  it("picks the single highest-priority candidate", () => {
    const registry = new CapabilityRegistry(DOMAINS.work, {} as never);
    const result = registry.resolve([row("a", 50), row("b", 100)]);
    expect(result).toEqual({ kind: "resolved", capability: row("b", 100) });
  });

  it("surfaces a genuine priority tie as ask_user instead of guessing", () => {
    const registry = new CapabilityRegistry(DOMAINS.personal, {} as never);
    const result = registry.resolve([row("a", 100), row("b", 100)]);
    expect(result?.kind).toBe("ask_user");
    if (result?.kind === "ask_user") {
      expect(result.tied.map((c) => c.name).sort()).toEqual(["a", "b"]);
    }
  });

  it("returns null for no candidates", () => {
    const registry = new CapabilityRegistry(DOMAINS.work, {} as never);
    expect(registry.resolve([])).toBeNull();
  });
});
