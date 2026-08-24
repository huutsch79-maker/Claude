import { describe, expect, it } from "vitest";
import { assertOperationalMetadataShape, type OperationalMetadata } from "../src/orchestrator/operationalMetadata.js";
import { OperationalBus } from "../src/orchestrator/operationalBus.js";
import { CredentialStore } from "../src/domain/credentialStore.js";
import { RelationsStore } from "../src/domain/relationsStore.js";
import { CapabilityRegistry, type CapabilityRow } from "../src/domain/capabilityRegistry.js";

function validMetadata(): OperationalMetadata {
  return {
    reportedAt: new Date().toISOString(),
    moduleHealth: [{ moduleId: "m1", status: "healthy", lastRestartAt: null, restartCount24h: 0 }],
    credentialStatus: [{ credentialRef: "ref1", status: "valid", expiresAt: null }],
    errorCounts: { transient24h: 0, fatal24h: 0 },
  };
}

describe("operational metadata boundary", () => {
  it("accepts well-formed metadata", () => {
    expect(() => assertOperationalMetadataShape(validMetadata())).not.toThrow();
  });

  it("rejects a stray top-level content field", () => {
    const bad = { ...validMetadata(), lastUserMessage: "some chat content leaking through" };
    expect(() => assertOperationalMetadataShape(bad)).toThrow(/disallowed field/);
  });

  it("rejects content smuggled into a moduleHealth entry", () => {
    const bad = validMetadata();
    (bad.moduleHealth[0] as unknown as Record<string, unknown>).debugContext = "conversation excerpt";
    expect(() => assertOperationalMetadataShape(bad)).toThrow(/disallowed field/);
  });

  it("rejects a credential value smuggled into credentialStatus", () => {
    const bad = validMetadata();
    (bad.credentialStatus[0] as unknown as Record<string, unknown>).secretValue = "sk-abc123";
    expect(() => assertOperationalMetadataShape(bad)).toThrow(/disallowed field/);
  });

  it("OperationalBus refuses to publish malformed metadata", () => {
    const bus = new OperationalBus();
    const bad = { ...validMetadata(), extra: "nope" } as unknown as OperationalMetadata;
    expect(() => bus.publish(bad)).toThrow();
  });

  it("OperationalBus tracks the latest snapshot", () => {
    const bus = new OperationalBus();
    expect(bus.snapshot()).toBeNull();
    bus.publish(validMetadata());
    expect(bus.snapshot()?.reportedAt).toBeDefined();
  });
});

describe("credential store", () => {
  it("reads env vars under the shared JARVIS_CRED_ prefix", () => {
    const env = { JARVIS_CRED_NZB_M365_OAUTH: "nzb-secret", JARVIS_CRED_HOTMAIL_OAUTH: "hotmail-secret" };
    const store = new CredentialStore(env as NodeJS.ProcessEnv);
    expect(store.get("nzb-m365-oauth")?.value).toBe("nzb-secret");
    expect(store.get("hotmail-oauth")?.value).toBe("hotmail-secret");
  });

  it("returns null for a credential that isn't set", () => {
    const store = new CredentialStore({} as NodeJS.ProcessEnv);
    expect(store.get("does-not-exist")).toBeNull();
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

describe("capability conflict resolution", () => {
  function row(name: string, priority: number): CapabilityRow {
    return {
      id: name,
      name,
      category: null,
      enabled: true,
      priority,
      schemaDef: {},
      systemPrompt: null,
      toolConfig: {},
      modelOverride: null,
      credentialRef: null,
      modulePath: "irrelevant",
    };
  }

  it("picks the single highest-priority candidate", () => {
    const registry = new CapabilityRegistry({} as never);
    const result = registry.resolve([row("a", 50), row("b", 100)]);
    expect(result).toEqual({ kind: "resolved", capability: row("b", 100) });
  });

  it("surfaces a genuine priority tie as ask_user instead of guessing", () => {
    const registry = new CapabilityRegistry({} as never);
    const result = registry.resolve([row("a", 100), row("b", 100)]);
    expect(result?.kind).toBe("ask_user");
    if (result?.kind === "ask_user") {
      expect(result.tied.map((c) => c.name).sort()).toEqual(["a", "b"]);
    }
  });

  it("returns null for no candidates", () => {
    const registry = new CapabilityRegistry({} as never);
    expect(registry.resolve([])).toBeNull();
  });
});
