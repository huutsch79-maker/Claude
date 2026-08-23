import type pg from "pg";
import type { DomainConfig } from "../config/domains.js";
import type { CapabilityRegistry } from "../domain/capabilityRegistry.js";
import type { MemoryStore } from "../domain/memoryStore.js";
import type { SecurityAccess } from "./security.js";
import { classifyTrustTier, type SelfHealActionKind } from "./trustTiers.js";

export interface ErrorLogCounts {
  transient24h: number;
  fatal24h: number;
}

export interface Proposal {
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

    for (const proposal of proposals) {
      await this.persist(proposal);
    }
    return proposals;
  }

  private async reviewRegistryHealth(): Promise<Proposal[]> {
    const proposals: Proposal[] = [];

    const capabilities = await this.registry.list();
    const enabledCount = capabilities.filter((c) => c.enabled).length;
    if (capabilities.length > 0 && enabledCount === 0) {
      proposals.push({
        category: "registry_health",
        summary: `all ${capabilities.length} registered capabilities are disabled`,
        trustTier: "requires_approval",
      });
    }

    const { findings } = await this.security.auditCredentials();
    for (const finding of findings) {
      if (finding.issue === "expired" || finding.issue === "referenced_but_missing") {
        proposals.push({
          category: "registry_health",
          summary: `credential "${finding.credentialRef}" is ${finding.issue.replace(/_/g, " ")}`,
          trustTier: classifyTrustTier("credential_rotation"),
        });
      }
      if (finding.issue === "expiring_soon") {
        proposals.push({
          category: "registry_health",
          summary: `credential "${finding.credentialRef}" expires within 7 days`,
          trustTier: classifyTrustTier("credential_rotation"),
        });
      }
    }
    return proposals;
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

  private async persist(proposal: Proposal): Promise<void> {
    await this.pool.query(
      `insert into core.reviewer_proposals (domain, category, summary, trust_tier) values ($1, $2, $3, $4)`,
      [this.config.id, proposal.category, proposal.summary, proposal.trustTier],
    );
  }
}
