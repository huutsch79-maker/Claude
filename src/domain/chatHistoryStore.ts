import * as crypto from "node:crypto";
import type pg from "pg";
import type { DomainConfig } from "../config/domains.js";

export type ChatRole = "user" | "assistant";

/** Metadata only — never raw bytes, never file content/URI. See db/schema.sql chat_history.attachments. */
export interface ChatAttachmentMeta {
  filename: string;
  mediaType: string;
  sizeBytes: number;
}

export interface ChatHistoryEntry {
  role: ChatRole;
  content: string;
  attachments: ChatAttachmentMeta[];
  createdAt: string;
}

/** How long the most recent conversation may sit idle before a new one is minted. */
const CONVERSATION_IDLE_MS = 24 * 60 * 60 * 1000;

/** Upper bound the table is trimmed to after every append — see trim-on-write below. */
export const CHAT_HISTORY_RETENTION_LIMIT = 500;

/**
 * Per-domain persisted chat history. Schema-qualified at construction from
 * that domain's own DomainConfig, exactly like MemoryStore — there is no
 * method here that accepts a schema name as a parameter, so it cannot be
 * redirected at a call site to another domain's table.
 */
export class ChatHistoryStore {
  private readonly table: string;

  constructor(private readonly config: DomainConfig, private readonly pool: pg.Pool) {
    this.table = `${this.config.schema}.chat_history`;
  }

  /**
   * Reuses the most recent conversation if its last message is under 24h
   * old; otherwise mints a fresh one. Never touches another domain's table
   * — the schema is baked in above.
   */
  async currentConversationId(): Promise<string> {
    const result = await this.pool.query<{ conversation_id: string; created_at: string }>(
      `select conversation_id, created_at from ${this.table} order by created_at desc limit 1`,
    );
    const latest = result.rows[0];
    if (latest) {
      const ageMs = Date.now() - new Date(latest.created_at).getTime();
      if (Number.isFinite(ageMs) && ageMs < CONVERSATION_IDLE_MS) {
        return latest.conversation_id;
      }
    }
    return crypto.randomUUID();
  }

  async append(conversationId: string, role: ChatRole, content: string, attachments: ChatAttachmentMeta[]): Promise<void> {
    await this.pool.query(
      `insert into ${this.table} (conversation_id, role, content, attachments) values ($1, $2, $3, $4)`,
      [conversationId, role, content, JSON.stringify(attachments)],
    );
    // Trim-on-write: no cron job, just keep the most recent
    // CHAT_HISTORY_RETENTION_LIMIT rows for this domain after every write.
    await this.pool.query(
      `delete from ${this.table} where id in (
         select id from ${this.table} order by created_at desc offset $1
       )`,
      [CHAT_HISTORY_RETENTION_LIMIT],
    );
  }

  /** Most recent `limit` messages of the CURRENT conversation only, oldest-first — used to build LLM replay context. */
  async recentForContext(limit = 20): Promise<{ role: ChatRole; content: string; attachments: ChatAttachmentMeta[] }[]> {
    const conversationId = await this.currentConversationId();
    const result = await this.pool.query<{ role: ChatRole; content: string; attachments: ChatAttachmentMeta[] }>(
      `select role, content, attachments from ${this.table} where conversation_id = $1 order by created_at desc limit $2`,
      [conversationId, limit],
    );
    return result.rows.reverse();
  }

  /** Most recent `limit` messages across this domain's ENTIRE retained history, oldest-first — what the page shows on load. */
  async recentForDisplay(limit = CHAT_HISTORY_RETENTION_LIMIT): Promise<ChatHistoryEntry[]> {
    const result = await this.pool.query<{
      role: ChatRole;
      content: string;
      attachments: ChatAttachmentMeta[];
      created_at: string;
    }>(`select role, content, attachments, created_at from ${this.table} order by created_at desc limit $1`, [limit]);
    return result.rows.reverse().map((r) => ({
      role: r.role,
      content: r.content,
      attachments: r.attachments,
      createdAt: r.created_at,
    }));
  }
}
