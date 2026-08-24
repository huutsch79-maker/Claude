import type { CredentialStatusSummary } from "../orchestrator/operationalMetadata.js";

const CREDENTIAL_ENV_PREFIX = "JARVIS_CRED_";

export interface CredentialRecord {
  ref: string; // pointer/name, e.g. "nzb-m365-oauth" — never the secret itself
  value: string;
  expiresAt: string | null;
}

/**
 * Reads credentials from env vars under one shared prefix. Each capability
 * still points at its own credential_ref (a real, distinct account —
 * NZB's M365 tenant and a personal Hotmail account are never the same
 * secret), but there's no per-domain namespace anymore: unifying memory
 * and chat removed the reason for one. See docs/architecture.md.
 */
export class CredentialStore {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  private envKey(ref: string): string {
    return `${CREDENTIAL_ENV_PREFIX}${ref.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  }

  get(ref: string): CredentialRecord | null {
    const key = this.envKey(ref);
    const value = this.env[key];
    if (!value) return null;
    const expiresAtKey = `${key}_EXPIRES_AT`;
    return { ref, value, expiresAt: this.env[expiresAtKey] ?? null };
  }

  require(ref: string): CredentialRecord {
    const record = this.get(ref);
    if (!record) {
      throw new Error(`missing credential "${ref}" — expected env var ${this.envKey(ref)}`);
    }
    return record;
  }

  /** Used by SecurityAccess to audit expiry — never returns raw values. */
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
