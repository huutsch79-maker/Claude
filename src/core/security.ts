import type { DomainConfig } from "../config/domains.js";
import type { CredentialStore } from "../domain/credentialStore.js";
import type { CapabilityRegistry } from "../domain/capabilityRegistry.js";
import type { CredentialStatusSummary } from "../orchestrator/operationalMetadata.js";

export interface AccessAuditFinding {
  credentialRef: string;
  issue: "unused_by_any_enabled_capability" | "referenced_but_missing" | "expiring_soon" | "expired";
}

/**
 * What an audit looked at, not just what it found.
 *
 * `statuses: []` used to be the entire answer, which made "audited nine
 * refs, all valid" and "audited nothing at all" the same value. That is
 * exactly how an empty capability registry reported perfect health for four
 * days in production: zero problems out of zero checks is indistinguishable
 * from zero problems out of many, unless the count of checks is part of the
 * result. Callers must be able to tell the difference without inferring it
 * from array length, so both counts are stated explicitly here.
 */
export interface CredentialAuditResult {
  /** Capabilities in this domain's registry. Zero means nothing is registered — a finding in itself. */
  capabilityCount: number;
  /** Distinct credential refs actually audited. Zero with a non-zero capabilityCount means every capability lacks a ref. */
  auditedRefCount: number;
  statuses: CredentialStatusSummary[];
  findings: AccessAuditFinding[];
}

/**
 * Audits credential validity and access patterns for exactly one domain.
 * Constructed with that domain's own CredentialStore and CapabilityRegistry
 * — there is no parameter anywhere that lets it reach into another
 * domain's store.
 */
export class SecurityAccess {
  constructor(
    private readonly config: DomainConfig,
    private readonly credentials: CredentialStore,
    private readonly registry: CapabilityRegistry,
  ) {}

  async auditCredentials(): Promise<CredentialAuditResult> {
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

    return {
      capabilityCount: capabilities.length,
      auditedRefCount: uniqueRefs.length,
      statuses,
      findings,
    };
  }
}
