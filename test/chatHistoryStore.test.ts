import { describe, expect, it } from "vitest";
import type pg from "pg";
import { DOMAINS } from "../src/config/domains.js";
import { CHAT_HISTORY_RETENTION_LIMIT, ChatHistoryStore, type ChatAttachmentMeta } from "../src/domain/chatHistoryStore.js";

interface FakeRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  attachments: unknown;
  created_at: string;
}

interface FakeQueryCall {
  sql: string;
  params: unknown[];
}

/**
 * A minimal in-memory stand-in for pg.Pool that understands exactly the
 * five query shapes ChatHistoryStore issues, keyed by the schema-qualified
 * table name that appears literally in the SQL text (e.g. "work.chat_history"
 * vs "personal.chat_history"). One fake pool instance can back BOTH a work
 * and a personal ChatHistoryStore at once — exactly like one real Postgres
 * instance backs both real schemas — while keeping their rows physically
 * separate, so a cross-domain leak would show up as a real test failure,
 * not just an inspected string.
 */
function makeFakePool(): pg.Pool & { tables: Map<string, FakeRow[]>; calls: FakeQueryCall[] } {
  const tables = new Map<string, FakeRow[]>();
  const calls: FakeQueryCall[] = [];
  let seq = 0;
  const baseTime = Date.now();

  function tableFor(sql: string): FakeRow[] {
    const m = sql.match(/(work|personal)\.chat_history/);
    if (!m) throw new Error(`fake pool: could not determine table from SQL: ${sql}`);
    const key = m[0];
    if (!tables.has(key)) tables.set(key, []);
    return tables.get(key)!;
  }

  function sortedDesc(rows: FakeRow[]): FakeRow[] {
    return [...rows].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  }

  async function query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
    calls.push({ sql, params });
    const rows = tableFor(sql);

    if (sql.includes("select conversation_id, created_at")) {
      return { rows: sortedDesc(rows).slice(0, 1) };
    }
    if (sql.trim().startsWith("insert into")) {
      const [conversationId, role, content, attachments] = params as [string, string, string, string];
      seq += 1;
      rows.push({
        id: `row-${seq}`,
        conversation_id: conversationId,
        role,
        content,
        attachments: JSON.parse(attachments),
        created_at: new Date(baseTime + seq).toISOString(),
      });
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
      const filtered = rows.filter((r) => r.conversation_id === conversationId);
      return { rows: sortedDesc(filtered).slice(0, limit) };
    }
    throw new Error(`fake pool: unrecognized SQL: ${sql}`);
  }

  return { tables, calls, query } as unknown as pg.Pool & { tables: Map<string, FakeRow[]>; calls: FakeQueryCall[] };
}

function meta(filename: string, sizeBytes = 100): ChatAttachmentMeta {
  return { filename, mediaType: "image/png", sizeBytes };
}

describe("chat history store isolation", () => {
  it("work and personal ChatHistoryStore instances write to disjoint tables, even sharing one underlying pool", async () => {
    const pool = makeFakePool();
    const workStore = new ChatHistoryStore(DOMAINS.work, pool);
    const personalStore = new ChatHistoryStore(DOMAINS.personal, pool);

    const workConvo = await workStore.currentConversationId();
    const personalConvo = await personalStore.currentConversationId();
    await workStore.append(workConvo, "user", "work-only secret content", []);
    await personalStore.append(personalConvo, "user", "personal-only secret content", []);

    expect(pool.tables.get("work.chat_history")!.map((r) => r.content)).toEqual(["work-only secret content"]);
    expect(pool.tables.get("personal.chat_history")!.map((r) => r.content)).toEqual(["personal-only secret content"]);

    // Every query this store ever issues is scoped to its own schema —
    // never the other domain's table name, even by substring.
    const workQueries = pool.calls.filter((c) => c.sql.includes("work.chat_history") || c.sql.includes("personal.chat_history"));
    for (const call of workQueries) {
      const mentionsWork = call.sql.includes("work.chat_history");
      const mentionsPersonal = call.sql.includes("personal.chat_history");
      expect(mentionsWork && mentionsPersonal).toBe(false); // never both in one query
    }
  });

  it("recentForDisplay never returns the other domain's rows", async () => {
    const pool = makeFakePool();
    const workStore = new ChatHistoryStore(DOMAINS.work, pool);
    const personalStore = new ChatHistoryStore(DOMAINS.personal, pool);

    await workStore.append(await workStore.currentConversationId(), "user", "work msg", []);
    await personalStore.append(await personalStore.currentConversationId(), "user", "personal msg", []);

    const workHistory = await workStore.recentForDisplay();
    const personalHistory = await personalStore.recentForDisplay();

    expect(workHistory.map((m) => m.content)).toEqual(["work msg"]);
    expect(personalHistory.map((m) => m.content)).toEqual(["personal msg"]);
  });

  it("work and personal domain configs use disjoint schemas (same disjointness credentialStore's isolation relies on)", () => {
    expect(DOMAINS.work.schema).not.toBe(DOMAINS.personal.schema);
  });
});

