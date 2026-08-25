import type pg from "pg";

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

export interface FailingCapability {
  capability: string;
  count: number;
  latestSummary: string;
}

/** Read/write access to jarvis.reviewer_proposals, jarvis.script_runs, and jarvis.capability_failures. */
export class CoreOpsStore {
  constructor(private readonly pool: pg.Pool) {}

  /** Called by ChatService after a failed capability dispatch — never blocks or throws on the caller's behalf. */
  async recordCapabilityFailure(capability: string, summary: string): Promise<void> {
    await this.pool.query(`insert into jarvis.capability_failures (capability, summary) values ($1, $2)`, [capability, summary]);
  }

  /** Capabilities that failed at least `minCount` times in the last `sinceHours` — what the Reviewer checks each cycle. */
  async listFailingCapabilities(sinceHours = 24, minCount = 3): Promise<FailingCapability[]> {
    const result = await this.pool.query(
      `select capability, count(*)::int as count, (array_agg(summary order by occurred_at desc))[1] as latest_summary
       from jarvis.capability_failures
       where occurred_at > now() - ($1 || ' hours')::interval
       group by capability
       having count(*) >= $2
       order by count desc`,
      [sinceHours, minCount],
    );
    return result.rows.map((r) => ({ capability: r.capability, count: r.count, latestSummary: r.latest_summary }));
  }

  async listReviewerProposals(status?: ReviewerProposalRow["status"]): Promise<ReviewerProposalRow[]> {
    const params: unknown[] = [];
    let where = "";
    if (status) {
      params.push(status);
      where = `where status = $${params.length}`;
    }
    const result = await this.pool.query(
      `select id, category, summary, trust_tier, status, created_at
       from jarvis.reviewer_proposals ${where} order by created_at desc limit 200`,
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
      `update jarvis.reviewer_proposals set status = $2, resolved_at = now()
       where id = $1 and status = 'pending'`,
      [id, status],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listScriptRuns(limit = 100): Promise<ScriptRunRow[]> {
    const result = await this.pool.query(
      `select id, script_name, args, trust_tier, status, detail, started_at, finished_at
       from jarvis.script_runs order by started_at desc limit $1`,
      [limit],
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
