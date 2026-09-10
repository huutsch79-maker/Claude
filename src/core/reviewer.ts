import type pg from "pg";
import type { DomainConfig } from "../config/domains.js";
import type { CapabilityRegistry } from "../domain/capabilityRegistry.js";
import type { MemoryStore } from "../domain/memoryStore.js";
import type { AccessAuditFinding, SecurityAccess } from "./security.js";
import { classifyTrustTier, type SelfHealActionKind } from "./trustTiers.js";

/**
 * Error counts for the last 24h, plus whether anything actually counted
 * them.
 *
 * `measured: false` exists because the orchestrator can run with no error
 * source wired up, and a hardcoded `{transient24h: 0, fatal24h: 0}` is
 * indistinguishable on the wire from a genuinely quiet day. The zero was
 * being printed every five minutes as though it were a measurement. When
 * `measured` is false the two counts are placeholders and must not be
 * rendered or reasoned about as data.
 */
export interface ErrorLogCounts {
  measured: boolean;
  transient24h: number;
  fatal24h: number;
}

export interface Proposal {
  /** Populated by persist() from the database's generated id, so a proposal can be referred to after the cycle that made it. */
  id?: string;
  category: "registry_health" | "memory_quality" | "error_log";
  summary: string; // operational description only, never domain content
  trustTier: "auto_fix" | "requires_approval";
  suggestedAction?: SelfHealActionKind;
}

/**
 * Runs on a schedule (see orchestrator/scheduler.ts), inspects this
 * domain's own registry health, memory quality, and error logs, and
 * produces proposals. Never applies anything itself — even auto-fix-tier
 * proposals are handed to SelfHeal to actually execute, so "the reviewer
 * finds problems, self-heal fixes them" stays a clean separation.
 */
export class Reviewer {
  constructor(
    private readonly config: DomainConfig,
    private readonly pool: pg.Pool,
    private readonly registry: CapabilityRegistry,
    private readonly memory: MemoryStore,
    private readonly security: SecurityAccess,
  ) {}

  async runCycle(errorLog: ErrorLogCounts): Promise<Proposal[]> {
    const proposals: Proposal[] = [];

    proposals.push(...(await this.reviewRegistryHealth()));
    proposals.push(...(await this.reviewMemoryQuality()));
    proposals.push(...this.reviewErrorLog(errorLog));

    await this.persistAll(proposals);
    return proposals;
  }

  private async reviewRegistryHealth(): Promise<Proposal[]> {
    const proposals: Proposal[] = [];

    const { capabilityCount, auditedRefCount, findings } = await this.security.auditCredentials();

    // An empty registry is the most severe registry finding there is, not an
    // exempt one. This check used to be guarded by `capabilities.length > 0`,
    // which meant the watchdog for a failed seed stayed silent in precisely
    // the case it existed to catch — and did, for four days in production.
    if (capabilityCount === 0) {
      proposals.push({
        category: "registry_health",
        summary: "capability registry is empty — nothing is registered to run (seed may have failed)",
        trustTier: "requires_approval",
      });
    } else {
      const capabilities = await this.registry.list();
      const enabledCount = capabilities.filter((c) => c.enabled).length;
      if (enabledCount === 0) {
        proposals.push({
          category: "registry_health",
          summary: `all ${capabilityCount} registered capabilities are disabled`,
          trustTier: "requires_approval",
        });
      }

      // Capabilities exist but not one names a credential. Either a real
      // misconfiguration or schema drift (a renamed/dropped credential_ref
      // column reads as null for every row) — and the second silently turns
      // off credential auditing for this domain only, which then looks like
      // a legitimate difference between work and personal rather than a bug.
      if (auditedRefCount === 0) {
        proposals.push({
          category: "registry_health",
          summary: `${capabilityCount} capabilities registered but none references a credential — nothing is being audited for expiry`,
          trustTier: "requires_approval",
        });
      }
    }

    for (const finding of findings) {
      proposals.push(this.proposalForFinding(finding));
    }
    return proposals;
  }

