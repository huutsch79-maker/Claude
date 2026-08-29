import Anthropic from "@anthropic-ai/sdk";
import type { DomainId } from "../config/domains.js";
import type { DomainContentSummary } from "../orchestrator/domainContentSummary.js";

/** No routing through Reviewer/CapabilityRegistry — chat cannot take real actions this pass. */
const CHAT_MODEL = "claude-opus-5";
const CHAT_MAX_TOKENS = 4096;

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 5;
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const DOCUMENT_MEDIA_TYPES = new Set(["application/pdf", "text/plain"]);

export interface ChatAttachmentInput {
  filename: string;
  mediaType: string;
  dataBase64: string;
}

/** Server-side-validated attachment, decoded to real bytes, ready to hand to a ChatBackend. */
export interface ValidatedAttachment {
  filename: string;
  mediaType: string;
  data: Buffer;
  sizeBytes: number;
  kind: "image" | "document";
}

export type AttachmentValidationResult = { ok: true; attachments: ValidatedAttachment[] } | { ok: false; reason: string };

export interface ChatPriorMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatReply {
  text: string;
}

/**
 * Testable seam for the chat feature, mirroring ApprovalNotifier in
 * approvalGate.ts: a real implementation (AnthropicChatBackend below) plus
 * a fake for tests, so no test ever needs a live network call/API key.
 */
export interface ChatBackend {
  send(
    domainId: DomainId,
    message: string,
    attachments: ValidatedAttachment[],
    priorMessages: ChatPriorMessage[],
  ): Promise<ChatReply>;
}

/**
 * Server-side attachment validation, run BEFORE any ChatBackend is ever
 * called, on DECODED byte size (base64 inflates input size by ~33%, so
 * checking dataBase64.length instead would under-count real payload size).
 * Images (png/jpg/webp/gif) up to 5MB each, up to 5 per message, OR exactly
 * one PDF/text document up to 10MB — mutually exclusive per message.
 */
export function validateAttachments(raw: ChatAttachmentInput[]): AttachmentValidationResult {
  if (raw.length === 0) return { ok: true, attachments: [] };

  const decoded = raw.map((a) => ({ ...a, buf: decodeBase64(a.dataBase64) }));

  const images = decoded.filter((a) => IMAGE_MEDIA_TYPES.has(a.mediaType));
  const docs = decoded.filter((a) => DOCUMENT_MEDIA_TYPES.has(a.mediaType));
  const unknown = decoded.filter((a) => !IMAGE_MEDIA_TYPES.has(a.mediaType) && !DOCUMENT_MEDIA_TYPES.has(a.mediaType));

  if (unknown.length > 0) {
    return { ok: false, reason: `unsupported file type — ${unknown[0]!.mediaType}` };
  }
  if (images.length > 0 && docs.length > 0) {
    return { ok: false, reason: "attach images OR a single document, not both, in the same message" };
  }

  if (docs.length > 0) {
    if (raw.length > 1) {
      return { ok: false, reason: "only one document is allowed per message" };
    }
    const doc = docs[0]!;
    if (doc.buf.length > MAX_DOCUMENT_BYTES) {
      return { ok: false, reason: `too large — ${formatMb(doc.buf.length)} MB, limit ${formatMb(MAX_DOCUMENT_BYTES)} MB` };
    }
    return {
      ok: true,
      attachments: [{ filename: doc.filename, mediaType: doc.mediaType, data: doc.buf, sizeBytes: doc.buf.length, kind: "document" }],
    };
  }

  if (images.length > MAX_IMAGES_PER_MESSAGE) {
    return { ok: false, reason: `too many images — ${images.length}, limit ${MAX_IMAGES_PER_MESSAGE}` };
  }
  for (const img of images) {
    if (img.buf.length > MAX_IMAGE_BYTES) {
      return { ok: false, reason: `too large — ${formatMb(img.buf.length)} MB, limit ${formatMb(MAX_IMAGE_BYTES)} MB` };
    }
  }
  return {
    ok: true,
    attachments: images.map((img) => ({
      filename: img.filename,
      mediaType: img.mediaType,
      data: img.buf,
      sizeBytes: img.buf.length,
      kind: "image" as const,
    })),
  };
}

function decodeBase64(dataBase64: string): Buffer {
  return Buffer.from(dataBase64, "base64");
}

