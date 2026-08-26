import type Anthropic from "@anthropic-ai/sdk";
import type { CapabilityRegistry, CapabilityRow } from "../domain/capabilityRegistry.js";
import type { CredentialStore, CredentialRecord } from "../domain/credentialStore.js";
import type { MemoryStore } from "../domain/memoryStore.js";
import type { RelationsStore } from "../domain/relationsStore.js";
import { listScripts } from "../core/scriptRegistry.js";

/**
 * Narrowed to exactly what this file calls on OAuthCredentialStore —
 * dynamic, refreshable delegated tokens (Hotmail, NZB mail scopes) live
 * here instead of CredentialStore's static env values. Tried first; a
 * capability whose ref was never connected via OAuth falls through to
 * CredentialStore unchanged, so this is additive, not a replacement.
 */
export interface DelegatedOAuthResolver {
  getValidToken(ref: string): Promise<CredentialRecord | null>;
}

/** Narrowed to exactly what this file calls, so tests can inject a fake without mocking the whole SDK. */
export interface AnthropicMessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

/**
 * Narrowed to exactly what this file calls on SelfHeal — chat only ever
 * runs the bounded, in-code script registry (never a capability, never
 * arbitrary code), and reuses the same trust-tier/approval-gate path the
 * dashboard already uses: an auto_fix script runs immediately, anything
 * requires_approval is queued and only runs once a human approves it via
 * the dashboard (or Pushover) — chat can propose, never self-approve.
 */
export interface SelfHealRunner {
  runScript(
    scriptName: string,
    args?: Record<string, string>,
  ): Promise<{ status: "applied" } | { status: "pending_approval"; approvalId: string }>;
}

/**
 * Narrowed to exactly what this file calls — records a failed capability
 * dispatch so the Reviewer can notice a capability failing repeatedly
 * (see reviewer.ts's reviewCapabilityFailures) rather than only ever
 * seeing one failure at a time in a chat transcript. Best-effort: never
 * allowed to fail the chat turn itself.
 */
export interface CapabilityFailureRecorder {
  recordCapabilityFailure(capability: string, summary: string): Promise<void>;
}

export interface ChatToolCall {
  capability: string;
  ok: boolean;
  summary: string; // operational only — never echoes raw content back out of this module
}

export interface ChatAttachment {
  mediaType: string; // e.g. "image/png", "application/pdf"
  base64Data: string;
  filename?: string;
}

export type ChatWidget =
  | { type: "chart"; title: string; chartType: "bar" | "line"; series: Array<{ label: string; value: number }>; unit?: string }
  | { type: "list"; title: string; items: Array<{ primary: string; secondary?: string; meta?: string }> }
  | { type: "image"; url: string; caption?: string };

export interface ChatTurnResult {
  reply: string;
  toolCalls: ChatToolCall[];
  widgets: ChatWidget[];
}

export type ChatTurnStatus =
  | { state: "idle" }
  | { state: "running" }
  | { state: "done"; result: ChatTurnResult }
  | { state: "error"; message: string };

const MAX_TOOL_ITERATIONS = 8;
const DEFAULT_MAX_TOKENS = 4096;
const SUPPORTED_ATTACHMENT_TYPES = /^image\/(png|jpeg|gif|webp)$|^application\/pdf$/;

/**
 * One JARVIS instance, one conversation. Memory and chat are unified
 * across everything the assistant has access to — there is no per-domain
 * split anymore (see docs/architecture.md for why that changed). What
 * still stays genuinely separate is credentials: each capability still
 * resolves its own credential_ref, so using the NZB connector never touches
 * the Hotmail token or vice versa, regardless of how unified the
 * conversation and memory are.
 *
 * Conversation history lives in memory only (per session id) — a known v1
 * limitation, same as ApprovalGate: lost on restart, fine for a single
 * self-hosted instance.
 */
export class ChatService {
  private readonly histories = new Map<string, Anthropic.MessageParam[]>();

