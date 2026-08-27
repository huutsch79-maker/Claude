import type { DomainId } from "../config/domains.js";
import type {
  CredentialStatusSummary,
  ErrorCountSummary,
  ModuleHealthSummary,
  OperationalMetadata,
} from "../orchestrator/operationalMetadata.js";
import type { ApprovalRequest } from "../core/approvalGate.js";

/**
 * The narrow read-only interface the dashboard is built against. Nothing in
 * src/dashboard/** ever sees a DomainInstance, a Pool, or any domain-internal
 * store — only what this interface exposes, which is exactly the same two
 * in-memory objects the orchestrator layer already legitimately holds
 * (OperationalBus.snapshot() and each domain's ApprovalGate.listPending()).
 *
 * resolve()/approve()/reject() are deliberately absent — that's Phase 2/3,
 * not needed for a read-only Phase 1, and adding it now would be speculative.
 */
export interface DashboardSource {
  listDomains(): { id: DomainId; label: string }[];
  snapshot(): ReadonlyMap<DomainId, OperationalMetadata>;
  listPending(domainId: DomainId): ReadonlyMap<string, ApprovalRequest>;
}

/** One pending approval as rendered to the dashboard. */
export interface ApprovalSummary {
  id: string;
  kind: string;
  summary: string;
  proposedAt: string; // ISO timestamp
}

/**
 * Per-domain state as served by GET /api/state. When a domain hasn't
 * published a health report yet (bus.snapshot() has no entry for it —
 * expected right after boot, or if reportHealth() has been failing),
 * reportedAt/ageMs are null, stale and awaitingFirstReport are both true,
 * and the array/count fields are empty rather than omitted, so every
 * response has a single consistent shape.
 */
export interface DomainStatePayload {
  domain: DomainId;
  reportedAt: string | null; // ISO timestamp, or null if never reported
  ageMs: number | null; // time since reportedAt, or null if never reported
  stale: boolean;
  awaitingFirstReport: boolean;
  moduleHealth: ModuleHealthSummary[];
  credentialStatus: CredentialStatusSummary[];
  errorCounts: ErrorCountSummary;
  approvals: ApprovalSummary[];
}

/** The full body of GET /api/state. */
export interface DashboardStatePayload {
  domains: DomainStatePayload[];
}

const APPROVAL_KEYS = new Set(["id", "kind", "summary", "proposedAt"]);
const MODULE_HEALTH_KEYS = new Set(["moduleId", "status", "lastRestartAt", "restartCount24h"]);
const CREDENTIAL_STATUS_KEYS = new Set(["credentialRef", "status", "expiresAt"]);
const ERROR_COUNT_KEYS = new Set(["transient24h", "fatal24h"]);
const DOMAIN_STATE_KEYS = new Set([
  "domain",
  "reportedAt",
  "ageMs",
  "stale",
  "awaitingFirstReport",
  "moduleHealth",
  "credentialStatus",
  "errorCounts",
  "approvals",
]);
const TOP_LEVEL_KEYS = new Set(["domains"]);

/**
 * Defense in depth, mirroring assertOperationalMetadataShape: a runtime
 * check that a /api/state response can never carry an extra field — e.g. a
 * stray debug/content field smuggled in by a future refactor — even though
 * TypeScript enforces the shape at compile time. Throws rather than
 * silently dropping fields, so the bug that put them there gets caught
 * instead of hidden.
 */
export function assertDashboardPayloadShape(value: unknown): asserts value is DashboardStatePayload {
  if (typeof value !== "object" || value === null) {
    throw new Error("dashboard payload must be an object");
  }
  assertOnlyKeys(value, TOP_LEVEL_KEYS, "dashboard payload");
  const v = value as Record<string, unknown>;

  if (!Array.isArray(v.domains)) throw new Error("dashboard payload: domains must be an array");
  for (const entry of v.domains) {
    assertOnlyKeys(entry, DOMAIN_STATE_KEYS, "dashboard payload domain entry");
    const d = entry as Record<string, unknown>;

    if (typeof d.domain !== "string") throw new Error("dashboard payload domain entry: domain must be a string");
    if (d.reportedAt !== null && typeof d.reportedAt !== "string") {
      throw new Error("dashboard payload domain entry: reportedAt must be a string or null");
    }
    if (d.ageMs !== null && typeof d.ageMs !== "number") {
      throw new Error("dashboard payload domain entry: ageMs must be a number or null");
    }
    if (typeof d.stale !== "boolean") throw new Error("dashboard payload domain entry: stale must be a boolean");
    if (typeof d.awaitingFirstReport !== "boolean") {
      throw new Error("dashboard payload domain entry: awaitingFirstReport must be a boolean");
    }

    if (!Array.isArray(d.moduleHealth)) throw new Error("dashboard payload domain entry: moduleHealth must be an array");
    for (const m of d.moduleHealth) {
      assertOnlyKeys(m, MODULE_HEALTH_KEYS, "moduleHealth entry");
    }

    if (!Array.isArray(d.credentialStatus)) {
      throw new Error("dashboard payload domain entry: credentialStatus must be an array");
    }
    for (const c of d.credentialStatus) {
      assertOnlyKeys(c, CREDENTIAL_STATUS_KEYS, "credentialStatus entry");
    }

    assertOnlyKeys(d.errorCounts, ERROR_COUNT_KEYS, "errorCounts");

    if (!Array.isArray(d.approvals)) throw new Error("dashboard payload domain entry: approvals must be an array");
    for (const a of d.approvals) {
      assertOnlyKeys(a, APPROVAL_KEYS, "approvals entry");
    }
  }
}

function assertOnlyKeys(value: unknown, allowed: Set<string>, label: string): void {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(
        `${label} contains disallowed field "${key}" — the dashboard payload may only carry the ` +
          `whitelisted operational/approval fields, never domain content.`,
      );
    }
  }
}