function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/**
 * Short, deterministic, built ONLY from whitelisted DomainContentSummary
 * fields — never raw mail content, never a credential. Used as per-turn
 * system-prompt context so JARVIS can answer "how many unread emails do I
 * have" without a tool call.
 */
export function buildSystemPrompt(domainLabel: string, content: DomainContentSummary | null): string {
  const lines: string[] = [
    `You are JARVIS, a helpful assistant for the "${domainLabel}" domain. ` +
      "You do not have the ability to take real actions (send email, modify records, etc.) this pass — say so if asked.",
  ];

  if (!content) {
    lines.push("No mail/cost summary has been fetched yet for this domain.");
    return lines.join("\n");
  }

  lines.push(describeMail(content.mail));
  if (content.azureCost) {
    lines.push(describeAzureCost(content.azureCost));
  }
  return lines.join("\n");
}

function describeMail(mail: DomainContentSummary["mail"]): string {
  if (mail.status === "not_configured") return "Mail: not configured.";
  if (mail.status === "error") return "Mail: last sync attempt failed.";
  const staleNote = mail.status === "stale" ? " (data may be out of date)" : "";
  const senders = mail.topSenders.length
    ? mail.topSenders.map((s) => `${s.displayName} (${s.messageCount})`).join(", ")
    : "none";
  return `Mail: ${mail.unreadCount} unread of ${mail.totalCount} total${staleNote}. Top senders: ${senders}.`;
}

function describeAzureCost(azureCost: NonNullable<DomainContentSummary["azureCost"]>): string {
  if (azureCost.status === "not_configured") return "Azure cost: not configured.";
  if (azureCost.status === "error") return "Azure cost: last sync attempt failed.";
  const staleNote = azureCost.status === "stale" ? " (data may be out of date)" : "";
  const services = azureCost.topServices.length
    ? azureCost.topServices.map((s) => `${s.serviceName} (${s.cost.toFixed(2)} ${azureCost.currency})`).join(", ")
    : "none";
  return (
    `Azure cost (month to date): ${azureCost.monthToDateCost?.toFixed(2) ?? "unknown"} ${azureCost.currency}` +
    `${staleNote}. Top services: ${services}.`
  );
}

/**
 * Used when ANTHROPIC_API_KEY isn't set — mirrors PushoverApprovalNotifier's
 * "log and no-op" behavior for a missing credential, so the orchestrator
 * still boots and the dashboard still serves everything except chat.
 */
export class NotConfiguredChatBackend implements ChatBackend {
  async send(): Promise<ChatReply> {
    throw new Error("chat is not configured: ANTHROPIC_API_KEY is not set");
  }
}

/**
 * Real backend: non-streaming Anthropic Messages API call. Reads its API
 * key from a value passed in at construction (threaded through from
 * src/orchestrator/index.ts, matching how healthIntervalMs is already
 * threaded through) — never process.env directly, preserving the
 * src/dashboard/** rule.
 */
export class AnthropicChatBackend implements ChatBackend {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly getContentSummary: (domainId: DomainId) => DomainContentSummary | null,
    private readonly getDomainLabel: (domainId: DomainId) => string,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async send(
    domainId: DomainId,
    message: string,
    attachments: ValidatedAttachment[],
    priorMessages: ChatPriorMessage[],
  ): Promise<ChatReply> {
    const system = buildSystemPrompt(this.getDomainLabel(domainId), this.getContentSummary(domainId));

    const userContent: Anthropic.MessageParam["content"] = [];
    for (const att of attachments) {
      if (att.kind === "image") {
        userContent.push({
          type: "image",
          source: { type: "base64", media_type: att.mediaType as Anthropic.Base64ImageSource["media_type"], data: att.data.toString("base64") },
        });
      } else if (att.mediaType === "application/pdf") {
        userContent.push({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: att.data.toString("base64") },
        });
      } else {
        // text/plain: inline as a clearly-labeled text block rather than a document content block.
        userContent.push({ type: "text", text: `[Attached file: ${att.filename}]\n${att.data.toString("utf8")}` });
      }
    }
    userContent.push({ type: "text", text: message });

    const messages: Anthropic.MessageParam[] = [
      ...priorMessages.map((m): Anthropic.MessageParam => ({ role: m.role, content: m.content })),
      { role: "user", content: userContent },
    ];

    const response = await this.client.messages.create({
      model: CHAT_MODEL,
      max_tokens: CHAT_MAX_TOKENS,
      system,
      messages,
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    return { text };
  }
}
