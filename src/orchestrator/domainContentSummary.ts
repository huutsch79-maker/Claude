import type { DomainId } from "../config/domains.js";

/**
 * The ONLY shape allowed to cross the domain boundary carrying informative
 * domain content (mail summaries, Azure cost) into the shared orchestrator
 * layer / dashboard. Mirrors operationalMetadata.ts exactly: every key and
 * every value's type/enum is whitelisted, and free text is never allowed —
 * only counts, enums, timestamps, and short capped display names.
 *
 * `azureCost` is ALWAYS null for the personal domain — hardcoded at the
 * DomainInstance level (see Domain.ts), never data-driven, so a bug can
 * never cause the personal domain to report Azure spend.
 */
export interface DomainContentSummary {
  domain: DomainId;
  reportedAt: string; // ISO timestamp
  mail: MailSummary;
  azureCost: AzureCostSummary | null;
}

export type ContentConnectionStatus = "connected" | "not_configured" | "error" | "stale";

export interface MailSummary {
  status: ContentConnectionStatus;
  unreadCount: number;
  totalCount: number;
  /** At most 5, sorted desc by messageCount. displayName truncated to <=80 chars before this shape is asserted. */
  topSenders: { displayName: string; messageCount: number }[];
  lastSyncedAt: string | null; // ISO timestamp, or null if never synced
}

export interface AzureCostSummary {
  status: ContentConnectionStatus;
  currency: string;
  monthToDateCost: number | null;
  /** At most 5, sorted desc by cost. */
  topServices: { serviceName: string; cost: number }[];
  lastSyncedAt: string | null;
}

export const MAX_TOP_SENDERS = 5;
export const MAX_TOP_SERVICES = 5;
export const MAX_DISPLAY_NAME_LEN = 80;

export const CONTENT_STATUSES = new Set<ContentConnectionStatus>(["connected", "not_configured", "error", "stale"]);

const TOP_SENDER_KEYS = new Set(["displayName", "messageCount"]);
const TOP_SERVICE_KEYS = new Set(["serviceName", "cost"]);
const MAIL_SUMMARY_KEYS = new Set(["status", "unreadCount", "totalCount", "topSenders", "lastSyncedAt"]);
const AZURE_COST_KEYS = new Set(["status", "currency", "monthToDateCost", "topServices", "lastSyncedAt"]);
const TOP_LEVEL_KEYS = new Set(["domain", "reportedAt", "mail", "azureCost"]);

/**
 * Defense in depth, mirroring assertOperationalMetadataShape: throws rather
 * than silently dropping fields, so a bug that smuggles an extra/free-text
 * field across the domain boundary is caught, not hidden.
 */
export function assertDomainContentSummaryShape(value: unknown): asserts value is DomainContentSummary {
  if (typeof value !== "object" || value === null) {
    throw new Error("domain content summary must be an object");
  }
  assertOnlyKeys(value, TOP_LEVEL_KEYS, "domain content summary");
  const v = value as Record<string, unknown>;

  if (typeof v.domain !== "string") throw new Error("domain content summary: domain must be a string");
  if (typeof v.reportedAt !== "string") throw new Error("domain content summary: reportedAt must be a string");

  assertMailSummaryShape(v.mail, "domain content summary: mail");

  if (v.azureCost !== null) {
    assertAzureCostSummaryShape(v.azureCost, "domain content summary: azureCost");
  }
}

export function assertMailSummaryShape(value: unknown, label = "mail summary"): asserts value is MailSummary {
  assertOnlyKeys(value, MAIL_SUMMARY_KEYS, label);
  const v = value as Record<string, unknown>;
  assertEnum(v.status, CONTENT_STATUSES, `${label}: status`);
  assertFiniteNumber(v.unreadCount, `${label}: unreadCount`);
  assertFiniteNumber(v.totalCount, `${label}: totalCount`);
  if (!Array.isArray(v.topSenders)) throw new Error(`${label}: topSenders must be an array`);
  if (v.topSenders.length > MAX_TOP_SENDERS) {
    throw new Error(`${label}: topSenders must have at most ${MAX_TOP_SENDERS} entries`);
  }
  for (const s of v.topSenders) {
    assertOnlyKeys(s, TOP_SENDER_KEYS, `${label}: topSenders entry`);
    const entry = s as Record<string, unknown>;
    if (typeof entry.displayName !== "string") throw new Error(`${label}: topSenders entry displayName must be a string`);
    if (entry.displayName.length > MAX_DISPLAY_NAME_LEN) {
      throw new Error(`${label}: topSenders entry displayName exceeds ${MAX_DISPLAY_NAME_LEN} chars`);
    }
    assertFiniteNumber(entry.messageCount, `${label}: topSenders entry messageCount`);
  }
  assertStringOrNull(v.lastSyncedAt, `${label}: lastSyncedAt`);
}

export function assertAzureCostSummaryShape(value: unknown, label = "azure cost summary"): asserts value is AzureCostSummary {
  assertOnlyKeys(value, AZURE_COST_KEYS, label);
  const v = value as Record<string, unknown>;
  assertEnum(v.status, CONTENT_STATUSES, `${label}: status`);
  if (typeof v.currency !== "string") throw new Error(`${label}: currency must be a string`);
  if (v.monthToDateCost !== null && (typeof v.monthToDateCost !== "number" || !Number.isFinite(v.monthToDateCost))) {
    throw new Error(`${label}: monthToDateCost must be a finite number or null`);
  }
  if (!Array.isArray(v.topServices)) throw new Error(`${label}: topServices must be an array`);
  if (v.topServices.length > MAX_TOP_SERVICES) {
    throw new Error(`${label}: topServices must have at most ${MAX_TOP_SERVICES} entries`);
  }
  for (const s of v.topServices) {
    assertOnlyKeys(s, TOP_SERVICE_KEYS, `${label}: topServices entry`);
    const entry = s as Record<string, unknown>;
    if (typeof entry.serviceName !== "string") throw new Error(`${label}: topServices entry serviceName must be a string`);
    if (entry.serviceName.length > MAX_DISPLAY_NAME_LEN) {
      throw new Error(`${label}: topServices entry serviceName exceeds ${MAX_DISPLAY_NAME_LEN} chars`);
    }
    assertFiniteNumber(entry.cost, `${label}: topServices entry cost`);
  }
  assertStringOrNull(v.lastSyncedAt, `${label}: lastSyncedAt`);
}

function assertOnlyKeys(value: unknown, allowed: Set<string>, label: string): void {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(
        `${label} contains disallowed field "${key}" — domain content summaries may only carry the ` +
          `whitelisted mail/cost fields, never free text, credentials, or raw message content.`,
      );
    }
  }
}

function assertStringOrNull(value: unknown, label: string): void {
  if (value !== null && typeof value !== "string") {
    throw new Error(`${label} must be a string or null`);
  }
}

function assertFiniteNumber(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
}

function assertEnum(value: unknown, allowed: Set<string>, label: string): void {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new Error(`${label} must be one of: ${Array.from(allowed).join(", ")}`);
  }
}