  /**
   * One in-flight turn per session at a time. Without this, a second
   * message arriving for the same session while the first turn is still
   * running (e.g. the user re-sends after their browser/Cloudflare gave up
   * waiting on a slow multi-tool-call turn, while the original turn keeps
   * running server-side — nothing here cancels it just because the client
   * disconnected) reads `history` before the first turn has written its
   * update back, then both turns independently call the same capability
   * against the same external file. That's exactly what produced a real
   * GitHub Contents API 409 (concurrent commits racing on the same file's
   * SHA) on the farm-website module. Queuing per session — not globally —
   * keeps unrelated conversations (there's only ever one here, but this
   * still holds if that changes) from blocking each other.
   */
  private readonly sessionQueues = new Map<string, Promise<unknown>>();

  /**
   * Last known status of a session's most recent turn, for startTurn()/
   * pollTurn() below — the fire-and-poll counterpart to converse(). A
   * multi-tool-call turn (several sequential capability calls, each its
   * own Claude round-trip and external API call) can genuinely take
   * longer than Cloudflare's ~100s edge timeout on a proxied HTTP
   * request; that's not fixable from this side (nothing in a Tunnel's
   * origin config extends the edge's own limit), so instead of holding
   * the HTTP response open for the whole turn, the dashboard starts a
   * turn and polls for its result — no request stays open long enough to
   * hit any timeout, regardless of how many tool calls a turn needs.
   */
  private readonly turnStatus = new Map<string, ChatTurnStatus>();

  constructor(
    private readonly anthropic: AnthropicMessagesClient,
    private readonly registry: CapabilityRegistry,
    private readonly credentials: CredentialStore,
    private readonly memory: MemoryStore,
    private readonly relations: RelationsStore,
    private readonly selfHeal: SelfHealRunner,
    private readonly failureRecorder: CapabilityFailureRecorder,
    private readonly oauth: DelegatedOAuthResolver,
    private readonly model: string,
    private readonly maxTokens: number = DEFAULT_MAX_TOKENS,
  ) {}

  async converse(sessionId: string, userMessage: string, attachments: ChatAttachment[] = []): Promise<ChatTurnResult> {
    const priorTurn = this.sessionQueues.get(sessionId) ?? Promise.resolve();
    const thisTurn = priorTurn.catch(() => {}).then(() => this.converseSerialized(sessionId, userMessage, attachments));
    this.sessionQueues.set(
      sessionId,
      thisTurn.catch(() => {}), // queue tracks completion only, never rejects — a failed turn must not jam the queue for the next one
    );
    return thisTurn;
  }

  /**
   * Fire-and-poll counterpart to converse() — starts a turn (still
   * serialized behind any turn already running for this session, via
   * converse() itself) without making the caller wait for it to finish.
   * Overwrites any previous settled status for this session; a caller
   * that cares about missing a fast turn should poll before starting a
   * new one, not after.
   */
  startTurn(sessionId: string, userMessage: string, attachments: ChatAttachment[] = []): void {
    this.turnStatus.set(sessionId, { state: "running" });
    this.converse(sessionId, userMessage, attachments)
      .then((result) => this.turnStatus.set(sessionId, { state: "done", result }))
      .catch((err) => this.turnStatus.set(sessionId, { state: "error", message: err instanceof Error ? err.message : String(err) }));
  }

  /**
   * Current status of a session's most recent startTurn() call. Reading a
   * settled status ("done"/"error") consumes it — resets to "idle" — so a
   * later poll (e.g. after the user sends a fresh message) doesn't replay
   * a stale result from a previous turn.
   */
  pollTurn(sessionId: string): ChatTurnStatus {
    const status = this.turnStatus.get(sessionId) ?? { state: "idle" };
    if (status.state === "done" || status.state === "error") {
      this.turnStatus.set(sessionId, { state: "idle" });
    }
    return status;
  }

