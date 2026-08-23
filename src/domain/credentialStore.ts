import type { DomainConfig } from "../config/domains.js";
import type { CredentialStatusSummary } from "../orchestrator/operationalMetadata.js";

export interface CredentialRecord {
  ref: string; // pointer/name, e.g. "m365-oauth" — never the secret itself
  value: string;
  expiresAt: string | null;
}

/**
 * One instance per domain, reading only env vars under that domain's own
 * prefix (JARVIS_WORK_* / JARVIS_PERSONAL_*). There is deliberately no way
 * to construct this with another domain's prefix from inside a capability
 * module — modules only ever receive the store their own DomainInstance
 * built for them.
 */
export class CredentialStore {
  constructor(private readonly config: DomainConfig, private readonly env: NodeJS.ProcessEnv = process.env) {}

  get(ref: string): CredentialRecord | null {
    const key = `${this.config.credentialEnvPrefix}${ref.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
    const value = this.env[key];
    if (!value) return null;
    const expiresAtKey = `${key}_EXPIRES_AT`;
    return { ref, value, expiresAt: this.env[expiresAtKey] ?? null };
  }

  require(ref: string): CredentialRecord {
    const record = this.get(ref);
    if (!record) {
      throw new Error(
        `[${this.config.id}] missing credential "${ref}" — expected env var ` +
          `${this.config.credentialEnvPrefix}${ref.toUpperCase()}`,
      );
    }
    return record;
  }

  /** Used by SecurityAccess to audit expiry within this domain only — never returns raw values. */
  auditStatuses(refs: string[]): CredentialStatusSummary[] {
    const now = Date.now();
    return refs.map((ref) => {
      const record = this.get(ref);
      if (!record) return { credentialRef: ref, status: "invalid", expiresAt: null };
      if (!record.expiresAt) return { credentialRef: ref, status: "valid", expiresAt: null };
      const expiresAtMs = Date.parse(record.expiresAt);
      if (Number.isNaN(expiresAtMs)) return { credentialRef: ref, status: "invalid", expiresAt: record.expiresAt };
      if (expiresAtMs < now) return { credentialRef: ref, status: "expired", expiresAt: record.expiresAt };
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      if (expiresAtMs - now < sevenDaysMs) {
        return { credentialRef: ref, status: "expiring_soon", expiresAt: record.expiresAt };
      }
      return { credentialRef: ref, status: "valid", expiresAt: record.expiresAt };
    });
  }
}