describe("chat history store: trim-on-write", () => {
  it("caps storage at CHAT_HISTORY_RETENTION_LIMIT rows after a burst of writes past the limit", async () => {
    const pool = makeFakePool();
    const store = new ChatHistoryStore(DOMAINS.work, pool);
    const conversationId = await store.currentConversationId();

    const burst = CHAT_HISTORY_RETENTION_LIMIT + 50;
    for (let i = 0; i < burst; i++) {
      await store.append(conversationId, "user", `message ${i}`, []);
    }

    const rows = pool.tables.get("work.chat_history")!;
    expect(rows.length).toBe(CHAT_HISTORY_RETENTION_LIMIT);

    // Trim keeps the MOST RECENT rows, not the oldest.
    const display = await store.recentForDisplay(CHAT_HISTORY_RETENTION_LIMIT);
    expect(display[display.length - 1]!.content).toBe(`message ${burst - 1}`);
    expect(display[0]!.content).toBe(`message ${burst - CHAT_HISTORY_RETENTION_LIMIT}`);
  });

  it("never exceeds the cap even one row past the boundary", async () => {
    const pool = makeFakePool();
    const store = new ChatHistoryStore(DOMAINS.work, pool);
    const conversationId = await store.currentConversationId();

    for (let i = 0; i < CHAT_HISTORY_RETENTION_LIMIT + 1; i++) {
      await store.append(conversationId, "user", `m${i}`, []);
    }
    expect(pool.tables.get("work.chat_history")!.length).toBe(CHAT_HISTORY_RETENTION_LIMIT);
  });
});

describe("chat history store: attachment persistence is metadata-only", () => {
  it("append() sends only whitelisted metadata fields to the pool-write call — asserted on the exact params, not just the return value", async () => {
    const pool = makeFakePool();
    const store = new ChatHistoryStore(DOMAINS.work, pool);
    const conversationId = await store.currentConversationId();

    await store.append(conversationId, "user", "see attached", [meta("photo.png", 2048)]);

    const insertCall = pool.calls.find((c) => c.sql.trim().startsWith("insert into"));
    expect(insertCall).toBeDefined();
    const attachmentsParam = insertCall!.params[3] as string;
    const parsed = JSON.parse(attachmentsParam) as Record<string, unknown>[];
    expect(parsed).toHaveLength(1);
    expect(Object.keys(parsed[0]!).sort()).toEqual(["filename", "mediaType", "sizeBytes"].sort());
    expect(parsed[0]).toEqual({ filename: "photo.png", mediaType: "image/png", sizeBytes: 2048 });

    // No raw byte/base64 content anywhere in what was actually sent to the pool.
    expect(insertCall!.params.every((p) => typeof p !== "string" || !/^[A-Za-z0-9+/]{100,}={0,2}$/.test(p))).toBe(true);
  });
});

describe("chat history store: conversation continuity", () => {
  it("reuses the most recent conversation when its last message is recent", async () => {
    const pool = makeFakePool();
    const store = new ChatHistoryStore(DOMAINS.work, pool);
    const first = await store.currentConversationId();
    await store.append(first, "user", "hi", []);
    const second = await store.currentConversationId();
    expect(second).toBe(first);
  });

  it("recentForContext only returns the current conversation, oldest-first", async () => {
    const pool = makeFakePool();
    const store = new ChatHistoryStore(DOMAINS.work, pool);
    const convo = await store.currentConversationId();
    await store.append(convo, "user", "a", []);
    await store.append(convo, "assistant", "b", []);
    const context = await store.recentForContext();
    expect(context.map((m) => m.content)).toEqual(["a", "b"]);
  });
});
