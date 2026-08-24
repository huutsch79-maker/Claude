import type pg from "pg";
import type { DomainConfig } from "../config/domains.js";

export interface ReviewerProposalRow {
  id: string;
  category: string;
  summary: string;
  trustTier: "auto_fix" | "requires_approval";
  status: "pending" | "approved" | "rejected" | "applied";
  createdAt: string;
}

export interface ScriptRunRow {
  id: string;
  scriptName: string;
  args: Record<string, string>;
  trustTier: "auto_fix" | "requires_approval";
  status: "applied" | "pending_approval" | "rejected" | "failed";
  detail: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/**
 * A domain-scoped view into the shared `core` tables (reviewer_proposals,
 * script_runs) — constructed with one domain's own pool/role, and every
 * query filters on `domain = this domain's id` at the application layer.
 *
 * Note: unlike the per-domain schemas, `core` tables are a single shared
 * table grantable to both roles (see db/schema.sql) — the domain filter
 * here is belt-and-braces, not a hard database-enforced boundary the way
 * schema-level isolation is. That's an accepted trade-off because these
 * tables only ever hold operational summaries, never domain content
 * (enforced by what Reviewer/SelfHeal choose to write into `summary` /
 * `detail`, not by anything at the SQL layer). A stricter boundary (e.g.
 * Postgres row-level security keyed on the connecting role) would close
 * that gap if it's ever worth the added complexity.
 */
export class CoreOpsStore {
  constructor(private readonly config: DomainConfig, private readonly pool: pg.Pool) {}

  async listReviewerProposals(status?: ReviewerProposalRow["status"]): Promise<ReviewerProposalRow[]> {
    const params: unknown[] = [this.config.id];
    let where = "domain = $1";
    if (status) {
      params.push(status);
      where += ` and status = $${params.length}`;
    }
    const result = await this.pool.query(
      `select id, category, summary, trust_tier, status, created_at
       from core.reviewer_proposals where ${where} order by created_at desc limit 200`,
      params,
    );
    return result.rows.map((r) => ({
      id: r.id,
      category: r.category,
      summary: r.summary,
      trustTier: r.trust_tier,
      status: r.status,
      createdAt: r.created_at,
    }));
  }

  /**
   * Reviewer proposals are informational findings, not tied to a runnable
   * action (unlike script runs) — this just records that a human looked at
   * it. It never triggers execution of anything.
   */
  async setReviewerProposalStatus(id: string, status: "approved" | "rejected"): Promise<boolean> {
    const result = await this.pool.query(
      `update core.reviewer_proposals set status = $2, resolved_at = now()
       where id = $1 and domain = $3 and status = 'pending'`,
      [id, status, this.config.id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listScriptRuns(limit = 100): Promise<ScriptRunRow[]> {
    const result = await this.pool.query(
      `select id, script_name, args, trust_tier, status, detail, started_at, finished_at
       from core.script_runs where domain = $1 order by started_at desc limit $2`,
      [this.config.id, limit],
    );
    return result.rows.map((r) => ({
      id: r.id,
      scriptName: r.script_name,
      args: r.args,
      trustTier: r.trust_tier,
      status: r.status,
      detail: r.detail,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
    }));
  }
}
