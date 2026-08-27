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
  /** Capped at APPROVAL_DISPLAY_LIMIT (readModel.ts), oldest-first. See totalPending for the true count. */
  approvals: ApprovalSummary[];
  /** True count of pending approvals for this domain, even when `approvals` above was truncated. */
  totalPending: number;
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
  "totalPending",
]);
const TOP_LEVEL_KEYS = new Set(["domains"]);

// Value-level whitelists — key-name checks alone (assertOnlyKeys) let an
// allowed key carry an arbitrary/leaked value straight through to the wire.
// These enums must be kept in sync with ModuleHealthSummary["status"] and
// CredentialStatusSummary["status"] in operationalMetadata.ts.
const MODULE_HEALTH_STATUSES = new Set(["healthy", "degraded", "crashed", "disabled"]);
const CREDENTIAL_STATUSES = new Set(["valid", "expiring_soon", "expired", "invalid"]);

/**
 * Defense in depth, mirroring assertOperationalMetadataShape: a runtime
 * check that a /api/state response can never carry an extra field — e.g. a
 * stray debug/content field smuggled in by a future refactor — even though
 * TypeScript enforces the shape at compile time. Throws rather than
 * silently dropping fields, so the bug that put them there gets caught
 * instead of hidden.
 *
 * Key-name checks alone aren't enough: an allowed key with an arbitrary
 * value (e.g. moduleId set to a nested object instead of a string) would
 * sail through assertOnlyKeys unchanged and get serialized straight into
 * the response. So every field is also checked by TYPE/enum here, not just
 * by name.
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

    assertString(d.domain, "dashboard payload domain entry: domain");
    assertStringOrNull(d.reportedAt, "dashboard payload domain entry: reportedAt");
    assertFiniteNumberOrNull(d.ageMs, "dashboard payload domain entry: ageMs");
    assertBoolean(d.stale, "dashboard payload domain entry: stale");
    assertBoolean(d.awaitingFirstReport, "dashboard payload domain entry: awaitingFirstReport");

    if (!Array.isArray(d.moduleHealth)) throw new Error("dashboard payload domain entry: moduleHealth must be an array");
    for (const m of d.moduleHealth) {
      assertOnlyKeys(m, MODULE_HEALTH_KEYS, "moduleHealth entry");
      const entry2 = m as Record<string, unknown>;
      assertString(entry2.moduleId, "moduleHealth entry: moduleId");
      assertEnum(entry2.status, MODULE_HEALTH_STATUSES, "moduleHealth entry: status");
      assertStringOrNull(entry2.lastRestartAt, "moduleHealth entry: lastRestartAt");
      assertFiniteNumber(entry2.restartCount24h, "moduleHealth entry: restartCount24h");
    }

    if (!Array.isArray(d.credentialStatus)) {
      throw new Error("dashboard payload domain entry: credentialStatus must be an array");
    }
    for (const c of d.credentialStatus) {
      assertOnlyKeys(c, CREDENTIAL_STATUS_KEYS, "credentialStatus entry");
      const entry2 = c as Record<string, unknown>;
      assertString(entry2.credentialRef, "credentialStatus entry: credentialRef");
      assertEnum(entry2.status, CREDENTIAL_STATUSES, "credentialStatus entry: status");
      assertStringOrNull(entry2.expiresAt, "credentialStatus entry: expiresAt");
    }

    assertOnlyKeys(d.errorCounts, ERROR_COUNT_KEYS, "errorCounts");
    const errorCounts = d.errorCounts as Record<string, unknown>;
    assertFiniteNumber(errorCounts.transient24h, "errorCounts: transient24h");
    assertFiniteNumber(errorCounts.fatal24h, "errorCounts: fatal24h");

    if (!Array.isArray(d.approvals)) throw new Error("dashboard payload domain entry: approvals must be an array");
    for (const a of d.approvals) {
      assertOnlyKeys(a, APPROVAL_KEYS, "approvals entry");
      const entry2 = a as Record<string, unknown>;
      assertString(entry2.id, "approvals entry: id");
      assertString(entry2.kind, "approvals entry: kind");
      assertString(entry2.summary, "approvals entry: summary");
      assertString(entry2.proposedAt, "approvals entry: proposedAt");
    }

    assertFiniteNumber(d.totalPending, "dashboard payload domain entry: totalPending");
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

function assertString(value: unknown, label: string): void {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
}

function assertStringOrNull(value: unknown, label: string): void {
  if (value !== null && typeof value !== "string") {
    throw new Error(`${label} must be a string or null`);
  }
}

function assertBoolean(value: unknown, label: string): void {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
}

/** Number.isFinite (not just typeof "number") so NaN/Infinity can never pass as a legitimate value. */
function assertFiniteNumber(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
}

function assertFiniteNumberOrNull(value: unknown, label: string): void {
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error(`${label} must be a finite number or null`);
  }
}

function assertEnum(value: unknown, allowed: Set<string>, label: string): void {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new Error(`${label} must be one of: ${Array.from(allowed).join(", ")}`);
  }
}
