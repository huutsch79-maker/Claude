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

/** Read/write access to jarvis.reviewer_proposals and jarvis.script_runs. */
export class CoreOpsStore {
  constructor(private readonly pool: pg.Pool) {}

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