  private async converseSerialized(sessionId: string, userMessage: string, attachments: ChatAttachment[]): Promise<ChatTurnResult> {
    const history = this.histories.get(sessionId) ?? [];
    history.push({ role: "user", content: buildUserContent(userMessage, attachments) });

    const enabledCapabilities = await this.registry.list({ enabledOnly: true });
    const capabilitiesByName = new Map(enabledCapabilities.map((c) => [c.name, c]));
    const tools = [...RENDER_TOOLS, RUN_SCRIPT_TOOL, ...buildCapabilityTools(enabledCapabilities)];

    const { context: memoryContext, hitIds: retrievedMemoryIds } = await this.retrieveMemoryContext(userMessage);
    const system = buildSystemPrompt(enabledCapabilities) + memoryContext;

    const toolCalls: ChatToolCall[] = [];
    const widgets: ChatWidget[] = [];
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

        if (isRenderToolName(block.name)) {
          const widget = renderToolCallToWidget(block.name, block.input);
          widgets.push(widget);
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: "rendered" });
          continue;
        }

        if (block.name === "run_script") {
          const outcome = await this.runScriptTool(block.input);
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: outcome.content, is_error: !outcome.ok });
          toolCalls.push({ capability: `run_script:${outcome.scriptName}`, ok: outcome.ok, summary: outcome.summary });
          continue;
        }

        const outcome = await this.runCapability(capabilitiesByName.get(block.name), block.name, block.input, attachments);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: outcome.content, is_error: !outcome.ok });
        toolCalls.push({ capability: block.name, ok: outcome.ok, summary: outcome.summary });
        if (!outcome.ok) {
          this.failureRecorder.recordCapabilityFailure(block.name, outcome.summary).catch(() => {});
        }
      }
      history.push({ role: "user", content: toolResults });
    }

    this.histories.set(sessionId, history);
    await this.persistInteraction(userMessage, finalText, sessionId, retrievedMemoryIds);

    return { reply: finalText, toolCalls, widgets };
  }

  /** OAuth-connected (Hotmail, NZB mail) first, static JARVIS_CRED_* fallback — see DelegatedOAuthResolver above. */
  private async resolveCredential(ref: string): Promise<CredentialRecord | null> {
    const delegated = await this.oauth.getValidToken(ref);
    return delegated ?? this.credentials.get(ref);
  }

  private async runCapability(
    row: CapabilityRow | undefined,
    name: string,
    input: unknown,
    attachments: ChatAttachment[],
  ): Promise<{ ok: boolean; content: string; summary: string }> {
    if (!row) {
      return { ok: false, content: `unknown capability "${name}"`, summary: `unknown capability "${name}"` };
    }
    try {
      const credential = row.credentialRef ? await this.resolveCredential(row.credentialRef) : null;
      const module = await this.registry.loadModule(row);
      const result = await module.handle(input, { credential, attachments });
      return { ok: true, content: JSON.stringify(result), summary: `handled by ${row.name}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[chat] capability "${row.name}" failed:`, err);
      return { ok: false, content: message, summary: `${row.name} failed: ${message}` };
    }
  }

  /**
   * Runs a bounded self-heal script on JARVIS's own request, through the
   * exact same SelfHeal/ApprovalGate path the dashboard's "Run" button
   * uses. An auto_fix script executes immediately; a requires_approval
   * script is only ever queued here — it does not run until a human
   * approves it (dashboard or Pushover), so the reply must never claim it
   * already happened.
   */
  private async runScriptTool(input: unknown): Promise<{ ok: boolean; content: string; summary: string; scriptName: string }> {
    const i = input as Record<string, unknown>;
    const scriptName = typeof i.name === "string" ? i.name : "";
    const args = i.args && typeof i.args === "object" ? (i.args as Record<string, string>) : {};
    try {
      const result = await this.selfHeal.runScript(scriptName, args);
      if (result.status === "applied") {
        return { ok: true, content: "applied", summary: `ran script "${scriptName}"`, scriptName };
      }
      return {
        ok: true,
        content:
          `queued for approval (id ${result.approvalId}) — this has NOT run yet; ` +
          `tell the user it needs their approval in the dashboard before it executes`,
        summary: `queued script "${scriptName}" for approval`,
        scriptName,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, content: message, summary: `script "${scriptName}" failed: ${message}`, scriptName };
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

function buildUserContent(userMessage: string, attachments: ChatAttachment[]): string | Anthropic.MessageParam["content"] {
  if (attachments.length === 0) return userMessage;

  const blocks: Anthropic.ContentBlockParam[] = [];
  for (const attachment of attachments) {
    if (!SUPPORTED_ATTACHMENT_TYPES.test(attachment.mediaType)) {
      throw new Error(
        `unsupported attachment type "${attachment.mediaType}" — only images (png/jpeg/gif/webp) and PDF are supported`,
      );
    }
    if (attachment.mediaType === "application/pdf") {
      blocks.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: attachment.base64Data },
      });
    } else {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: attachment.mediaType as "image/png", data: attachment.base64Data },
      });
    }
  }
  blocks.push({ type: "text", text: userMessage });
  return blocks;
}

