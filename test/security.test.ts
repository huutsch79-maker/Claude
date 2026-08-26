import { describe, expect, it } from "vitest";
import { SecurityAccess } from "../src/core/security.js";
import type { CredentialStore } from "../src/domain/credentialStore.js";
import type { CapabilityRegistry, CapabilityRow } from "../src/domain/capabilityRegistry.js";
import type { OAuthCredentialStore } from "../src/domain/oauthCredentialStore.js";

function capabilityRow(name: string, credentialRef: string | null, enabled = true): CapabilityRow {
  return {
    id: name,
    name,
    category: "work",
    enabled,
    priority: 100,
    schemaDef: {},
    systemPrompt: "",
    toolConfig: {},
    modelOverride: null,
    credentialRef,
    modulePath: name,
  };
}

describe("SecurityAccess.auditCredentials", () => {
  // Regression: hotmail-oauth/nzb-m365-oauth are delegated OAuth
  // credentials that live in jarvis.oauth_credentials, never in the static
  // JARVIS_CRED_* env store. Before this fix, auditCredentials() checked
  // every credentialRef against the static store only, so a properly
  // connected OAuth credential always came back "invalid" — the dashboard's
  // Health section would permanently flag a working connection as broken.
  it("reports a connected OAuth-managed credential as valid, not invalid", async () => {
    const registry = { list: async () => [capabilityRow("hotmail-outlook", "hotmail-oauth")] } as unknown as CapabilityRegistry;
    const credentials = { auditStatuses: (refs: string[]) => refs.map((r) => ({ credentialRef: r, status: "invalid" as const, expiresAt: null })) } as unknown as CredentialStore;
    const oauthCredentials = { listConnectedRefs: async () => new Set(["hotmail-oauth"]) } as unknown as OAuthCredentialStore;

    const security = new SecurityAccess(credentials, registry, oauthCredentials);
    const { statuses, findings } = await security.auditCredentials();

    expect(statuses).toEqual([{ credentialRef: "hotmail-oauth", status: "valid", expiresAt: null }]);
    expect(findings).toEqual([]);
  });

  it("still audits an OAuth-managed credential that was never connected via the static path (so it correctly shows missing)", async () => {
    const registry = { list: async () => [capabilityRow("hotmail-outlook", "hotmail-oauth")] } as unknown as CapabilityRegistry;
    const credentials = { auditStatuses: (refs: string[]) => refs.map((r) => ({ credentialRef: r, status: "invalid" as const, expiresAt: null })) } as unknown as CredentialStore;
    const oauthCredentials = { listConnectedRefs: async () => new Set<string>() } as unknown as OAuthCredentialStore;

    const security = new SecurityAccess(credentials, registry, oauthCredentials);
    const { statuses, findings } = await security.auditCredentials();

    expect(statuses).toEqual([{ credentialRef: "hotmail-oauth", status: "invalid", expiresAt: null }]);
    expect(findings).toEqual([{ credentialRef: "hotmail-oauth", issue: "referenced_but_missing" }]);
  });

  it("still audits static (non-OAuth) credentials as before", async () => {
    const registry = { list: async () => [capabilityRow("nzb-azure-cost-insights", "nzb-azure-insights-oauth")] } as unknown as CapabilityRegistry;
    const credentials = {
      auditStatuses: (refs: string[]) => refs.map((r) => ({ credentialRef: r, status: "expiring_soon" as const, expiresAt: "2026-09-01T00:00:00Z" })),
    } as unknown as CredentialStore;
    const oauthCredentials = { listConnectedRefs: async () => new Set<string>() } as unknown as OAuthCredentialStore;

    const security = new SecurityAccess(credentials, registry, oauthCredentials);
    const { statuses, findings } = await security.auditCredentials();

    expect(statuses).toEqual([{ credentialRef: "nzb-azure-insights-oauth", status: "expiring_soon", expiresAt: "2026-09-01T00:00:00Z" }]);
    expect(findings).toEqual([{ credentialRef: "nzb-azure-insights-oauth", issue: "expiring_soon" }]);
  });
});
