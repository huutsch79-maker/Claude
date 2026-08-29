import type { DomainId } from "../config/domains.js";
import type {
  CredentialStatusSummary,
  ErrorCountSummary,
  ModuleHealthSummary,
  OperationalMetadata,
} from "../orchestrator/operationalMetadata.js";
import type { ApprovalRequest } from "../core/approvalGate.js";
import {
  CONTENT_STATUSES,
  MAX_DISPLAY_NAME_LEN,
  MAX_TOP_SENDERS,
  MAX_TOP_SERVICES,
  type DomainContentSummary,
} from "../orchestrator/domainContentSummary.js";

/** Local to the dashboard layer — deliberately NOT imported from src/domain/chatHistoryStore.ts (a domain-internal store); mirrors its shape. */
export type ChatRole = "user" | "assistant";

/** Metadata only — never raw bytes, never file content/URI. Mirrors db/schema.sql's chat_history.attachments column. */
export interface ChatAttachmentMeta {
  filename: string;
  mediaType: string;
  sizeBytes: number;
}

export interface ChatHistoryEntry {
  role: ChatRole;
  content: string;
  attachments: ChatAttachmentMeta[];
  createdAt: string;
}

/**
 * The narrow interface the dashboard is built against. Nothing in
 * src/dashboard/** ever sees a DomainInstance, a Pool, or any domain-internal
 * store — only what this interface exposes: OperationalBus.snapshot(),
 * ContentBus.snapshot() (both whitelisted, shape-asserted channels), each
 * domain's ApprovalGate.listPending(), and chat history reached only through
 * appendChatMessage/recentChatHistory below (metadata-only attachments,
 * never raw bytes).
 *
 * This interface is NOT read-only — appendChatMessage persists a chat turn,
 * a deliberate, narrow, whitelisted write path added for the chat feature.
 * approve()/reject() on approvals are still absent — that remains
 * speculative, out of scope for this pass.
 */
export interface DashboardSource {
  listDomains(): { id: DomainId; label: string }[];
  snapshot(): ReadonlyMap<DomainId, OperationalMetadata>;
  contentSnapshot(): ReadonlyMap<DomainId, DomainContentSummary>;
  listPending(domainId: DomainId): ReadonlyMap<string, ApprovalRequest>;
  appendChatMessage(domainId: DomainId, entry: { role: ChatRole; content: string; attachments: ChatAttachmentMeta[] }): Promise<void>;
  recentChatHistory(domainId: DomainId, limit?: number): Promise<ChatHistoryEntry[]>;
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
  /** Mail/Azure-cost content summary, or null if this domain has never published one yet (see contentSnapshot()). */
  content: DomainContentSummary | null;
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
  "content",
]);
const TOP_LEVEL_KEYS = new Set(["domains"]);
const CONTENT_KEYS = new Set(["domain", "reportedAt", "mail", "azureCost"]);
const MAIL_SUMMARY_KEYS = new Set(["status", "unreadCount", "totalCount", "topSenders", "lastSyncedAt"]);
const AZURE_COST_KEYS = new Set(["status", "currency", "monthToDateCost", "topServices", "lastSyncedAt"]);
const TOP_SENDER_KEYS = new Set(["displayName", "messageCount"]);
const TOP_SERVICE_KEYS = new Set(["serviceName", "cost"]);

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

    if (d.content !== null) {
      assertDomainContentPayloadShape(d.content);
    }
  }
}

/**
 * Rejects a poisoned domain-content payload at every nesting level, mirroring
 * assertDashboardPayloadShape above and assertDomainContentSummaryShape in
 * domainContentSummary.ts. Kept as its own re-check here (rather than just
 * trusting the orchestrator-layer assert) as defense in depth for the wire
 * payload specifically, exactly like the rest of this file already does for
 * health/approval fields.
 */
function assertDomainContentPayloadShape(value: unknown): void {
  assertOnlyKeys(value, CONTENT_KEYS, "dashboard payload domain content");
  const c = value as Record<string, unknown>;
  assertString(c.domain, "dashboard payload domain content: domain");
  assertString(c.reportedAt, "dashboard payload domain content: reportedAt");

  assertOnlyKeys(c.mail, MAIL_SUMMARY_KEYS, "dashboard payload domain content: mail");
  const mail = c.mail as Record<string, unknown>;
  assertEnum(mail.status, CONTENT_STATUSES, "dashboard payload domain content: mail.status");
  assertFiniteNumber(mail.unreadCount, "dashboard payload domain content: mail.unreadCount");
  assertFiniteNumber(mail.totalCount, "dashboard payload domain content: mail.totalCount");
  if (!Array.isArray(mail.topSenders)) {
    throw new Error("dashboard payload domain content: mail.topSenders must be an array");
  }
  if (mail.topSenders.length > MAX_TOP_SENDERS) {
    throw new Error(`dashboard payload domain content: mail.topSenders must have at most ${MAX_TOP_SENDERS} entries`);
  }
  for (const s of mail.topSenders) {
    assertOnlyKeys(s, TOP_SENDER_KEYS, "dashboard payload domain content: mail.topSenders entry");
    const entry = s as Record<string, unknown>;
    assertString(entry.displayName, "dashboard payload domain content: mail.topSenders entry displayName");
    if ((entry.displayName as string).length > MAX_DISPLAY_NAME_LEN) {
      throw new Error(`dashboard payload domain content: mail.topSenders entry displayName exceeds ${MAX_DISPLAY_NAME_LEN} chars`);
    }
    assertFiniteNumber(entry.messageCount, "dashboard payload domain content: mail.topSenders entry messageCount");
  }
  assertStringOrNull(mail.lastSyncedAt, "dashboard payload domain content: mail.lastSyncedAt");

  if (c.azureCost !== null) {
    assertOnlyKeys(c.azureCost, AZURE_COST_KEYS, "dashboard payload domain content: azureCost");
    const azureCost = c.azureCost as Record<string, unknown>;
    assertEnum(azureCost.status, CONTENT_STATUSES, "dashboard payload domain content: azureCost.status");
    assertString(azureCost.currency, "dashboard payload domain content: azureCost.currency");
    assertFiniteNumberOrNull(azureCost.monthToDateCost, "dashboard payload domain content: azureCost.monthToDateCost");
    if (!Array.isArray(azureCost.topServices)) {
      throw new Error("dashboard payload domain content: azureCost.topServices must be an array");
    }
    if (azureCost.topServices.length > MAX_TOP_SERVICES) {
      throw new Error(`dashboard payload domain content: azureCost.topServices must have at most ${MAX_TOP_SERVICES} entries`);
    }
    for (const s of azureCost.topServices) {
      assertOnlyKeys(s, TOP_SERVICE_KEYS, "dashboard payload domain content: azureCost.topServices entry");
      const entry = s as Record<string, unknown>;
      assertString(entry.serviceName, "dashboard payload domain content: azureCost.topServices entry serviceName");
      if ((entry.serviceName as string).length > MAX_DISPLAY_NAME_LEN) {
        throw new Error(`dashboard payload domain content: azureCost.topServices entry serviceName exceeds ${MAX_DISPLAY_NAME_LEN} chars`);
      }
      assertFiniteNumber(entry.cost, "dashboard payload domain content: azureCost.topServices entry cost");
    }
    assertStringOrNull(azureCost.lastSyncedAt, "dashboard payload domain content: azureCost.lastSyncedAt");
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