const RENDER_TOOLS: Anthropic.Tool[] = [
  {
    name: "render_chart",
    description:
      "Show the user a chart (bar or line) — e.g. performance over time, a comparison of numbers. Call this whenever a visual chart would answer the question better than prose.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        chartType: { type: "string", enum: ["bar", "line"] },
        unit: { type: "string", description: "optional unit label, e.g. '%', 'ms', 'GB'" },
        series: {
          type: "array",
          items: {
            type: "object",
            properties: { label: { type: "string" }, value: { type: "number" } },
            required: ["label", "value"],
          },
        },
      },
      required: ["title", "chartType", "series"],
    },
  },
  {
    name: "render_list",
    description:
      "Show the user a structured list — e.g. recent emails, search results, action items. Call this whenever showing several structured items would be clearer than a paragraph.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              primary: { type: "string" },
              secondary: { type: "string" },
              meta: { type: "string" },
            },
            required: ["primary"],
          },
        },
      },
      required: ["title", "items"],
    },
  },
  {
    name: "render_image",
    description:
      "Show the user an image. Only use a URL or base64 data URI that's already available from a prior tool result or an attachment the user sent — never invent one.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "http(s) URL or data: URI of the image" },
        caption: { type: "string" },
      },
      required: ["url"],
    },
  },
];
const RENDER_TOOL_NAMES = new Set(RENDER_TOOLS.map((t) => t.name));

const RUN_SCRIPT_TOOL: Anthropic.Tool = {
  name: "run_script",
  description:
    "Run one of JARVIS's own bounded maintenance scripts — the fixed set in src/core/scriptRegistry.ts, never " +
    "arbitrary code. Auto-fix scripts run immediately. Scripts requiring approval are only ever queued by this " +
    "call — they run later, only after the user approves them in the dashboard. Never tell the user a " +
    "requires_approval script has already run.\n\nAvailable scripts:\n" +
    listScripts()
      .map((s) => `- ${s.name} (${s.trustTier}): ${s.description}`)
      .join("\n"),
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", enum: listScripts().map((s) => s.name) },
      args: { type: "object", description: 'script-specific arguments, e.g. {"file": "..."} for apply-migration' },
    },
    required: ["name"],
  },
};

function isRenderToolName(name: string): boolean {
  return RENDER_TOOL_NAMES.has(name);
}

function renderToolCallToWidget(name: string, input: unknown): ChatWidget {
  const i = input as Record<string, unknown>;
  switch (name) {
    case "render_chart":
      return {
        type: "chart",
        title: String(i.title ?? ""),
        chartType: i.chartType === "line" ? "line" : "bar",
        series: Array.isArray(i.series) ? (i.series as Array<{ label: string; value: number }>) : [],
        unit: typeof i.unit === "string" ? i.unit : undefined,
      };
    case "render_list":
      return {
        type: "list",
        title: String(i.title ?? ""),
        items: Array.isArray(i.items) ? (i.items as Array<{ primary: string; secondary?: string; meta?: string }>) : [],
      };
    case "render_image":
      return { type: "image", url: String(i.url ?? ""), caption: typeof i.caption === "string" ? i.caption : undefined };
    default:
      throw new Error(`unreachable: unknown render tool "${name}"`);
  }
}

function buildCapabilityTools(capabilities: CapabilityRow[]): Anthropic.Tool[] {
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

function buildSystemPrompt(capabilities: CapabilityRow[]): string {
  const capList =
    capabilities.length > 0
      ? capabilities.map((c) => `- ${c.name}${c.category ? ` (${c.category})` : ""}: ${c.systemPrompt ?? "no description"}`).join("\n")
      : "(no capabilities enabled)";
  return (
    `You are JARVIS, a personal AI assistant with one unified memory and conversation across every area of the ` +
    `user's life — work and personal, all in one place. You can also call render_chart, render_list, or ` +
    `render_image whenever showing a chart, a list, or an image would communicate better than prose alone; use ` +
    `them freely, not just when asked.\n\n` +
    `Available capabilities:\n${capList}`
  );
}

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
