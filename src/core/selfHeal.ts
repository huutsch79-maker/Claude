import type { DomainConfig } from "../config/domains.js";
import { ApprovalGate } from "./approvalGate.js";
import { classifyTrustTier, type SelfHealActionKind } from "./trustTiers.js";

export interface SelfHealContext {
  summary: string; // operational description, no domain content
  moduleName?: string;
  cacheScope?: string;
  proposalId?: string;
}

export interface SelfHealHandlers {
  restartModule: (moduleName: string) => Promise<void>;
  clearCache: (scope: string) => Promise<void>;
  cleanupDuplicateMemory: () => Promise<number>; // returns count removed
}

/**
 * Restarts crashed modules, clears stale cache/session state, retries
 * transient failures — auto-fix tier only. Anything outside that tier goes
 * through ApprovalGate instead of being applied directly (see
 * trustTiers.ts for the exact split).
 */
export class SelfHeal {
  constructor(
    private readonly config: DomainConfig,
    private readonly approvalGate: ApprovalGate,
    private readonly handlers: SelfHealHandlers,
  ) {}

  async handle(kind: SelfHealActionKind, context: SelfHealContext): Promise<"applied" | "pending_approval"> {
    const tier = classifyTrustTier(kind);
    if (tier === "requires_approval") {
      const id = context.proposalId ?? crypto.randomUUID();
      await this.approvalGate.propose(id, { domain: this.config.id, summary: context.summary, kind });
      return "pending_approval";
    }
    await this.applyAutoFix(kind, context);
    return "applied";
  }

  /** Called once a human approves a pending proposal via Pushover/dashboard. */
  async applyApproved(id: string, apply: () => Promise<void>): Promise<boolean> {
    const request = this.approvalGate.approve(id);
    if (!request) return false;
    await apply();
    return true;
  }

  private async applyAutoFix(kind: SelfHealActionKind, context: SelfHealContext): Promise<void> {
    switch (kind) {
      case "module_crash_restart":
        if (!context.moduleName) throw new Error("module_crash_restart requires moduleName");
        await this.handlers.restartModule(context.moduleName);
        return;
      case "stale_cache_clear":
        await this.handlers.clearCache(context.cacheScope ?? "default");
        return;
      case "high_confidence_duplicate_memory_cleanup":
        await this.handlers.cleanupDuplicateMemory();
        return;
      case "transient_api_retry":
        // Retry itself happens at the call site (it's a control-flow
        // decision, not a state change); self-heal only records that this
        // tier permits it without approval.
        return;
      default:
        throw new Error(`applyAutoFix called with a non-auto-fix kind: ${kind}`);
    }
  }
}
