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
  const approvals = buildApprovals(source, domainId);

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
    };
  }

  const ageMs = now.getTime() - new Date(metadata.reportedAt).getTime();
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
  };
}

function buildApprovals(source: DashboardSource, domainId: DomainId): ApprovalSummary[] {
  const pending = source.listPending(domainId);
  return Array.from(pending.entries()).map(([id, request]) => ({
    id,
    kind: request.kind,
    summary: request.summary,
    proposedAt: request.proposedAt,
  }));
}

function sortCredentialStatus(entries: CredentialStatusSummary[]): CredentialStatusSummary[] {
  return [...entries].sort((a, b) => CREDENTIAL_STATUS_ORDER[a.status] - CREDENTIAL_STATUS_ORDER[b.status]);
}
