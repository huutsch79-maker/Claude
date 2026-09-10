import type { DomainId } from "../config/domains.js";

/**
 * The ONLY shape allowed to cross the domain boundary into the shared
 * orchestrator layer. Every field here is a number, enum, or timestamp —
 * never free text, memory content, or a credential value. If you find
 * yourself wanting to add a string field "just to help debugging," don't:
 * put it in that domain's own logs instead.
 */
export interface OperationalMetadata {
  domain: DomainId;
  reportedAt: string; // ISO timestamp
  moduleHealth: ModuleHealthSummary[];
  credentialStatus: CredentialStatusSummary[];
  errorCounts: ErrorCountSummary;
}

export interface ModuleHealthSummary {
  moduleId: string;
  status: "healthy" | "degraded" | "crashed" | "disabled";
  lastRestartAt: string | null;
  restartCount24h: number;
}

export interface CredentialStatusSummary {
  credentialRef: string; // pointer/name only, never the secret
  status: "valid" | "expiring_soon" | "expired" | "invalid";
  expiresAt: string | null;
}

export interface ErrorCountSummary {
  /**
   * False when nothing is counting errors. The two counts below are then
   * placeholders, not measurements — rendering them as "0 errors" is the
   * same lie as reporting an unaudited credential list as "all valid".
   */
  measured: boolean;
  transient24h: number;
  fatal24h: number;
}

const MODULE_HEALTH_KEYS = new Set([
  "moduleId",
  "status",
  "lastRestartAt",
  "restartCount24h",
]);
const CREDENTIAL_STATUS_KEYS = new Set(["credentialRef", "status", "expiresAt"]);
const TOP_LEVEL_KEYS = new Set([
  "domain",
  "reportedAt",
  "moduleHealth",
  "credentialStatus",
  "errorCounts",
]);
const ERROR_COUNT_KEYS = new Set(["measured", "transient24h", "fatal24h"]);

/**
 * Defense in depth: even though TypeScript enforces this shape at compile
 * time, this runtime check exists so a bug (or a future refactor) can never
 * smuggle an extra field — e.g. a stray `lastMessage: string` — across the
 * boundary from a domain into the shared orchestrator/reviewer layer.
 * Throws rather than silently dropping fields, because silent dropping
 * would hide the bug that put them there.
 */
export function assertOperationalMetadataShape(value: unknown): asserts value is OperationalMetadata {
  if (typeof value !== "object" || value === null) {
    throw new Error("operational metadata must be an object");
  }
  assertOnlyKeys(value, TOP_LEVEL_KEYS, "operational metadata");
  const v = value as Record<string, unknown>;

  if (typeof v.domain !== "string") throw new Error("operational metadata: domain must be a string");
  if (typeof v.reportedAt !== "string") throw new Error("operational metadata: reportedAt must be a string");

  if (!Array.isArray(v.moduleHealth)) throw new Error("operational metadata: moduleHealth must be an array");
  for (const entry of v.moduleHealth) {
    assertOnlyKeys(entry, MODULE_HEALTH_KEYS, "moduleHealth entry");
  }

  if (!Array.isArray(v.credentialStatus)) throw new Error("operational metadata: credentialStatus must be an array");
  for (const entry of v.credentialStatus) {
    assertOnlyKeys(entry, CREDENTIAL_STATUS_KEYS, "credentialStatus entry");
  }

  assertOnlyKeys(v.errorCounts, ERROR_COUNT_KEYS, "errorCounts");
}

function assertOnlyKeys(value: unknown, allowed: Set<string>, label: string): void {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(
        `${label} contains disallowed field "${key}" — the shared orchestrator layer may only carry ` +
          `operational metadata (module health, credential expiry, error counts), never domain content.`,
      );
    }
  }
}
