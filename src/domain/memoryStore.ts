import type pg from "pg";
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

/** Vector similarity search over the single unified memory table. */
export class MemoryStore {
  private readonly table = "jarvis.memory";

  constructor(private readonly pool: pg.Pool, private readonly embeddings: EmbeddingProvider) {}

  async write(content: string, opts: { source?: string; metadata?: Record<string, unknown> } = {}): Promise<string> {
    const embedding = await this.embeddings.embed(content);
    const result = await this.pool.query<{ id: string }>(
      `insert into ${this.table} (content, embedding, source, metadata) values ($1, $2, $3, $4) returning id`,
      [content, toVectorLiteral(embedding), opts.source ?? null, JSON.stringify(opts.metadata ?? {})],
    );
    const row = result.rows[0];
    if (!row) throw new Error("memory write returned no row");
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

  /** Used by Reviewer for memory-quality scans — counts only. */
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
