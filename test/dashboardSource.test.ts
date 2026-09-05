import { describe, expect, it } from "vitest";
import type pg from "pg";
import { DOMAINS, type DomainId } from "../src/config/domains.js";
import { ChatHistoryStore } from "../src/domain/chatHistoryStore.js";
import { ApprovalGate, type ApprovalNotifier } from "../src/core/approvalGate.js";
import { OperationalBus } from "../src/orchestrator/operationalBus.js";
import { ContentBus } from "../src/orchestrator/contentBus.js";
import { createDashboardSource } from "../src/orchestrator/dashboardSource.js";
import type { DomainManager } from "../src/orchestrator/domainManager.js";

/**
 * Same in-memory pg.Pool stand-in as test/chatHistoryStore.test.ts (kept
 * local/minimal here rather than shared, since this file only needs the
 * insert/select-latest/delete shapes ChatHistoryStore issues) — keyed by the
 * schema-qualified table name literally present in the SQL text.
 */
interface FakeRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  attachments: unknown;
  created_at: string;
}

function makeFakePool(): pg.Pool & { tables: Map<string, FakeRow[]> } {
  const tables = new Map<string, FakeRow[]>();
  let seq = 0;

  function tableFor(sql: string): FakeRow[] {
    const m = sql.match(/(work|personal)\.chat_history/);
    if (!m) throw new Error(`fake pool: could not determine table from SQL: ${sql}`);
    if (!tables.has(m[0])) tables.set(m[0], []);
    return tables.get(m[0])!;
  }

  function sortedDesc(rows: FakeRow[]): FakeRow[] {
    return [...rows].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  }

  async function query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
    const rows = tableFor(sql);
    if (sql.includes("select conversation_id, created_at")) {
      return { rows: sortedDesc(rows).slice(0, 1) };
    }
    if (sql.trim().startsWith("insert into")) {
      const [conversationId, role, content, attachments] = params as [string, string, string, string];
      seq += 1;
      rows.push({ id: `row-${seq}`, conversation_id: conversationId, role, content, attachments: JSON.parse(attachments), created_at: new Date(Date.now() + seq).toISOString() });
      return { rows: [] };
    }
    if (sql.trim().startsWith("delete from")) {
      const offset = params[0] as number;
      const keepIds = new Set(sortedDesc(rows).slice(0, offset).map((r) => r.id));
      const remaining = rows.filter((r) => keepIds.has(r.id));
      rows.length = 0;
      rows.push(...remaining);
      return { rows: [] };
    }
    if (sql.includes("select role, content, attachments, created_at")) {
      const limit = params[0] as number;
      return { rows: sortedDesc(rows).slice(0, limit) };
    }
    if (sql.includes("select role, content, attachments")) {
      const [conversationId, limit] = params as [string, number];
      return { rows: sortedDesc(rows.filter((r) => r.conversation_id === conversationId)).slice(0, limit) };
    }
    throw new Error(`fake pool: unrecognized SQL: ${sql}`);
  }

  return { tables, query } as unknown as pg.Pool & { tables: Map<string, FakeRow[]> };
}

function noopNotifier(): ApprovalNotifier {
  return { notify: async () => {} };
}

/** A minimal stand-in for DomainManager exposing only what createDashboardSource actually touches. */
function makeFakeManager(pool: pg.Pool): DomainManager {
  const chatHistory = new ChatHistoryStore(DOMAINS.work, pool);
  const approvals = new ApprovalGate(noopNotifier());
  const fake = {
    bus: new OperationalBus(),
    contentBus: new ContentBus(),
    get: (domainId: DomainId) => {
      if (domainId !== "work") throw new Error(`fake manager only wired for "work" in this test`);
      return { chatHistory, approvals };
    },
  };
  return fake as unknown as DomainManager;
}

describe("createDashboardSource: recentChatContext is genuinely conversation-scoped (Tester HIGH #1 repro, against the REAL ChatHistoryStore)", () => {
  it("a message from a 30h-old conversation never appears in a new conversation's context, even though it still appears in display history", async () => {
    const pool = makeFakePool();
    const manager = makeFakeManager(pool);
    const source = createDashboardSource(manager);

    // Seed an old conversation directly at the pool level, 30h in the past
    // (past the 24h idle boundary), containing a literal PII string.
    const oldConversationId = "11111111-1111-1111-1111-111111111111";
    pool.tables.set("work.chat_history", [
      {
        id: "seed-1",
        conversation_id: oldConversationId,
        role: "user",
        content: "my SSN is 123-45-6789",
        attachments: [],
        created_at: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
      },
      {
        id: "seed-2",
        conversation_id: oldConversationId,
        role: "assistant",
        content: "noted, from 30h ago",
        attachments: [],
        created_at: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
      },
    ]);

    // This is exactly what server.ts calls BEFORE persisting the new turn.
    const context = await source.recentChatContext("work", 20);
    expect(context).toEqual([]);
    expect(JSON.stringify(context)).not.toContain("123-45-6789");

    // Display history (recentChatHistory) still shows the old conversation — unaffected by this fix.
    const display = await source.recentChatHistory("work");
    expect(display.some((m) => m.content.includes("123-45-6789"))).toBe(true);
  });

  it("a message from a conversation still within the 24h window DOES appear in context — the fix scopes to conversation, not to zero context always", async () => {
    const pool = makeFakePool();
    const manager = makeFakeManager(pool);
    const source = createDashboardSource(manager);

    await source.appendChatMessage("work", { role: "user", content: "recent question", attachments: [] });
    await source.appendChatMessage("work", { role: "assistant", content: "recent answer", attachments: [] });

    const context = await source.recentChatContext("work", 20);
    expect(context).toEqual([
      { role: "user", content: "recent question" },
      { role: "assistant", content: "recent answer" },
    ]);
  });
});