  /**
   * Exhaustive over AccessAuditFinding["issue"]. The `default` throw is the
   * point: a fifth issue kind added later fails loudly here instead of being
   * computed by the auditor and silently dropped on the floor, which is what
   * happened to `unused_by_any_enabled_capability` for the whole of v2.
   */
  private proposalForFinding(finding: AccessAuditFinding): Proposal {
    switch (finding.issue) {
      case "expired":
      case "referenced_but_missing":
        return {
          category: "registry_health",
          summary: `credential "${finding.credentialRef}" is ${finding.issue.replace(/_/g, " ")}`,
          trustTier: classifyTrustTier("credential_rotation"),
        };
      case "expiring_soon":
        return {
          category: "registry_health",
          summary: `credential "${finding.credentialRef}" expires within 7 days`,
          trustTier: classifyTrustTier("credential_rotation"),
        };
      case "unused_by_any_enabled_capability":
        return {
          category: "registry_health",
          summary: `credential "${finding.credentialRef}" is referenced only by disabled capabilities`,
          trustTier: "requires_approval",
        };
      default: {
        const unhandled: never = finding.issue;
        throw new Error(`unhandled credential audit finding: ${String(unhandled)}`);
      }
    }
  }

  private async reviewMemoryQuality(): Promise<Proposal[]> {
    const proposals: Proposal[] = [];
    const recentCount = await this.memory.countSince(new Date(Date.now() - 24 * 60 * 60 * 1000));
    if (recentCount === 0) {
      proposals.push({
        category: "memory_quality",
        summary: "no memory writes in the last 24h — check whether capabilities are actually running",
        trustTier: "requires_approval",
      });
    }
    return proposals;
  }

  private reviewErrorLog(errorLog: ErrorLogCounts): Proposal[] {
    const proposals: Proposal[] = [];

    // "Nothing is counting errors" is itself worth raising. Comparing a
    // hardcoded zero against a threshold makes both branches below
    // unreachable while looking like a passing check.
    if (!errorLog.measured) {
      proposals.push({
        category: "error_log",
        summary: "no error source is connected — error counts are not being measured",
        trustTier: "requires_approval",
      });
      return proposals;
    }

    if (errorLog.fatal24h > 0) {
      proposals.push({
        category: "error_log",
        summary: `${errorLog.fatal24h} fatal error(s) in the last 24h`,
        trustTier: "requires_approval",
      });
    }
    if (errorLog.transient24h > 10) {
      proposals.push({
        category: "error_log",
        summary: `${errorLog.transient24h} transient errors in the last 24h — above normal threshold`,
        trustTier: classifyTrustTier("transient_api_retry"),
        suggestedAction: "transient_api_retry",
      });
    }
    return proposals;
  }

  /**
   * One transaction for the whole cycle. Persisting row-by-row meant a
   * failure partway through committed an arbitrary prefix of the findings
   * and then threw away the rest of the analysis, leaving the table holding
   * a truncated cycle with nothing marking it as truncated.
   *
   * `returning id` back-fills each proposal's id so a proposal can still be
   * referred to after the cycle — without it the generated uuid was
   * discarded at the moment of insert, which is what made it impossible to
   * hand a proposal to the approval gate.
   */
  private async persistAll(proposals: Proposal[]): Promise<void> {
    if (proposals.length === 0) return;

    const values: unknown[] = [];
    const rows = proposals.map((proposal, i) => {
      const base = i * 4;
      values.push(this.config.id, proposal.category, proposal.summary, proposal.trustTier);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
    });

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await client.query(
        `insert into core.reviewer_proposals (domain, category, summary, trust_tier) ` +
          `values ${rows.join(", ")} returning id`,
        values,
      );
      await client.query("commit");
      result.rows.forEach((row: { id: unknown }, i: number) => {
        const proposal = proposals[i];
        if (proposal) proposal.id = String(row.id);
      });
    } catch (err) {
      try {
        await client.query("rollback");
      } catch (rollbackErr) {
        console.error(`[${this.config.id}] reviewer: rollback failed`, rollbackErr);
      }
      throw err;
    } finally {
      client.release();
    }
  }
}
