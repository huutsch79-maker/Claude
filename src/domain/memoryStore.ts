import type pg from "pg";
import type { DomainConfig } from "../config/domains.js";
import type { EmbeddingProvider } from "./embeddingProvider.js";

export interface MemoryItem {
  id: string;
  content: string;
  source: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface MemorySearchHit extends MemoryItem {
  distance: number;
}

/**
 * Vector similarity search over one domain's memory table only. The schema
 * name is baked in at construction time from that domain's own
 * DomainConfig — there is no method on this class that accepts a schema
 * name as a parameter, so it cannot be redirected at a call site.
 */
export class MemoryStore {
  private readonly table: string;

  constructor(
    private readonly config: DomainConfig,
    private readonly pool: pg.Pool,
    private readonly embeddings: EmbeddingProvider,
  ) {
    this.table = `${this.config.schema}.memory`;
  }

  async write(content: string, opts: { source?: string; metadata?: Record<string, unknown> } = {}): Promise<string> {
    const embedding = await this.embeddings.embed(content);
    const result = await this.pool.query<{ id: string }>(
      `insert into ${this.table} (content, embedding, source, metadata) values ($1, $2, $3, $4) returning id`,
      [content, toVectorLiteral(embedding), opts.source ?? null, JSON.stringify(opts.metadata ?? {})],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`[${this.config.id}] memory write returned no row`);
    return row.id;
  }

  async search(query: string, limit = 10): Promise<MemorySearchHit[]> {
    const embedding = await this.embeddings.embed(query);
    const result = await this.pool.query<{
      id: string;
      content: string;
      source: string | null;
      metadata: Record<string, unknown>;
      created_at: string;
      distance: number;
    }>(
      `select id, content, source, metadata, created_at, embedding <=> $1 as distance
       from ${this.table}
       order by embedding <=> $1
       limit $2`,
      [toVectorLiteral(embedding), limit],
    );
    return result.rows.map((r) => ({
      id: r.id,
      content: r.content,
      source: r.source,
      metadata: r.metadata,
      createdAt: r.created_at,
      distance: r.distance,
    }));
  }

  /** Used by Reviewer for memory-quality scans — counts only, no content leaves the domain. */
  async countSince(since: Date): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `select count(*)::text as count from ${this.table} where created_at >= $1`,
      [since.toISOString()],
    );
    return Number(result.rows[0]?.count ?? "0");
  }
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
