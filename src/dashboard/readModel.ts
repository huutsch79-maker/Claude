import type { DomainId } from "../config/domains.js";
import type { CredentialStatusSummary, OperationalMetadata } from "../orchestrator/operationalMetadata.js";
import type {
  ApprovalSummary,
  DashboardSource,
  DashboardStatePayload,
  DomainStatePayload,
} from "./types.js";

/**
 * Pure transform from a DashboardSource into the /api/state payload. No I/O
 * (no node:http, no fetch, no timers) — everything needed is passed in, so
 * this is trivially unit-testable against a fake source.
 */
export interface ReadModelOptions {
  /** Read from process.env.JARVIS_HEALTH_INTERVAL_MS by the caller (server.ts), not here. */
  healthIntervalMs: number;
  /** Injectable for tests; defaults to the real current time. */
  now?: () => Date;
}

const CREDENTIAL_STATUS_ORDER: Record<CredentialStatusSummary["status"], number> = {
  expired: 0,
  invalid: 1,
  expiring_soon: 2,
  valid: 3,
};

/**
 * Upper bound on how many pending approvals a single /api/state response
 * will ever serialize per domain. Without a cap, an unbounded pending map
 * (whether from a bug or, once Phase 2 wires real proposals in, a genuine
 * backlog) gets fully JSON.stringify'd on every poll — synchronously
 * blocking the event loop this server shares with the orchestrator's own
 * scheduled work. `totalPending` on the payload carries the true count so
 * the UI can say "showing N of totalPending".
 */
export const APPROVAL_DISPLAY_LIMIT = 500;

export function buildDashboardState(source: DashboardSource, opts: ReadModelOptions): DashboardStatePayload {
  const now = (opts.now ?? (() => new Date()))();
  const snapshot = source.snapshot();

  const domains = source.listDomains().map(({ id }) => buildDomainState(source, id, snapshot.get(id), now, opts.healthIntervalMs));

  return { domains };
}

function buildDomainState(
  source: DashboardSource,
  domainId: DomainId,
  metadata: OperationalMetadata | undefined,
  now: Date,
  healthIntervalMs: number,
): DomainStatePayload {
  const { approvals, totalPending } = buildApprovals(source, domainId);

  if (!metadata) {
    return {
      domain: domainId,
      reportedAt: null,
      ageMs: null,
      stale: true,
      awaitingFirstReport: true,
      moduleHealth: [],
      credentialStatus: [],
      errorCounts: { transient24h: 0, fatal24h: 0 },
      approvals,
      totalPending,
    };
  }

  const reportedAtMs = new Date(metadata.reportedAt).getTime();
  if (!Number.isFinite(reportedAtMs)) {
    // A malformed reportedAt would otherwise produce ageMs = NaN, which
    // JSON.stringify silently turns into `null` on the wire — indistinguishable
    // from a normal, healthy report. Flag it as stale/corrupt explicitly instead
    // of letting it pass as if nothing were wrong.
    return {
      domain: domainId,
      reportedAt: metadata.reportedAt,
      ageMs: null,
      stale: true,
      awaitingFirstReport: false,
      moduleHealth: metadata.moduleHealth,
      credentialStatus: sortCredentialStatus(metadata.credentialStatus),
      errorCounts: metadata.errorCounts,
      approvals,
      totalPending,
    };
  }

  const ageMs = now.getTime() - reportedAtMs;
  // Strict `>`: a report exactly 2x the interval old is (barely) still fresh.
  const stale = ageMs > 2 * healthIntervalMs;

  return {
    domain: domainId,
    reportedAt: metadata.reportedAt,
    ageMs,
    stale,
    awaitingFirstReport: false,
    moduleHealth: metadata.moduleHealth,
    credentialStatus: sortCredentialStatus(metadata.credentialStatus),
    errorCounts: metadata.errorCounts,
    approvals,
    totalPending,
  };
}

function buildApprovals(source: DashboardSource, domainId: DomainId): { approvals: ApprovalSummary[]; totalPending: number } {
  const pending = source.listPending(domainId);
  const all = Array.from(pending.entries()).map(([id, request]) => ({
    id,
    kind: request.kind,
    summary: request.summary,
    proposedAt: request.proposedAt,
  }));
  all.sort((a, b) => a.proposedAt.localeCompare(b.proposedAt)); // oldest first — operators care most about the longest-waiting ones
  return { approvals: all.slice(0, APPROVAL_DISPLAY_LIMIT), totalPending: all.length };
}

function sortCredentialStatus(entries: CredentialStatusSummary[]): CredentialStatusSummary[] {
  return [...entries].sort((a, b) => CREDENTIAL_STATUS_ORDER[a.status] - CREDENTIAL_STATUS_ORDER[b.status]);
}
