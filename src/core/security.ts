import type { CredentialStore } from "../domain/credentialStore.js";
import type { CapabilityRegistry } from "../domain/capabilityRegistry.js";
import type { OAuthCredentialStore } from "../domain/oauthCredentialStore.js";
import type { CredentialStatusSummary } from "../orchestrator/operationalMetadata.js";

export interface AccessAuditFinding {
  credentialRef: string;
  issue: "unused_by_any_enabled_capability" | "referenced_but_missing" | "expiring_soon" | "expired";
}

/** Audits credential validity and access patterns across all capabilities. */
export class SecurityAccess {
  constructor(
    private readonly credentials: CredentialStore,
    private readonly registry: CapabilityRegistry,
    private readonly oauthCredentials: OAuthCredentialStore,
  ) {}

  async auditCredentials(): Promise<{ statuses: CredentialStatusSummary[]; findings: AccessAuditFinding[] }> {
    const capabilities = await this.registry.list();
    const refs = capabilities.map((c) => c.credentialRef).filter((ref): ref is string => ref !== null);
    const uniqueRefs = Array.from(new Set(refs));

    // Delegated OAuth refs (hotmail-oauth, nzb-m365-oauth) never live in the
    // static JARVIS_CRED_* env store, so auditing them there would always
    // read as "missing" even when properly connected — they refresh
    // themselves well before their access token expires, so once connected
    // there's no fixed expiry worth reporting; a revoked/never-completed
    // consent still surfaces, via the static-audit fallback below since an
    // unconnected ref is absent from this set.
    const oauthConnected = await this.oauthCredentials.listConnectedRefs();
    const staticRefs = uniqueRefs.filter((ref) => !oauthConnected.has(ref));

    const statuses: CredentialStatusSummary[] = [
      ...this.credentials.auditStatuses(staticRefs),
      ...uniqueRefs.filter((ref) => oauthConnected.has(ref)).map((ref) => ({ credentialRef: ref, status: "valid" as const, expiresAt: null })),
    ];
    const findings: AccessAuditFinding[] = [];

    for (const status of statuses) {
      if (status.status === "invalid") findings.push({ credentialRef: status.credentialRef, issue: "referenced_but_missing" });
      if (status.status === "expiring_soon") findings.push({ credentialRef: status.credentialRef, issue: "expiring_soon" });
      if (status.status === "expired") findings.push({ credentialRef: status.credentialRef, issue: "expired" });
    }

    const enabledRefs = new Set(capabilities.filter((c) => c.enabled).map((c) => c.credentialRef).filter(Boolean));
    for (const ref of uniqueRefs) {
      if (!enabledRefs.has(ref)) {
        findings.push({ credentialRef: ref, issue: "unused_by_any_enabled_capability" });
      }
    }

    return { statuses, findings };
  }
}
