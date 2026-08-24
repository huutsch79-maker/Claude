import type { CredentialStore } from "../domain/credentialStore.js";
import type { CapabilityRegistry } from "../domain/capabilityRegistry.js";
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
  ) {}

  async auditCredentials(): Promise<{ statuses: CredentialStatusSummary[]; findings: AccessAuditFinding[] }> {
    const capabilities = await this.registry.list();
    const refs = capabilities.map((c) => c.credentialRef).filter((ref): ref is string => ref !== null);
    const uniqueRefs = Array.from(new Set(refs));

    const statuses = this.credentials.auditStatuses(uniqueRefs);
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
