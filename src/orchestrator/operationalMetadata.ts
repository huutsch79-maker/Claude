/**
 * The shape health reports take when published on the OperationalBus.
 * Every field here is a number, enum, or timestamp — never free text,
 * memory content, or a credential value. This predates the move to a
 * single unified instance (it used to also guard a domain-isolation
 * boundary); kept now as a general hygiene rule so operational status
 * never accidentally carries chat/memory content.
 */
export interface OperationalMetadata {
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
const TOP_LEVEL_KEYS = new Set(["reportedAt", "moduleHealth", "credentialStatus", "errorCounts"]);
const ERROR_COUNT_KEYS = new Set(["transient24h", "fatal24h"]);

/**
 * Defense in depth: even though TypeScript enforces this shape at compile
 * time, this runtime check exists so a bug can never smuggle an extra
 * field — e.g. a stray `lastMessage: string` — into the operational
 * health layer. Throws rather than silently dropping fields, because
 * silent dropping would hide the bug that put them there.
 */
export function assertOperationalMetadataShape(value: unknown): asserts value is OperationalMetadata {
  if (typeof value !== "object" || value === null) {
    throw new Error("operational metadata must be an object");
  }
  assertOnlyKeys(value, TOP_LEVEL_KEYS, "operational metadata");
  const v = value as Record<string, unknown>;

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
        `${label} contains disallowed field "${key}" — operational metadata may only carry module health, ` +
          `credential expiry, and error counts, never chat/memory content.`,
      );
    }
  }
}
