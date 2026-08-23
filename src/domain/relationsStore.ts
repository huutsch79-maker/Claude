import type pg from "pg";
import type { DomainConfig } from "../config/domains.js";

export type RelationConfidence = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";

export interface RelationWrite {
  fromMemory: string;
  toMemory: string;
  relationType: string;
  confidence: RelationConfidence;
  writtenBy: string;
}

/**
 * Typed edges between memory items, scoped to one domain's schema.
 *
 * Deliberately exposes only `writeBatch` — there is no single-item "write
 * this relation right now" method, because the spec rules out mid-
 * conversation live relation computation for v1. Relations get written
 * after an interaction or on a scheduled pass, always as a batch.
 */
export class RelationsStore {
  private readonly table: string;

  constructor(private readonly config: DomainConfig, private readonly pool: pg.Pool) {
    this.table = `${this.config.schema}.relations`;
  }

  async writeBatch(relations: RelationWrite[]): Promise<void> {
    if (relations.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      for (const r of relations) {
        await client.query(
          `insert into ${this.table} (from_memory, to_memory, relation_type, confidence, written_by)
           values ($1, $2, $3, $4, $5)`,
          [r.fromMemory, r.toMemory, r.relationType, r.confidence, r.writtenBy],
        );
      }
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  }

  async listFor(memoryId: string): Promise<Array<{ id: string; toMemory: string; relationType: string; confidence: RelationConfidence }>> {
    const result = await this.pool.query<{
      id: string;
      to_memory: string;
      relation_type: string;
      confidence: RelationConfidence;
    }>(`select id, to_memory, relation_type, confidence from ${this.table} where from_memory = $1`, [memoryId]);
    return result.rows.map((r) => ({ id: r.id, toMemory: r.to_memory, relationType: r.relation_type, confidence: r.confidence }));
  }
}
