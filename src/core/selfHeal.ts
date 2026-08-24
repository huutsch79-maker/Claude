import type pg from "pg";
import type { DomainConfig } from "../config/domains.js";
import { ApprovalGate } from "./approvalGate.js";
import { classifyTrustTier, type SelfHealActionKind } from "./trustTiers.js";
import { getScript, type ScriptContext } from "./scriptRegistry.js";

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
    private readonly pool: pg.Pool,
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

  /**
   * Runs one of the bounded, in-code scripts from scriptRegistry.ts. Unlike
   * `handle()`, the trust tier here comes from the script's own definition
   * (each script sets its own tier), not from a fixed kind — but the same
   * fail-closed rule applies: an unknown script name is rejected outright,
   * never executed.
   */
  async runScript(
    scriptName: string,
    args: Record<string, string> = {},
  ): Promise<{ status: "applied" } | { status: "pending_approval"; approvalId: string }> {
    const script = getScript(scriptName);
    if (!script) {
      throw new Error(`[${this.config.id}] unknown script "${scriptName}" — scripts must be registered in code`);
    }

    if (script.trustTier === "requires_approval") {
      const id = crypto.randomUUID();
      await this.approvalGate.propose(id, {
        domain: this.config.id,
        summary: `run script "${scriptName}": ${script.description}`,
        kind: "run_script",
        scriptName,
        scriptArgs: args,
      });
      await this.recordScriptRun(id, scriptName, args, "requires_approval", "pending_approval", "awaiting approval");
      return { status: "pending_approval", approvalId: id };
    }

    await this.executeAndRecord(script.name, args);
    return { status: "applied" };
  }

  /** Called once a human approves a pending "run_script" proposal. */
  async approveScript(id: string): Promise<boolean> {
    const request = this.approvalGate.approve(id);
    if (!request || request.kind !== "run_script" || !request.scriptName) return false;
    await this.executeAndRecord(request.scriptName, request.scriptArgs ?? {}, id);
    return true;
  }

  async rejectScript(id: string): Promise<boolean> {
    const wasPending = this.approvalGate.reject(id);
    if (!wasPending) return false;
    await this.pool.query(
      `update core.script_runs set status = 'rejected', finished_at = now() where id = $1`,
      [id],
    );
    return true;
  }

  private async executeAndRecord(scriptName: string, args: Record<string, string>, existingRunId?: string): Promise<void> {
    const script = getScript(scriptName);
    if (!script) throw new Error(`[${this.config.id}] unknown script "${scriptName}"`);
    const ctx: ScriptContext = { domain: this.config, pool: this.pool, args };
    try {
      const result = await script.run(ctx);
      if (existingRunId) {
        await this.pool.query(
          `update core.script_runs set status = 'applied', detail = $2, finished_at = now() where id = $1`,
          [existingRunId, result.detail],
        );
      } else {
        await this.recordScriptRun(crypto.randomUUID(), scriptName, args, script.trustTier, "applied", result.detail);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (existingRunId) {
        await this.pool.query(
          `update core.script_runs set status = 'failed', detail = $2, finished_at = now() where id = $1`,
          [existingRunId, detail],
        );
      } else {
        await this.recordScriptRun(crypto.randomUUID(), scriptName, args, script.trustTier, "failed", detail);
      }
      throw err;
    }
  }

  private async recordScriptRun(
    id: string,
    scriptName: string,
    args: Record<string, string>,
    trustTier: "auto_fix" | "requires_approval",
    status: "applied" | "pending_approval" | "failed",
    detail: string,
  ): Promise<void> {
    const finished = status === "pending_approval" ? null : new Date().toISOString();
    await this.pool.query(
      `insert into core.script_runs (id, domain, script_name, args, trust_tier, status, detail, finished_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, this.config.id, scriptName, JSON.stringify(args), trustTier, status, detail, finished],
    );
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
