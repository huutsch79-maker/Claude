import { DOMAINS, type DomainId } from "../config/domains.js";
import type { ApprovalRequest } from "../core/approvalGate.js";
import type { DashboardSource } from "../dashboard/types.js";
import type { DomainManager } from "./domainManager.js";
import type { OperationalMetadata } from "./operationalMetadata.js";

/**
 * The ONLY file allowed to import both DomainManager (which reaches every
 * domain-internal store) and the dashboard's narrow DashboardSource
 * interface. Everything on the dashboard side of this adapter only ever
 * sees manager.bus.snapshot() and each domain's approvals.listPending() —
 * the exact same two in-memory objects the orchestrator already legitimately
 * holds. No new channel across the domain boundary is opened here.
 */
export function createDashboardSource(manager: DomainManager): DashboardSource {
  return {
    listDomains(): { id: DomainId; label: string }[] {
      return Object.values(DOMAINS).map((config) => ({ id: config.id, label: config.label }));
    },

    snapshot(): ReadonlyMap<DomainId, OperationalMetadata> {
      return manager.bus.snapshot();
    },

    listPending(domainId: DomainId): ReadonlyMap<string, ApprovalRequest> {
      return manager.get(domainId).approvals.listPending();
    },
  };
}
