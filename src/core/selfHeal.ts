import type { DomainConfig } from "../config/domains.js";
import { ApprovalGate, type ApprovalFailure } from "./approvalGate.js";
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

/** Outcome of applying an approved action. Never a bare boolean — four different situations used to collapse into `false`. */
export type ApplyApprovedResult =
  | { ok: true }
  | { ok: false; reason: ApprovalFailure }
  | { ok: false; reason: "apply_failed"; error: unknown };

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

  /**
   * Called once a human approves a pending proposal via Pushover/dashboard.
   *
   * Order matters: the approval is consumed only after `apply` succeeds.
   * Consuming first meant a throwing `apply` left the operator watching the
   * approval disappear from the dashboard while the action had not run —
   * unrecoverable, and indistinguishable from success.
   *
   * `kind` is checked against what was actually approved so the apply
   * callback cannot perform a different action than the one a human agreed
   * to, and `domain` is checked so an id from one domain can never execute
   * against the other. Today each DomainInstance builds its own gate, so
   * ids cannot collide — the domain check is there so that stops being
   * load-bearing on an instantiation detail.
   */
  async applyApproved(id: string, kind: SelfHealActionKind, apply: () => Promise<void>): Promise<ApplyApprovedResult> {
    const request = this.approvalGate.peek(id);
    if (!request) {
      console.warn(`[${this.config.id}] applyApproved: no pending approval for id ${id}`);
      return { ok: false, reason: "unknown_id" };
    }
    if (request.domain !== this.config.id) {
      console.error(
        `[${this.config.id}] applyApproved: refusing approval ${id} belonging to domain "${request.domain}"`,
      );
      return { ok: false, reason: "wrong_domain" };
    }
    if (request.kind !== kind) {
      console.error(
        `[${this.config.id}] applyApproved: approval ${id} was for "${request.kind}", refusing to apply "${kind}"`,
      );
      return { ok: false, reason: "wrong_kind" };
    }

    try {
      await apply();
    } catch (error) {
      console.error(`[${this.config.id}] applyApproved: apply failed for ${id}, leaving it pending`, error);
      return { ok: false, reason: "apply_failed", error };
    }

    this.approvalGate.approve(id);
    return { ok: true };
  }

  private async applyAutoFix(kind: SelfHealActionKind, context: SelfHealContext): Promise<void> {
    switch (kind) {
      case "module_crash_restart":
        if (!context.moduleName) throw new Error("module_crash_restart requires moduleName");
        await this.handlers.restartModule(context.moduleName);
        return;
      case "stale_cache_clear":
        // Was `context.cacheScope ?? "default"`. A missing scope is the same
        // class of caller error as a missing moduleName one case above, and
        // guessing "default" cleared the wrong cache while reporting
        // "applied" — leaving the stale cache that triggered the heal intact
        // so the condition simply recurred.
        if (!context.cacheScope) throw new Error("stale_cache_clear requires cacheScope");
        await this.handlers.clearCache(context.cacheScope);
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
