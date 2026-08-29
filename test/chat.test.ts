import { describe, expect, it } from "vitest";
import {
  MAX_DOCUMENT_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  buildSystemPrompt,
  validateAttachments,
  type ChatAttachmentInput,
} from "../src/dashboard/chat.js";
import type { DomainContentSummary } from "../src/orchestrator/domainContentSummary.js";

function b64(byteLength: number): string {
  return Buffer.alloc(byteLength, 7).toString("base64");
}

function image(filename: string, byteLength: number, mediaType = "image/png"): ChatAttachmentInput {
  return { filename, mediaType, dataBase64: b64(byteLength) };
}

describe("validateAttachments", () => {
  it("accepts zero attachments", () => {
    const result = validateAttachments([]);
    expect(result).toEqual({ ok: true, attachments: [] });
  });

  it("accepts up to MAX_IMAGES_PER_MESSAGE small images", () => {
    const attachments = Array.from({ length: MAX_IMAGES_PER_MESSAGE }, (_, i) => image(`img-${i}.png`, 1024));
    const result = validateAttachments(attachments);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attachments).toHaveLength(MAX_IMAGES_PER_MESSAGE);
      expect(result.attachments.every((a) => a.kind === "image")).toBe(true);
    }
  });

  it("rejects more than MAX_IMAGES_PER_MESSAGE images", () => {
    const attachments = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, (_, i) => image(`img-${i}.png`, 1024));
    const result = validateAttachments(attachments);
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/too many images/) });
  });

  it("rejects an image over MAX_IMAGE_BYTES, measured on DECODED bytes not the base64 string length", () => {
    const result = validateAttachments([image("big.png", MAX_IMAGE_BYTES + 1)]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/too large/);
  });

  it("accepts an image at exactly MAX_IMAGE_BYTES", () => {
    const result = validateAttachments([image("exact.png", MAX_IMAGE_BYTES)]);
    expect(result.ok).toBe(true);
  });

  it("accepts a single PDF document up to MAX_DOCUMENT_BYTES", () => {
    const result = validateAttachments([{ filename: "doc.pdf", mediaType: "application/pdf", dataBase64: b64(1024) }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0]!.kind).toBe("document");
    }
  });

  it("rejects a document over MAX_DOCUMENT_BYTES", () => {
    const result = validateAttachments([{ filename: "big.pdf", mediaType: "application/pdf", dataBase64: b64(MAX_DOCUMENT_BYTES + 1) }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/too large/);
  });

  it("rejects more than one document in the same message", () => {
    const result = validateAttachments([
      { filename: "a.pdf", mediaType: "application/pdf", dataBase64: b64(10) },
      { filename: "b.pdf", mediaType: "application/pdf", dataBase64: b64(10) },
    ]);
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/only one document/) });
  });

  it("rejects mixing images and a document in the same message", () => {
    const result = validateAttachments([
      image("photo.png", 100),
      { filename: "doc.pdf", mediaType: "application/pdf", dataBase64: b64(10) },
    ]);
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/OR a single document/) });
  });

  it("rejects an unsupported media type", () => {
    const result = validateAttachments([{ filename: "script.exe", mediaType: "application/x-msdownload", dataBase64: b64(10) }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/unsupported file type/);
  });

  it("accepts text/plain as a document", () => {
    const result = validateAttachments([{ filename: "notes.txt", mediaType: "text/plain", dataBase64: b64(10) }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.attachments[0]!.kind).toBe("document");
  });

  it("computed sizeBytes reflects the DECODED length, not the base64 string length", () => {
    const decodedLen = 1000;
    const result = validateAttachments([image("a.png", decodedLen)]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.attachments[0]!.sizeBytes).toBe(decodedLen);
  });
});

describe("buildSystemPrompt", () => {
  function content(overrides: Partial<DomainContentSummary> = {}): DomainContentSummary {
    return {
      domain: "work",
      reportedAt: new Date().toISOString(),
      mail: { status: "connected", unreadCount: 4, totalCount: 10, topSenders: [{ displayName: "Alice", messageCount: 2 }], lastSyncedAt: new Date().toISOString() },
      azureCost: { status: "connected", currency: "USD", monthToDateCost: 42, topServices: [{ serviceName: "Storage", cost: 42 }], lastSyncedAt: new Date().toISOString() },
      ...overrides,
    };
  }

  it("mentions the domain label and the no-real-actions limitation", () => {
    const prompt = buildSystemPrompt("NZB (work)", content());
    expect(prompt).toContain("NZB (work)");
    expect(prompt).toMatch(/do not have the ability to take real actions/);
  });

  it("handles a null content summary without throwing", () => {
    const prompt = buildSystemPrompt("Personal", null);
    expect(prompt).toContain("No mail/cost summary has been fetched yet");
  });

  it("never includes raw sender/service identity beyond the whitelisted displayName/serviceName fields it was given", () => {
    const prompt = buildSystemPrompt("NZB (work)", content());
    expect(prompt).toContain("Alice");
    expect(prompt).toContain("Storage");
    expect(prompt).not.toMatch(/sk-|password|secret/i);
  });

  it("omits Azure cost line entirely for the personal domain (azureCost: null)", () => {
    const prompt = buildSystemPrompt("Personal", content({ domain: "personal", azureCost: null }));
    expect(prompt).not.toContain("Azure cost");
  });
});
