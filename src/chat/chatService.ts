import type Anthropic from "@anthropic-ai/sdk";
import type { DomainConfig } from "../config/domains.js";
import type { CapabilityRegistry, CapabilityRow } from "../domain/capabilityRegistry.js";
import type { CredentialStore } from "../domain/credentialStore.js";
import type { MemoryStore } from "../domain/memoryStore.js";
import type { RelationsStore } from "../domain/relationsStore.js";

/** Narrowed to exactly what this file calls, so tests can inject a fake without mocking the whole SDK. */
export interface AnthropicMessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export interface ChatToolCall {
  capability: string;
  ok: boolean;
  summary: string; // operational only — never echoes raw domain content back out of this module
}

export interface ChatTurnResult {
  reply: string;
  toolCalls: ChatToolCall[];
}

const MAX_TOOL_ITERATIONS = 8;
const DEFAULT_MAX_TOKENS = 4096;

/**
 * One per domain, wired with that domain's own registry/credentials/
 * memory/relations — structurally identical to Reviewer/SelfHeal/
 * SecurityAccess. The Anthropic client itself is shared across domains
 * (it's a stateless reasoning layer, holds no domain content — see
 * docs/architecture.md), but conversation history, retrieved memory, and
 * which capabilities are even visible as tools are all domain-scoped and
 * never cross between two ChatService instances.
 *
 * Conversation history lives in memory only (per session id), same v1
 * limitation as ApprovalGate: lost on restart, fine for a single
 * self-hosted instance.
 */
export class ChatService {
  private readonly histories = new Map<string, Anthropic.MessageParam[]>();

  constructor(
    private readonly config: DomainConfig,
    private readonly anthropic: AnthropicMessagesClient,
    private readonly registry: CapabilityRegistry,
    private readonly credentials: CredentialStore,
    private readonly memory: MemoryStore,
    private readonly relations: RelationsStore,
    private readonly model: string,
    private readonly maxTokens: number = DEFAULT_MAX_TOKENS,
  ) {}

  async converse(sessionId: string, userMessage: string): Promise<ChatTurnResult> {
    const history = this.histories.get(sessionId) ?? [];
    history.push({ role: "user", content: userMessage });

    const enabledCapabilities = await this.registry.list({ enabledOnly: true });
    const capabilitiesByName = new Map(enabledCapabilities.map((c) => [c.name, c]));
    const tools = buildTools(enabledCapabilities);

    const { context: memoryContext, hitIds: retrievedMemoryIds } = await this.retrieveMemoryContext(userMessage);
    const system = buildSystemPrompt(this.config, enabledCapabilities) + memoryContext;

    const toolCalls: ChatToolCall[] = [];
    let finalText = "";

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const response = await this.anthropic.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        system,
        tools,
        messages: history,
      });

      history.push({ role: "assistant", content: response.content });

      if (response.stop_reason !== "tool_use") {
        finalText = extractText(response.content);
        break;
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        const outcome = await this.runCapability(capabilitiesByName.get(block.name), block.name, block.input);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: outcome.content, is_error: !outcome.ok });
        toolCalls.push({ capability: block.name, ok: outcome.ok, summary: outcome.summary });
      }
      history.push({ role: "user", content: toolResults });
    }

    this.histories.set(sessionId, history);
    await this.persistInteraction(userMessage, finalText, sessionId, retrievedMemoryIds);

    return { reply: finalText, toolCalls };
  }

  private async runCapability(
    row: CapabilityRow | undefined,
    name: string,
    input: unknown,
  ): Promise<{ ok: boolean; content: string; summary: string }> {
    if (!row) {
      return { ok: false, content: `unknown capability "${name}"`, summary: `unknown capability "${name}"` };
    }
    try {
      const credential = row.credentialRef ? this.credentials.get(row.credentialRef) : null;
      const module = await this.registry.loadModule(row);
      const result = await module.handle(input, { credential });
      return { ok: true, content: JSON.stringify(result), summary: `handled by ${row.name}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, content: message, summary: `${row.name} failed: ${message}` };
    }
  }

  private async retrieveMemoryContext(query: string): Promise<{ context: string; hitIds: string[] }> {
    try {
      const hits = await this.memory.search(query, 5);
      if (hits.length === 0) return { context: "", hitIds: [] };
      const context = "\n\nRelevant prior context:\n" + hits.map((h) => `- ${h.content}`).join("\n");
      return { context, hitIds: hits.map((h) => h.id) };
    } catch {
      // No embedding provider configured — chat still works, just without recall.
      return { context: "", hitIds: [] };
    }
  }

  /**
   * Writes this turn to memory and — per CLAUDE.md's "batch/scheduled
   * only" rule — batch-writes INFERRED relations to whatever memory was
   * retrieved as context, all in one write after the interaction. Never a
   * live/mid-conversation single relation write.
   */
  private async persistInteraction(
    userMessage: string,
    reply: string,
    sessionId: string,
    relatedMemoryIds: string[],
  ): Promise<void> {
    try {
      const newMemoryId = await this.memory.write(`user: ${userMessage}\nassistant: ${reply}`, {
        source: "chat",
        metadata: { sessionId },
      });
      if (relatedMemoryIds.length > 0) {
        await this.relations.writeBatch(
          relatedMemoryIds.map((toMemory) => ({
            fromMemory: newMemoryId,
            toMemory,
            relationType: "references",
            confidence: "INFERRED",
            writtenBy: "chat_session",
          })),
        );
      }
    } catch {
      // No embedding provider configured — reply still returns, just isn't persisted to memory.
    }
  }
}

function buildTools(capabilities: CapabilityRow[]): Anthropic.Tool[] {
  return capabilities.map((c) => ({
    name: c.name,
    description: c.systemPrompt ?? `Capability "${c.name}"`,
    input_schema: {
      type: "object",
      properties: {
        intent: { type: "string", description: "which action within this capability to perform" },
        payload: { type: "object", description: "action-specific parameters" },
      },
      required: ["intent", "payload"],
    },
  }));
}

function buildSystemPrompt(config: DomainConfig, capabilities: CapabilityRow[]): string {
  const capList =
    capabilities.length > 0
      ? capabilities.map((c) => `- ${c.name}: ${c.systemPrompt ?? "no description"}`).join("\n")
      : "(no capabilities enabled)";
  return (
    `You are JARVIS, a personal AI assistant. You are operating strictly within the "${config.label}" domain ` +
    `right now — there is no "other domain" from your perspective in this conversation; you only know this ` +
    `one exists, and you must never claim or imply access to data, credentials, or capabilities outside it.\n\n` +
    `Capabilities available in this domain:\n${capList}`
  );
}

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
