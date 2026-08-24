import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { ChatService, type AnthropicMessagesClient, type SelfHealRunner } from "../src/chat/chatService.js";
import { CapabilityRegistry, type CapabilityModule, type CapabilityRow } from "../src/domain/capabilityRegistry.js";
import { CredentialStore } from "../src/domain/credentialStore.js";
import { MemoryStore } from "../src/domain/memoryStore.js";
import { RelationsStore } from "../src/domain/relationsStore.js";
import type { EmbeddingProvider } from "../src/domain/embeddingProvider.js";

function capabilityRow(overrides: Partial<CapabilityRow> = {}): CapabilityRow {
  return {
    id: "cap-1",
    name: "test-capability",
    category: "personal",
    enabled: true,
    priority: 100,
    schemaDef: {},
    systemPrompt: "A test capability.",
    toolConfig: {},
    modelOverride: null,
    credentialRef: null,
    modulePath: "hotmail", // unused once loadModule is stubbed
    ...overrides,
  };
}

function textMessage(text: string): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
  } as Anthropic.Message;
}

function toolUseMessage(id: string, name: string, input: unknown): Anthropic.Message {
  return {
    id: "msg_tool",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: [{ type: "tool_use", id, name, input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
  } as Anthropic.Message;
}

function fakeAnthropic(responses: Anthropic.Message[]): AnthropicMessagesClient & { calls: unknown[] } {
  const calls: unknown[] = [];
  let i = 0;
  return {
    calls,
    messages: {
      create: vi.fn(async (params) => {
        // Snapshot: `params.messages` is the ChatService's live, mutable
        // history array (by reference) — record what it looked like *now*,
        // not whatever it grows into by the time a test inspects `calls`.
        calls.push(structuredClone(params));
        const response = responses[i];
        if (!response) throw new Error("fakeAnthropic ran out of scripted responses");
        i++;
        return response;
      }),
    },
  };
}

function fakeSelfHeal(): SelfHealRunner & { runScript: ReturnType<typeof vi.fn> } {
  return { runScript: vi.fn(async () => ({ status: "applied" as const })) };
}

function buildHarness(anthropicResponses: Anthropic.Message[], selfHeal = fakeSelfHeal()) {
  const pool = {} as never;
  const registry = new CapabilityRegistry(pool);
  const credentials = new CredentialStore({} as NodeJS.ProcessEnv);
  const memory = new MemoryStore(pool, {
    embed: async () => {
      throw new Error("no embedding provider configured");
    },
  } as EmbeddingProvider);
  const relations = new RelationsStore(pool);

  const listSpy = vi.fn(async () => [capabilityRow()]);
  registry.list = listSpy as never;

  const memoryWriteSpy = vi.fn(async () => "mem-id-1");
  memory.write = memoryWriteSpy as never;

  const relationsBatchSpy = vi.fn(async () => undefined);
  relations.writeBatch = relationsBatchSpy as never;

  const anthropic = fakeAnthropic(anthropicResponses);
  const chat = new ChatService(anthropic, registry, credentials, memory, relations, selfHeal, "claude-opus-5");

  return { chat, anthropic, registry, memory, selfHeal, memoryWriteSpy, relationsBatchSpy, listSpy };
}

describe("ChatService", () => {
  it("returns Claude's text reply directly when no tool is used", async () => {
    const { chat } = buildHarness([textMessage("Hello there!")]);
    const result = await chat.converse("session-1", "hi");
    expect(result.reply).toBe("Hello there!");
    expect(result.toolCalls).toEqual([]);
    expect(result.widgets).toEqual([]);
  });

  it("degrades gracefully when memory/embedding isn't configured (no crash, no recall)", async () => {
    const { chat, memoryWriteSpy } = buildHarness([textMessage("still works")]);
    const result = await chat.converse("session-1", "hi");
    expect(result.reply).toBe("still works");
    // memory.write itself is stubbed to succeed, but memory.search (unstubbed,
    // real embed() throws) must not propagate — the turn still completes.
    expect(memoryWriteSpy).toHaveBeenCalled();
  });

  it("routes a tool_use call to the matching capability and feeds the result back", async () => {
    const { chat, registry } = buildHarness([
      toolUseMessage("tu_1", "test-capability", { intent: "do.thing", payload: {} }),
      textMessage("done"),
    ]);
    const fakeModule: CapabilityModule = {
      canHandle: () => true,
      handle: vi.fn(async () => ({ ok: true })),
    };
    registry.loadModule = vi.fn(async () => fakeModule) as never;

    const result = await chat.converse("session-1", "please do the thing");
    expect(result.reply).toBe("done");
    expect(result.toolCalls).toEqual([{ capability: "test-capability", ok: true, summary: "handled by test-capability" }]);
    expect(fakeModule.handle).toHaveBeenCalledWith({ intent: "do.thing", payload: {} }, { credential: null });
  });

  it("records a failed tool call (e.g. missing credential) without crashing the turn", async () => {
    const { chat, registry } = buildHarness([
      toolUseMessage("tu_1", "test-capability", { intent: "x", payload: {} }),
      textMessage("sorry, that failed"),
    ]);
    registry.loadModule = vi.fn(async () => {
      throw new Error("no credential configured");
    }) as never;

    const result = await chat.converse("session-1", "do it");
    expect(result.toolCalls).toEqual([
      { capability: "test-capability", ok: false, summary: "test-capability failed: no credential configured" },
    ]);
    expect(result.reply).toBe("sorry, that failed");
  });

  it("marks an unrecognized tool name as a tool_result error rather than throwing", async () => {
    const { chat } = buildHarness([toolUseMessage("tu_1", "not-a-real-capability", {}), textMessage("ok")]);
    const result = await chat.converse("session-1", "hi");
    expect(result.toolCalls).toEqual([
      { capability: "not-a-real-capability", ok: false, summary: 'unknown capability "not-a-real-capability"' },
    ]);
  });

  it("keeps conversation history across calls with the same session id", async () => {
    const { chat, anthropic } = buildHarness([textMessage("first"), textMessage("second")]);
    await chat.converse("session-1", "one");
    await chat.converse("session-1", "two");
    const secondCallParams = anthropic.calls[1] as Anthropic.MessageCreateParamsNonStreaming;
    // history should carry: user "one", assistant "first", user "two"
    expect(secondCallParams.messages).toHaveLength(3);
  });

  it("stops after the iteration cap instead of looping forever on repeated tool_use", async () => {
    const { chat, registry } = buildHarness(Array.from({ length: 10 }, () => toolUseMessage("tu", "test-capability", {})));
    registry.loadModule = vi.fn(async () => ({ canHandle: () => true, handle: async () => "ok" })) as never;
    const result = await chat.converse("session-1", "loop forever");
    expect(result.reply).toBe(""); // never reached end_turn
    expect(result.toolCalls.length).toBe(8); // MAX_TOOL_ITERATIONS
  });

  it("captures a render_chart tool call as a widget instead of dispatching to a capability", async () => {
    const { chat, registry } = buildHarness([
      toolUseMessage("tu_1", "render_chart", { title: "VM CPU", chartType: "bar", series: [{ label: "vm1", value: 42 }] }),
      textMessage("here's the CPU usage"),
    ]);
    const loadModuleSpy = vi.fn();
    registry.loadModule = loadModuleSpy as never;

    const result = await chat.converse("session-1", "show me VM performance");
    expect(result.widgets).toEqual([
      { type: "chart", title: "VM CPU", chartType: "bar", series: [{ label: "vm1", value: 42 }], unit: undefined },
    ]);
    expect(result.toolCalls).toEqual([]); // render tools aren't capability dispatches
    expect(loadModuleSpy).not.toHaveBeenCalled();
  });

  it("captures a render_list tool call as a widget", async () => {
    const { chat } = buildHarness([
      toolUseMessage("tu_1", "render_list", { title: "Recent mail", items: [{ primary: "Hi there" }] }),
      textMessage("here's your mail"),
    ]);
    const result = await chat.converse("session-1", "what's my last mail");
    expect(result.widgets).toEqual([{ type: "list", title: "Recent mail", items: [{ primary: "Hi there" }] }]);
  });

  it("rejects an unsupported attachment type before calling the API", async () => {
    const { chat, anthropic } = buildHarness([textMessage("unused")]);
    await expect(
      chat.converse("session-1", "look at this", [{ mediaType: "application/zip", base64Data: "AAAA" }]),
    ).rejects.toThrow(/unsupported attachment type/);
    expect(anthropic.calls).toHaveLength(0);
  });

  it("builds a multi-block user message for a supported image attachment", async () => {
    const { chat, anthropic } = buildHarness([textMessage("nice photo")]);
    await chat.converse("session-1", "what is this", [{ mediaType: "image/png", base64Data: "AAAA", filename: "x.png" }]);
    const params = anthropic.calls[0] as Anthropic.MessageCreateParamsNonStreaming;
    const content = params.messages[0]!.content as Anthropic.ContentBlockParam[];
    expect(content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
    expect(content[1]).toMatchObject({ type: "text", text: "what is this" });
  });

  it("runs an auto_fix script immediately via the run_script tool", async () => {
    const selfHeal = fakeSelfHeal();
    const { chat } = buildHarness(
      [toolUseMessage("tu_1", "run_script", { name: "vacuum-analyze" }), textMessage("done, vacuumed the tables")],
      selfHeal,
    );
    const result = await chat.converse("session-1", "clean up the database");
    expect(selfHeal.runScript).toHaveBeenCalledWith("vacuum-analyze", {});
    expect(result.toolCalls).toEqual([{ capability: "run_script:vacuum-analyze", ok: true, summary: 'ran script "vacuum-analyze"' }]);
    expect(result.reply).toBe("done, vacuumed the tables");
  });

  it("queues a requires_approval script without treating it as already applied", async () => {
    const selfHeal: SelfHealRunner & { runScript: ReturnType<typeof vi.fn> } = {
      runScript: vi.fn(async () => ({ status: "pending_approval" as const, approvalId: "appr-1" })),
    };
    const { chat } = buildHarness(
      [
        toolUseMessage("tu_1", "run_script", { name: "apply-migration", args: { file: "001.sql" } }),
        textMessage("I've queued that migration — it needs your approval in the dashboard first"),
      ],
      selfHeal,
    );
    const result = await chat.converse("session-1", "apply migration 001.sql");
    expect(selfHeal.runScript).toHaveBeenCalledWith("apply-migration", { file: "001.sql" });
    expect(result.toolCalls).toEqual([
      { capability: "run_script:apply-migration", ok: true, summary: 'queued script "apply-migration" for approval' },
    ]);
  });

  it("reports a failed script run as a tool_result error without crashing the turn", async () => {
    const selfHeal: SelfHealRunner & { runScript: ReturnType<typeof vi.fn> } = {
      runScript: vi.fn(async () => {
        throw new Error('unknown script "not-real" — scripts must be registered in code');
      }),
    };
    const { chat } = buildHarness(
      [toolUseMessage("tu_1", "run_script", { name: "not-real" }), textMessage("sorry, that script doesn't exist")],
      selfHeal,
    );
    const result = await chat.converse("session-1", "run not-real");
    expect(result.toolCalls).toEqual([
      {
        capability: "run_script:not-real",
        ok: false,
        summary: 'script "not-real" failed: unknown script "not-real" — scripts must be registered in code',
      },
    ]);
  });
});
