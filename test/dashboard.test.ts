import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import type { DomainId } from "../src/config/domains.js";
import type { OperationalMetadata } from "../src/orchestrator/operationalMetadata.js";
import type { ApprovalRequest } from "../src/core/approvalGate.js";
import {
  assertDashboardPayloadShape,
  type ChatAttachmentMeta,
  type ChatHistoryEntry,
  type ChatRole,
  type DashboardSource,
  type DashboardStatePayload,
} from "../src/dashboard/types.js";
import { buildDashboardState } from "../src/dashboard/readModel.js";
import { createDashboardServer, closeServer, type DashboardServerOptions } from "../src/dashboard/server.js";
import type { ChatBackend, ChatPriorMessage, ChatReply, ValidatedAttachment } from "../src/dashboard/chat.js";
import type { AzureCostSummary, DomainContentSummary, MailSummary } from "../src/orchestrator/domainContentSummary.js";
import * as net from "node:net";

function validMetadata(domain: DomainId): OperationalMetadata {
  return {
    domain,
    reportedAt: new Date().toISOString(),
    moduleHealth: [{ moduleId: "m1", status: "healthy", lastRestartAt: null, restartCount24h: 0 }],
    credentialStatus: [{ credentialRef: "ref1", status: "valid", expiresAt: null }],
    errorCounts: { transient24h: 0, fatal24h: 0 },
  };
}

function validMailSummary(overrides: Partial<MailSummary> = {}): MailSummary {
  return {
    status: "connected",
    unreadCount: 3,
    totalCount: 42,
    topSenders: [{ displayName: "Alice", messageCount: 5 }],
    lastSyncedAt: new Date().toISOString(),
    ...overrides,
  };
}

function validAzureCostSummary(overrides: Partial<AzureCostSummary> = {}): AzureCostSummary {
  return {
    status: "connected",
    currency: "USD",
    monthToDateCost: 123.45,
    topServices: [{ serviceName: "Storage", cost: 12.3 }],
    lastSyncedAt: new Date().toISOString(),
    ...overrides,
  };
}

function validContent(domain: DomainId, overrides: Partial<DomainContentSummary> = {}): DomainContentSummary {
  return {
    domain,
    reportedAt: new Date().toISOString(),
    mail: validMailSummary(),
    azureCost: domain === "work" ? validAzureCostSummary() : null,
    ...overrides,
  };
}

interface AppendedChatCall {
  domainId: DomainId;
  entry: { role: ChatRole; content: string; attachments: ChatAttachmentMeta[] };
}

function makeFakeSource(opts: {
  domains?: { id: DomainId; label: string }[];
  metadata?: Map<DomainId, OperationalMetadata>;
  pending?: Map<DomainId, Map<string, ApprovalRequest>>;
  snapshotImpl?: () => ReadonlyMap<DomainId, OperationalMetadata>;
  content?: Map<DomainId, DomainContentSummary>;
  contentSnapshotImpl?: () => ReadonlyMap<DomainId, DomainContentSummary>;
  chatHistory?: Map<DomainId, ChatHistoryEntry[]>;
  /** Distinct from chatHistory on purpose — models the CURRENT-conversation-only context source. Defaults to mirroring chatHistory (role/content only) for tests that don't care about the distinction; set this explicitly to test conversation-scoping (see "dashboard HTTP server: chat route" > context-boundary tests). */
  chatContext?: Map<DomainId, { role: ChatRole; content: string }[]>;
  appendedChatCalls?: AppendedChatCall[];
  recentChatHistoryImpl?: (domainId: DomainId, limit?: number) => Promise<ChatHistoryEntry[]>;
  recentChatContextImpl?: (domainId: DomainId, limit?: number) => Promise<{ role: ChatRole; content: string }[]>;
  appendChatMessageImpl?: (domainId: DomainId, entry: { role: ChatRole; content: string; attachments: ChatAttachmentMeta[] }) => Promise<void>;
} = {}): DashboardSource {
  const domains = opts.domains ?? [
    { id: "work" as DomainId, label: "NZB (work)" },
    { id: "personal" as DomainId, label: "Personal" },
  ];
  const metadata = opts.metadata ?? new Map<DomainId, OperationalMetadata>();
  const pending = opts.pending ?? new Map<DomainId, Map<string, ApprovalRequest>>();
  const content = opts.content ?? new Map<DomainId, DomainContentSummary>();
  const chatHistory = opts.chatHistory ?? new Map<DomainId, ChatHistoryEntry[]>();
  return {
    listDomains: () => domains,
    snapshot: opts.snapshotImpl ?? (() => metadata),
    contentSnapshot: opts.contentSnapshotImpl ?? (() => content),
    listPending: (domainId: DomainId) => pending.get(domainId) ?? new Map(),
    appendChatMessage:
      opts.appendChatMessageImpl ??
      (async (domainId, entry) => {
        opts.appendedChatCalls?.push({ domainId, entry });
        const list = chatHistory.get(domainId) ?? [];
        list.push({ role: entry.role, content: entry.content, attachments: entry.attachments, createdAt: new Date().toISOString() });
        chatHistory.set(domainId, list);
      }),
    recentChatHistory:
      opts.recentChatHistoryImpl ??
      (async (domainId, limit) => {
        const list = chatHistory.get(domainId) ?? [];
        return limit ? list.slice(Math.max(0, list.length - limit)) : list;
      }),
    recentChatContext:
      opts.recentChatContextImpl ??
      (async (domainId, limit) => {
        if (opts.chatContext) {
          const list = opts.chatContext.get(domainId) ?? [];
          return limit ? list.slice(Math.max(0, list.length - limit)) : list;
        }
        // No explicit chatContext given: fall back to chatHistory, mapped to
        // {role, content} — a reasonable default for tests that don't care
        // about the display/context distinction. Tests that DO care set
        // chatContext explicitly (see conversation-boundary tests below).
        const list = chatHistory.get(domainId) ?? [];
        const mapped = list.map((e) => ({ role: e.role, content: e.content }));
        return limit ? mapped.slice(Math.max(0, mapped.length - limit)) : mapped;
      }),
  };
}

interface FakeChatBackendCall {
  domainId: DomainId;
  message: string;
  attachments: ValidatedAttachment[];
  priorMessages: ChatPriorMessage[];
}

function makeFakeChatBackend(
  opts: { replyText?: string; impl?: ChatBackend["send"] } = {},
): ChatBackend & { calls: FakeChatBackendCall[] } {
  const calls: FakeChatBackendCall[] = [];
  return {
    calls,
    async send(domainId, message, attachments, priorMessages): Promise<ChatReply> {
      calls.push({ domainId, message, attachments, priorMessages });
      if (opts.impl) return opts.impl(domainId, message, attachments, priorMessages);
      return { text: opts.replyText ?? "fake reply" };
    },
  };
}

function defaultServerOptions(overrides: Partial<DashboardServerOptions> = {}): DashboardServerOptions {
  return { healthIntervalMs: 5 * 60 * 1000, chatBackend: makeFakeChatBackend(), ...overrides };
}

describe("dashboard payload shape", () => {
  it("accepts a well-formed payload built from a real read model", () => {
    const metadata = new Map<DomainId, OperationalMetadata>([
      ["work", validMetadata("work")],
      ["personal", validMetadata("personal")],
    ]);
    const source = makeFakeSource({ metadata });
    const payload = buildDashboardState(source, { healthIntervalMs: 5 * 60 * 1000 });
    expect(() => assertDashboardPayloadShape(payload)).not.toThrow();
  });

  it("rejects a deliberately-poisoned payload with an extra top-level key", () => {
    const metadata = new Map<DomainId, OperationalMetadata>([["work", validMetadata("work")]]);
    const source = makeFakeSource({ domains: [{ id: "work", label: "NZB (work)" }], metadata });
    const payload = buildDashboardState(source, { healthIntervalMs: 5 * 60 * 1000 });
    const bad = { ...payload, lastUserMessage: "some content leaking across" };
    expect(() => assertDashboardPayloadShape(bad)).toThrow(/disallowed field/);
  });

  it("rejects a poisoned domain entry (extra field one level down)", () => {
    const metadata = new Map<DomainId, OperationalMetadata>([["work", validMetadata("work")]]);
    const source = makeFakeSource({ domains: [{ id: "work", label: "NZB (work)" }], metadata });
    const payload = buildDashboardState(source, { healthIntervalMs: 5 * 60 * 1000 });
    const bad: unknown = {
      domains: [{ ...payload.domains[0], debugContext: "conversation excerpt" }],
    };
    expect(() => assertDashboardPayloadShape(bad)).toThrow(/disallowed field/);
  });

  it("rejects a poisoned moduleHealth entry (nested two levels down)", () => {
    const metadata = new Map<DomainId, OperationalMetadata>([["work", validMetadata("work")]]);
    const source = makeFakeSource({ domains: [{ id: "work", label: "NZB (work)" }], metadata });
    const payload = buildDashboardState(source, { healthIntervalMs: 5 * 60 * 1000 });
    const poisonedModule = { ...payload.domains[0]!.moduleHealth[0], secretValue: "sk-abc123" };
    const bad: unknown = {
      domains: [{ ...payload.domains[0], moduleHealth: [poisonedModule] }],
    };
    expect(() => assertDashboardPayloadShape(bad)).toThrow(/disallowed field/);
  });

  it("rejects an allowed key carrying an arbitrary/leaked value instead of the expected type (Tester HIGH #1 repro)", () => {
    // moduleId set to a nested object rather than a string: assertOnlyKeys alone
    // (key-name checking) would let this sail through unchanged.
    const bad: unknown = {
      domains: [
        {
          domain: "work",
          reportedAt: new Date().toISOString(),
          ageMs: 0,
          stale: false,
          awaitingFirstReport: false,
          moduleHealth: [{ moduleId: { leaked: "conversation excerpt" }, status: "healthy", lastRestartAt: null, restartCount24h: 0 }],
          credentialStatus: [],
          errorCounts: { transient24h: 0, fatal24h: 0 },
          approvals: [],
          totalPending: 0,
        },
      ],
    };
    expect(() => assertDashboardPayloadShape(bad)).toThrow(/moduleId must be a string/);
  });

  it("rejects a status value outside the known enum", () => {
    const bad: unknown = {
      domains: [
        {
          domain: "work",
          reportedAt: new Date().toISOString(),
          ageMs: 0,
          stale: false,
          awaitingFirstReport: false,
          moduleHealth: [{ moduleId: "m1", status: "not-a-real-status", lastRestartAt: null, restartCount24h: 0 }],
          credentialStatus: [],
          errorCounts: { transient24h: 0, fatal24h: 0 },
          approvals: [],
          totalPending: 0,
        },
      ],
    };
    expect(() => assertDashboardPayloadShape(bad)).toThrow(/status must be one of/);
  });

  it("rejects NaN/Infinity anywhere a finite number is expected, even though typeof would pass", () => {
    const baseDomain = {
      domain: "work",
      reportedAt: new Date().toISOString(),
      stale: false,
      awaitingFirstReport: false,
      moduleHealth: [],
      credentialStatus: [],
      errorCounts: { transient24h: 0, fatal24h: 0 },
      approvals: [],
      totalPending: 0,
    };
    expect(() => assertDashboardPayloadShape({ domains: [{ ...baseDomain, ageMs: NaN }] })).toThrow(/ageMs must be a finite number/);
    expect(() => assertDashboardPayloadShape({ domains: [{ ...baseDomain, ageMs: Infinity }] })).toThrow(/ageMs must be a finite number/);
    expect(() =>
      assertDashboardPayloadShape({
        domains: [{ ...baseDomain, ageMs: 0, errorCounts: { transient24h: NaN, fatal24h: 0 } }],
      }),
    ).toThrow(/transient24h must be a finite number/);
  });

  it("serialized payload's key set is exactly the whitelist at every nesting level", () => {
    const pending = new Map<DomainId, Map<string, ApprovalRequest>>([
      ["work", new Map([["a1", { domain: "work", summary: "restart foo", kind: "module_add", proposedAt: new Date().toISOString() }]])],
    ]);
    const metadata = new Map<DomainId, OperationalMetadata>([["work", validMetadata("work")]]);
    const content = new Map<DomainId, DomainContentSummary>([["work", validContent("work")]]);
    const source = makeFakeSource({ domains: [{ id: "work", label: "NZB (work)" }], metadata, pending, content });
    const payload = buildDashboardState(source, { healthIntervalMs: 5 * 60 * 1000 });

    // Round-trip through JSON, exactly as the HTTP layer would serialize it.
    const round: DashboardStatePayload = JSON.parse(JSON.stringify(payload));
    expect(() => assertDashboardPayloadShape(round)).not.toThrow();

    expect(Object.keys(round).sort()).toEqual(["domains"]);

    const domainEntry = round.domains[0]!;
    expect(Object.keys(domainEntry).sort()).toEqual(
      [
        "approvals",
        "credentialStatus",
        "domain",
        "errorCounts",
        "moduleHealth",
        "reportedAt",
        "ageMs",
        "stale",
        "awaitingFirstReport",
        "totalPending",
        "content",
      ].sort(),
    );
    expect(Object.keys(domainEntry.moduleHealth[0]!).sort()).toEqual(
      ["moduleId", "status", "lastRestartAt", "restartCount24h"].sort(),
    );
    expect(Object.keys(domainEntry.credentialStatus[0]!).sort()).toEqual(
      ["credentialRef", "status", "expiresAt"].sort(),
    );
    expect(Object.keys(domainEntry.errorCounts).sort()).toEqual(["transient24h", "fatal24h"].sort());
    expect(Object.keys(domainEntry.approvals[0]!).sort()).toEqual(["id", "kind", "summary", "proposedAt"].sort());

    // content and every nesting level within it, mirroring the health-side assertions above.
    const contentEntry = domainEntry.content!;
    expect(Object.keys(contentEntry).sort()).toEqual(["domain", "reportedAt", "mail", "azureCost"].sort());
    expect(Object.keys(contentEntry.mail).sort()).toEqual(
      ["status", "unreadCount", "totalCount", "topSenders", "lastSyncedAt"].sort(),
    );
    expect(Object.keys(contentEntry.mail.topSenders[0]!).sort()).toEqual(["displayName", "messageCount"].sort());
    expect(Object.keys(contentEntry.azureCost!).sort()).toEqual(
      ["status", "currency", "monthToDateCost", "topServices", "lastSyncedAt"].sort(),
    );
    expect(Object.keys(contentEntry.azureCost!.topServices[0]!).sort()).toEqual(["serviceName", "cost"].sort());
  });
});

describe("domain content payload shape", () => {
  it("accepts a well-formed content payload built from a real read model", () => {
    const metadata = new Map<DomainId, OperationalMetadata>([["work", validMetadata("work")]]);
    const content = new Map<DomainId, DomainContentSummary>([["work", validContent("work")]]);
    const source = makeFakeSource({ domains: [{ id: "work", label: "NZB (work)" }], metadata, content });
    const payload = buildDashboardState(source, { healthIntervalMs: 5 * 60 * 1000 });
    expect(() => assertDashboardPayloadShape(payload)).not.toThrow();
    expect(payload.domains[0]!.content).not.toBeNull();
  });

  it("is null, not omitted or undefined, for a domain that has never published a content report", () => {
    const metadata = new Map<DomainId, OperationalMetadata>([["work", validMetadata("work")]]);
    const source = makeFakeSource({ domains: [{ id: "work", label: "NZB (work)" }], metadata });
    const payload = buildDashboardState(source, { healthIntervalMs: 5 * 60 * 1000 });
    expect(payload.domains[0]!.content).toBeNull();
    expect(() => assertDashboardPayloadShape(payload)).not.toThrow();
  });

  it("rejects a poisoned content entry with an extra top-level key", () => {
    const bad: unknown = {
      domains: [
        {
          domain: "work",
          reportedAt: new Date().toISOString(),
          ageMs: 0,
          stale: false,
          awaitingFirstReport: false,
          moduleHealth: [],
          credentialStatus: [],
          errorCounts: { transient24h: 0, fatal24h: 0 },
          approvals: [],
          totalPending: 0,
          content: { ...validContent("work"), debugContext: "conversation excerpt" },
        },
      ],
    };
    expect(() => assertDashboardPayloadShape(bad)).toThrow(/disallowed field/);
  });

  it("rejects a poisoned mail sub-object (extra field nested inside content.mail)", () => {
    const bad: unknown = {
      domains: [
        {
          domain: "work",
          reportedAt: new Date().toISOString(),
          ageMs: 0,
          stale: false,
          awaitingFirstReport: false,
          moduleHealth: [],
          credentialStatus: [],
          errorCounts: { transient24h: 0, fatal24h: 0 },
          approvals: [],
          totalPending: 0,
          content: { ...validContent("work"), mail: { ...validMailSummary(), rawSubjectLine: "leaked email subject" } },
        },
      ],
    };
    expect(() => assertDashboardPayloadShape(bad)).toThrow(/disallowed field/);
  });

  it("rejects a poisoned azureCost sub-object (extra field nested inside content.azureCost)", () => {
    const bad: unknown = {
      domains: [
        {
          domain: "work",
          reportedAt: new Date().toISOString(),
          ageMs: 0,
          stale: false,
          awaitingFirstReport: false,
          moduleHealth: [],
          credentialStatus: [],
          errorCounts: { transient24h: 0, fatal24h: 0 },
          approvals: [],
          totalPending: 0,
          content: { ...validContent("work"), azureCost: { ...validAzureCostSummary(), invoiceId: "leaked billing id" } },
        },
      ],
    };
    expect(() => assertDashboardPayloadShape(bad)).toThrow(/disallowed field/);
  });

  it("rejects a poisoned topSenders entry (nested two levels down inside content.mail)", () => {
    const bad: unknown = {
      domains: [
        {
          domain: "work",
          reportedAt: new Date().toISOString(),
          ageMs: 0,
          stale: false,
          awaitingFirstReport: false,
          moduleHealth: [],
          credentialStatus: [],
          errorCounts: { transient24h: 0, fatal24h: 0 },
          approvals: [],
          totalPending: 0,
          content: {
            ...validContent("work"),
            mail: { ...validMailSummary(), topSenders: [{ displayName: "Alice", messageCount: 5, emailAddress: "alice@leaked.example" }] },
          },
        },
      ],
    };
    expect(() => assertDashboardPayloadShape(bad)).toThrow(/disallowed field/);
  });

  it("rejects a poisoned topServices entry (nested two levels down inside content.azureCost)", () => {
    const bad: unknown = {
      domains: [
        {
          domain: "work",
          reportedAt: new Date().toISOString(),
          ageMs: 0,
          stale: false,
          awaitingFirstReport: false,
          moduleHealth: [],
          credentialStatus: [],
          errorCounts: { transient24h: 0, fatal24h: 0 },
          approvals: [],
          totalPending: 0,
          content: {
            ...validContent("work"),
            azureCost: { ...validAzureCostSummary(), topServices: [{ serviceName: "Storage", cost: 12.3, resourceGroup: "leaked-rg" }] },
          },
        },
      ],
    };
    expect(() => assertDashboardPayloadShape(bad)).toThrow(/disallowed field/);
  });

  it("rejects a mail.status value outside the known enum", () => {
    const bad: unknown = {
      domains: [
        {
          domain: "work",
          reportedAt: new Date().toISOString(),
          ageMs: 0,
          stale: false,
          awaitingFirstReport: false,
          moduleHealth: [],
          credentialStatus: [],
          errorCounts: { transient24h: 0, fatal24h: 0 },
          approvals: [],
          totalPending: 0,
          content: { ...validContent("work"), mail: { ...validMailSummary(), status: "definitely-not-real" } },
        },
      ],
    };
    expect(() => assertDashboardPayloadShape(bad)).toThrow(/status must be one of/);
  });

  it("rejects a mail.topSenders entry carrying an object instead of a string displayName (leaked-value-through-allowed-key repro)", () => {
    const bad: unknown = {
      domains: [
        {
          domain: "work",
          reportedAt: new Date().toISOString(),
          ageMs: 0,
          stale: false,
          awaitingFirstReport: false,
          moduleHealth: [],
          credentialStatus: [],
          errorCounts: { transient24h: 0, fatal24h: 0 },
          approvals: [],
          totalPending: 0,
          content: {
            ...validContent("work"),
            mail: { ...validMailSummary(), topSenders: [{ displayName: { leaked: "excerpt" }, messageCount: 5 }] },
          },
        },
      ],
    };
    expect(() => assertDashboardPayloadShape(bad)).toThrow(/displayName must be a string/);
  });

  it("rejects NaN/Infinity in content numeric fields even though typeof would pass", () => {
    const baseDomain = {
      domain: "work",
      reportedAt: new Date().toISOString(),
      ageMs: 0,
      stale: false,
      awaitingFirstReport: false,
      moduleHealth: [],
      credentialStatus: [],
      errorCounts: { transient24h: 0, fatal24h: 0 },
      approvals: [],
      totalPending: 0,
    };
    expect(() =>
      assertDashboardPayloadShape({
        domains: [{ ...baseDomain, content: { ...validContent("work"), mail: { ...validMailSummary(), unreadCount: NaN } } }],
      }),
    ).toThrow(/unreadCount must be a finite number/);
    expect(() =>
      assertDashboardPayloadShape({
        domains: [
          {
            ...baseDomain,
            content: { ...validContent("work"), azureCost: { ...validAzureCostSummary(), monthToDateCost: Infinity } },
          },
        ],
      }),
    ).toThrow(/monthToDateCost must be a finite number or null/);
  });

  it("azureCost is accepted as null (the personal-domain shape) and mail.topSenders/azureCost.topServices arrays over the cap are rejected", () => {
    const okNullAzure: unknown = {
      domains: [
        {
          domain: "personal",
          reportedAt: new Date().toISOString(),
          ageMs: 0,
          stale: false,
          awaitingFirstReport: false,
          moduleHealth: [],
          credentialStatus: [],
          errorCounts: { transient24h: 0, fatal24h: 0 },
          approvals: [],
          totalPending: 0,
          content: validContent("personal"),
        },
      ],
    };
    expect(() => assertDashboardPayloadShape(okNullAzure)).not.toThrow();

    const tooManySenders = Array.from({ length: 6 }, (_, i) => ({ displayName: `sender-${i}`, messageCount: i }));
    const overCap: unknown = {
      domains: [
        {
          domain: "work",
          reportedAt: new Date().toISOString(),
          ageMs: 0,
          stale: false,
          awaitingFirstReport: false,
          moduleHealth: [],
          credentialStatus: [],
          errorCounts: { transient24h: 0, fatal24h: 0 },
          approvals: [],
          totalPending: 0,
          content: { ...validContent("work"), mail: { ...validMailSummary(), topSenders: tooManySenders } },
        },
      ],
    };
    expect(() => assertDashboardPayloadShape(overCap)).toThrow(/at most 5 entries/);
  });
});

describe("domain content separation", () => {
  it("keeps work and personal content summaries as separate entries, never merged (mail/Azure cross-leak repro)", () => {
    const metadata = new Map<DomainId, OperationalMetadata>([
      ["work", validMetadata("work")],
      ["personal", validMetadata("personal")],
    ]);
    const workContent = validContent("work", {
      mail: validMailSummary({ unreadCount: 11, topSenders: [{ displayName: "work-only-sender@corp.example", messageCount: 9 }] }),
      azureCost: validAzureCostSummary({ monthToDateCost: 999.99 }),
    });
    const personalContent = validContent("personal", {
      mail: validMailSummary({ unreadCount: 2, topSenders: [{ displayName: "personal-only-sender@home.example", messageCount: 1 }] }),
    });
    const content = new Map<DomainId, DomainContentSummary>([
      ["work", workContent],
      ["personal", personalContent],
    ]);
    const source = makeFakeSource({ metadata, content });
    const payload = buildDashboardState(source, { healthIntervalMs: 5 * 60 * 1000 });

    const work = payload.domains.find((d) => d.domain === "work")!;
    const personal = payload.domains.find((d) => d.domain === "personal")!;

    // The personal domain must never carry Azure cost data, by construction.
    expect(personal.content!.azureCost).toBeNull();
    expect(work.content!.azureCost).not.toBeNull();

    // Neither domain's mail sender names appear on the other domain's entry.
    const workSenderNames = work.content!.mail.topSenders.map((s) => s.displayName);
    const personalSenderNames = personal.content!.mail.topSenders.map((s) => s.displayName);
    expect(workSenderNames).toContain("work-only-sender@corp.example");
    expect(workSenderNames).not.toContain("personal-only-sender@home.example");
    expect(personalSenderNames).toContain("personal-only-sender@home.example");
    expect(personalSenderNames).not.toContain("work-only-sender@corp.example");
    expect(work.content!.mail.unreadCount).not.toBe(personal.content!.mail.unreadCount);
    expect(() => assertDashboardPayloadShape(payload)).not.toThrow();
  });

  it("content freshness downgrades a stale connected sub-summary to stale without mutating the source object", () => {
    const metadata = new Map<DomainId, OperationalMetadata>([["work", validMetadata("work")]]);
    const staleContent = validContent("work", { reportedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() }); // 1h old
    const content = new Map<DomainId, DomainContentSummary>([["work", staleContent]]);
    const source = makeFakeSource({ domains: [{ id: "work", label: "NZB (work)" }], metadata, content });
    const payload = buildDashboardState(source, { healthIntervalMs: 5 * 60 * 1000 }); // stale threshold: 10 min

    expect(payload.domains[0]!.content!.mail.status).toBe("stale");
    expect(payload.domains[0]!.content!.azureCost!.status).toBe("stale");
    // Original object handed in by the source is untouched.
    expect(staleContent.mail.status).toBe("connected");
    expect(staleContent.azureCost!.status).toBe("connected");
  });

  it("content freshness leaves not_configured/error sub-summaries alone even when stale", () => {
    const metadata = new Map<DomainId, OperationalMetadata>([["work", validMetadata("work")]]);
    const oldNotConfigured = validContent("work", {
      reportedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      mail: validMailSummary({ status: "not_configured" }),
      azureCost: validAzureCostSummary({ status: "error" }),
    });
    const content = new Map<DomainId, DomainContentSummary>([["work", oldNotConfigured]]);
    const source = makeFakeSource({ domains: [{ id: "work", label: "NZB (work)" }], metadata, content });
    const payload = buildDashboardState(source, { healthIntervalMs: 5 * 60 * 1000 });

    expect(payload.domains[0]!.content!.mail.status).toBe("not_configured");
    expect(payload.domains[0]!.content!.azureCost!.status).toBe("error");
  });
});

describe("dashboard read model", () => {
  it("keeps work and personal as separate entries, never merged", () => {
    const metadata = new Map<DomainId, OperationalMetadata>([
      ["work", validMetadata("work")],
      ["personal", validMetadata("personal")],
    ]);
    const source = makeFakeSource({ metadata });
    const payload = buildDashboardState(source, { healthIntervalMs: 5 * 60 * 1000 });

    expect(payload.domains).toHaveLength(2);
    const work = payload.domains.find((d) => d.domain === "work");
    const personal = payload.domains.find((d) => d.domain === "personal");
    expect(work).toBeDefined();
    expect(personal).toBeDefined();
    expect(work).not.toBe(personal);
    expect(work!.domain).toBe("work");
    expect(personal!.domain).toBe("personal");
  });

  it("produces a clean awaiting-first-report shape for a domain with no snapshot yet", () => {
    const source = makeFakeSource({ metadata: new Map() });
    const payload = buildDashboardState(source, { healthIntervalMs: 5 * 60 * 1000 });
    for (const d of payload.domains) {
      expect(d.reportedAt).toBeNull();
      expect(d.ageMs).toBeNull();
      expect(d.stale).toBe(true);
      expect(d.awaitingFirstReport).toBe(true);
      expect(d.moduleHealth).toEqual([]);
      expect(d.credentialStatus).toEqual([]);
      expect(d.errorCounts).toEqual({ transient24h: 0, fatal24h: 0 });
      expect(d.approvals).toEqual([]);
      expect(d.totalPending).toBe(0);
    }
    expect(() => assertDashboardPayloadShape(payload)).not.toThrow();
  });

  it("marks a domain stale once its report is older than 2x the health interval", () => {
    const staleMetadata = validMetadata("work");
    staleMetadata.reportedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20 min ago
    const source = makeFakeSource({
      domains: [{ id: "work", label: "NZB (work)" }],
      metadata: new Map([["work", staleMetadata]]),
    });
    const payload = buildDashboardState(source, { healthIntervalMs: 5 * 60 * 1000 }); // stale threshold: 10 min
    expect(payload.domains[0]!.stale).toBe(true);
    expect(payload.domains[0]!.awaitingFirstReport).toBe(false);
  });

  it("flags a malformed reportedAt as stale/corrupt instead of silently passing NaN age as healthy (Tester MEDIUM #5 repro)", () => {
    const badMetadata = validMetadata("work");
    (badMetadata as OperationalMetadata).reportedAt = "not-a-real-timestamp";
    const source = makeFakeSource({
      domains: [{ id: "work", label: "NZB (work)" }],
      metadata: new Map([["work", badMetadata]]),
    });
    const payload = buildDashboardState(source, { healthIntervalMs: 5 * 60 * 1000 });
    const domain = payload.domains[0]!;
    expect(domain.ageMs).toBeNull();
    expect(domain.stale).toBe(true);
    expect(domain.awaitingFirstReport).toBe(false);
    // Not indistinguishable from a normal report: assertDashboardPayloadShape
    // must still accept this (ageMs: null is valid), but stale must be true.
    expect(() => assertDashboardPayloadShape(payload)).not.toThrow();
  });

  it("caps the approvals array and reports the true count via totalPending (Tester MEDIUM #6 repro)", () => {
    const pendingMap = new Map<string, ApprovalRequest>();
    const totalApprovals = 800; // > APPROVAL_DISPLAY_LIMIT (500)
    for (let i = 0; i < totalApprovals; i++) {
      const proposedAt = new Date(Date.now() - (totalApprovals - i) * 1000).toISOString(); // ascending, oldest first
      pendingMap.set(`approval-${i}`, { domain: "work", summary: `proposal ${i}`, kind: "module_add", proposedAt });
    }
    const source = makeFakeSource({
      domains: [{ id: "work", label: "NZB (work)" }],
      metadata: new Map([["work", validMetadata("work")]]),
      pending: new Map([["work", pendingMap]]),
    });
    const payload = buildDashboardState(source, { healthIntervalMs: 5 * 60 * 1000 });
    const domain = payload.domains[0]!;
    expect(domain.totalPending).toBe(totalApprovals);
    expect(domain.approvals.length).toBeLessThanOrEqual(500);
    expect(domain.approvals.length).toBe(500);
    // Oldest-first: the first entry in the capped array should be approval-0.
    expect(domain.approvals[0]!.id).toBe("approval-0");
    expect(() => assertDashboardPayloadShape(payload)).not.toThrow();
  });

  it("sorts credential status worst-first: expired > invalid > expiring_soon > valid", () => {
    const metadata = validMetadata("work");
    metadata.credentialStatus = [
      { credentialRef: "c-valid", status: "valid", expiresAt: null },
      { credentialRef: "c-expired", status: "expired", expiresAt: null },
      { credentialRef: "c-expiring", status: "expiring_soon", expiresAt: null },
      { credentialRef: "c-invalid", status: "invalid", expiresAt: null },
    ];
    const source = makeFakeSource({
      domains: [{ id: "work", label: "NZB (work)" }],
      metadata: new Map([["work", metadata]]),
    });
    const payload = buildDashboardState(source, { healthIntervalMs: 5 * 60 * 1000 });
    expect(payload.domains[0]!.credentialStatus.map((c) => c.status)).toEqual([
      "expired",
      "invalid",
      "expiring_soon",
      "valid",
    ]);
  });
});

describe("dashboard structural isolation (static analysis)", () => {
  const forbidden = [
    "Domain.js",
    "memoryStore.js",
    "relationsStore.js",
    "credentialStore.js",
    "capabilityRegistry.js",
    "chatHistoryStore.js",
    "db.js",
    "createDomainPool",
    'from "pg"',
    'require("pg")',
  ];

  const dashboardDir = path.resolve(__dirname, "../src/dashboard");
  const files = fs.readdirSync(dashboardDir).filter((f) => f.endsWith(".ts"));

  it("finds the expected dashboard source files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("the directory glob picks up the new chat.ts file automatically — not hand-listed, so it can't be forgotten", () => {
    expect(files).toContain("chat.ts");
  });

  for (const file of files) {
    it(`${file} never imports a domain-internal store or pg`, () => {
      const contents = fs.readFileSync(path.join(dashboardDir, file), "utf8");
      for (const needle of forbidden) {
        expect(contents.includes(needle), `${file} must not contain "${needle}"`).toBe(false);
      }
    });
  }
});

describe("dashboard HTTP server", () => {
  async function withServer<T>(
    source: DashboardSource,
    fn: (baseUrl: string) => Promise<T>,
    serverOpts: Partial<DashboardServerOptions> = {},
  ): Promise<T> {
    const server = createDashboardServer(source, defaultServerOptions(serverOpts));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      return await fn(baseUrl);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  }

  it("GET /api/state returns 200 with both domains and nothing else", async () => {
    const metadata = new Map<DomainId, OperationalMetadata>([
      ["work", validMetadata("work")],
      ["personal", validMetadata("personal")],
    ]);
    const source = makeFakeSource({ metadata });
    await withServer(source, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/state`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = (await res.json()) as DashboardStatePayload;
      expect(() => assertDashboardPayloadShape(body)).not.toThrow();
      expect(body.domains.map((d) => d.domain).sort()).toEqual(["personal", "work"]);
    });
  });

  it("GET /api/healthz returns { ok: true }", async () => {
    const source = makeFakeSource();
    await withServer(source, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/healthz`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });
  });

  it("GET / returns the dashboard HTML with both domain labels and the poll script", async () => {
    const source = makeFakeSource();
    await withServer(source, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const body = await res.text();
      expect(body).toContain("<!doctype html>");
      expect(body).toContain("work");
      expect(body).toContain("personal");
      expect(body).toContain("/api/state");
      expect(body).toContain("setInterval");
    });
  });

  it("HEAD / is served like GET / but with no body", async () => {
    const source = makeFakeSource();
    await withServer(source, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/`, { method: "HEAD" });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toBe("");
    });
  });

  it("unknown path returns 404 JSON", async () => {
    const source = makeFakeSource();
    await withServer(source, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/nope`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not found" });
    });
  });

  it("wrong method on a known path returns 405", async () => {
    const source = makeFakeSource();
    await withServer(source, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/state`, { method: "PUT" });
      expect(res.status).toBe(405);
    });
  });

  it("POST without the X-Jarvis-Dashboard header returns 403, on any path", async () => {
    const source = makeFakeSource();
    await withServer(source, async (baseUrl) => {
      const res1 = await fetch(`${baseUrl}/api/state`, { method: "POST" });
      expect(res1.status).toBe(403);
      const res2 = await fetch(`${baseUrl}/anything`, { method: "POST" });
      expect(res2.status).toBe(403);
    });
  });

  it("a poisoned source (leaked object value in moduleId) never reaches the wire — 500, not the leaked data (Tester HIGH #1 end-to-end repro)", async () => {
    const poisonedMetadata = {
      ...validMetadata("work"),
      moduleHealth: [{ moduleId: { leaked: "conversation excerpt, should never serialize" }, status: "healthy", lastRestartAt: null, restartCount24h: 0 }],
    } as unknown as OperationalMetadata;
    const source = makeFakeSource({
      domains: [{ id: "work", label: "NZB (work)" }],
      metadata: new Map([["work", poisonedMetadata]]),
    });
    await withServer(source, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/state`);
      const bodyText = await res.text();
      expect(res.status).toBe(500);
      expect(bodyText).not.toContain("leaked");
      expect(JSON.parse(bodyText)).toEqual({ error: "internal error" });
    });
  });

  it("a source whose snapshot() throws returns 500, not a crash", async () => {
    const source = makeFakeSource({
      snapshotImpl: () => {
        throw new Error("db is down");
      },
    });
    await withServer(source, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/state`);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "internal error" });
    });
  });

  it("closeServer resolves within its grace period even with a stalled mid-request connection (Tester HIGH #3 repro)", async () => {
    const source = makeFakeSource();
    const server = createDashboardServer(source, defaultServerOptions());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const socket = net.connect(port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    // Send an incomplete request line — no terminating \r\n\r\n — so the
    // server never finishes parsing it and the connection stays open,
    // exactly like a slow client or a slowloris attempt.
    socket.write("GET /api/state HTTP/1.1\r\nHost: localhost\r\n");

    const start = Date.now();
    const GRACE_MS = 300; // short for test speed; production default is 2000
    await closeServer(server, GRACE_MS);
    const elapsed = Date.now() - start;

    // Should resolve once the grace timer force-closes the stalled
    // connection, not hang forever — bounded well above the grace period
    // (flaky-CI headroom) but nowhere near "never".
    expect(elapsed).toBeLessThan(GRACE_MS + 2000);
    socket.destroy();
  });
});

describe("dashboard HTTP server: chat route", () => {
  async function withServer<T>(
    source: DashboardSource,
    fn: (baseUrl: string) => Promise<T>,
    serverOpts: Partial<DashboardServerOptions> = {},
  ): Promise<T> {
    const server = createDashboardServer(source, defaultServerOptions(serverOpts));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      return await fn(baseUrl);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  }

  function postChat(baseUrl: string, domain: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}/api/chat/${domain}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-jarvis-dashboard": "1" },
      body: JSON.stringify(body),
    });
  }

  it("POST to an unknown domain returns 404 and never calls the chat backend", async () => {
    const backend = makeFakeChatBackend();
    const source = makeFakeSource();
    await withServer(
      source,
      async (baseUrl) => {
        const res = await postChat(baseUrl, "not-a-real-domain", { message: "hi" });
        expect(res.status).toBe(404);
        expect(backend.calls).toHaveLength(0);
      },
      { chatBackend: backend },
    );
  });

  it("rejects an oversized image attachment before the backend is ever called (Tester attachment-boundary repro)", async () => {
    const backend = makeFakeChatBackend();
    const appendedChatCalls: AppendedChatCall[] = [];
    const source = makeFakeSource({ appendedChatCalls });
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 1).toString("base64"); // > MAX_IMAGE_BYTES (5MB)
    await withServer(
      source,
      async (baseUrl) => {
        const res = await postChat(baseUrl, "work", {
          message: "look at this",
          attachments: [{ filename: "big.png", mediaType: "image/png", dataBase64: oversized }],
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toMatch(/too large/);
        expect(backend.calls).toHaveLength(0);
        expect(appendedChatCalls).toHaveLength(0);
      },
      { chatBackend: backend },
    );
  });

  it("rejects an unsupported attachment media type before the backend is ever called", async () => {
    const backend = makeFakeChatBackend();
    const appendedChatCalls: AppendedChatCall[] = [];
    const source = makeFakeSource({ appendedChatCalls });
    await withServer(
      source,
      async (baseUrl) => {
        const res = await postChat(baseUrl, "work", {
          message: "run this",
          attachments: [{ filename: "script.exe", mediaType: "application/x-msdownload", dataBase64: Buffer.from("x").toString("base64") }],
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toMatch(/unsupported file type/);
        expect(backend.calls).toHaveLength(0);
        expect(appendedChatCalls).toHaveLength(0);
      },
      { chatBackend: backend },
    );
  });

  it("rejects an attachment whose bytes don't match its claimed image mediaType, end-to-end — before the backend is ever called (Tester MEDIUM #2 repro)", async () => {
    const backend = makeFakeChatBackend();
    const appendedChatCalls: AppendedChatCall[] = [];
    const source = makeFakeSource({ appendedChatCalls });
    // Real 'MZ' PE-executable magic bytes, claimed as image/png.
    const peBytes = Buffer.concat([Buffer.from("MZ", "ascii"), Buffer.alloc(100, 0)]);
    await withServer(
      source,
      async (baseUrl) => {
        const res = await postChat(baseUrl, "work", {
          message: "open this",
          attachments: [{ filename: "totally-safe.exe", mediaType: "image/png", dataBase64: peBytes.toString("base64") }],
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toMatch(/doesn't match the claimed type/);
        expect(backend.calls).toHaveLength(0);
        expect(appendedChatCalls).toHaveLength(0);
      },
      { chatBackend: backend },
    );
  });

  it("a normal turn round-trips: persists the user turn, calls the backend once, persists and returns the reply", async () => {
    const backend = makeFakeChatBackend({ replyText: "here is my answer" });
    const appendedChatCalls: AppendedChatCall[] = [];
    const source = makeFakeSource({ appendedChatCalls });
    await withServer(
      source,
      async (baseUrl) => {
        const res = await postChat(baseUrl, "work", { message: "how many unread emails?" });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { reply: { text: string; createdAt: string } };
        expect(body.reply.text).toBe("here is my answer");
        expect(typeof body.reply.createdAt).toBe("string");

        expect(backend.calls).toHaveLength(1);
        expect(backend.calls[0]!.domainId).toBe("work");
        expect(backend.calls[0]!.message).toBe("how many unread emails?");
        expect(backend.calls[0]!.attachments).toEqual([]);

        expect(appendedChatCalls).toHaveLength(2);
        expect(appendedChatCalls[0]!.entry.role).toBe("user");
        expect(appendedChatCalls[0]!.entry.content).toBe("how many unread emails?");
        expect(appendedChatCalls[1]!.entry.role).toBe("assistant");
        expect(appendedChatCalls[1]!.entry.content).toBe("here is my answer");
      },
      { chatBackend: backend },
    );
  });

  it("persists attachment METADATA only — filename/mediaType/sizeBytes — never the raw base64 bytes, on the exact append call", async () => {
    const backend = makeFakeChatBackend();
    const appendedChatCalls: AppendedChatCall[] = [];
    const source = makeFakeSource({ appendedChatCalls });
    // Real PNG magic-byte prefix so this clears the content-sniffing check in validateAttachments.
    const imageBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("small payload", "utf8")]);
    const dataBase64 = imageBytes.toString("base64");
    await withServer(
      source,
      async (baseUrl) => {
        const res = await postChat(baseUrl, "work", {
          message: "what is this",
          attachments: [{ filename: "photo.png", mediaType: "image/png", dataBase64 }],
        });
        expect(res.status).toBe(200);

        // The backend DOES receive real decoded bytes (it needs them to call the model)...
        expect(backend.calls[0]!.attachments).toHaveLength(1);
        expect(backend.calls[0]!.attachments[0]!.data.equals(imageBytes)).toBe(true);

        // ...but the persisted call — what actually reaches storage — carries
        // only the whitelisted metadata shape, asserted on the exact params.
        const userAppend = appendedChatCalls[0]!;
        expect(userAppend.entry.attachments).toEqual([{ filename: "photo.png", mediaType: "image/png", sizeBytes: imageBytes.length }]);
        for (const att of userAppend.entry.attachments as unknown as Record<string, unknown>[]) {
          expect(Object.keys(att).sort()).toEqual(["filename", "mediaType", "sizeBytes"].sort());
          expect(JSON.stringify(att)).not.toContain(dataBase64);
        }
      },
      { chatBackend: backend },
    );
  });

  it("passes prior chat history to the backend as replay context, oldest-first", async () => {
    const backend = makeFakeChatBackend();
    const chatHistory = new Map<DomainId, ChatHistoryEntry[]>([
      [
        "work",
        [
          { role: "user", content: "first message", attachments: [], createdAt: new Date(Date.now() - 2000).toISOString() },
          { role: "assistant", content: "first reply", attachments: [], createdAt: new Date(Date.now() - 1000).toISOString() },
        ],
      ],
    ]);
    const source = makeFakeSource({ chatHistory });
    await withServer(
      source,
      async (baseUrl) => {
        await postChat(baseUrl, "work", { message: "second message" });
        expect(backend.calls[0]!.priorMessages).toEqual([
          { role: "user", content: "first message" },
          { role: "assistant", content: "first reply" },
        ]);
      },
      { chatBackend: backend },
    );
  });

  it("does NOT leak an older, unrelated conversation's content into a new conversation's LLM context (Tester HIGH #1 repro)", async () => {
    const backend = makeFakeChatBackend();
    // Full domain-wide DISPLAY history (recentChatHistory / GET .../history)
    // still contains the old conversation, including a literal PII string —
    // this is intentional; display spans every past session.
    const chatHistory = new Map<DomainId, ChatHistoryEntry[]>([
      [
        "work",
        [
          { role: "user", content: "my SSN is 123-45-6789", attachments: [], createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString() },
          { role: "assistant", content: "noted, from 30h ago", attachments: [], createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString() },
        ],
      ],
    ]);
    // The CURRENT-conversation-only context source is empty — the 24h idle
    // gap means a brand-new conversation was minted with no prior turns.
    const chatContext = new Map<DomainId, { role: ChatRole; content: string }[]>([["work", []]]);
    const source = makeFakeSource({ chatHistory, chatContext });

    await withServer(
      source,
      async (baseUrl) => {
        await postChat(baseUrl, "work", { message: "what's my SSN?" });

        // The backend — and therefore the model — never sees the old
        // conversation's content as context for the new one.
        expect(backend.calls[0]!.priorMessages).toEqual([]);
        const sentToModel = JSON.stringify(backend.calls[0]!.priorMessages);
        expect(sentToModel).not.toContain("123-45-6789");

        // Display/history is untouched by this — the old conversation is
        // still visible there, per the documented design.
        const historyRes = await fetch(`${baseUrl}/api/chat/work/history`);
        const historyBody = (await historyRes.json()) as { messages: ChatHistoryEntry[] };
        expect(historyBody.messages.some((m) => m.content.includes("123-45-6789"))).toBe(true);
      },
      { chatBackend: backend },
    );
  });

  it("on backend failure, the user turn is never orphaned in persisted history — nothing is written until the reply succeeds (Tester HIGH #3 repro)", async () => {
    const backend = makeFakeChatBackend({
      impl: async () => {
        throw new Error("simulated Anthropic API failure");
      },
    });
    const appendedChatCalls: AppendedChatCall[] = [];
    const chatHistory = new Map<DomainId, ChatHistoryEntry[]>();
    const source = makeFakeSource({ appendedChatCalls, chatHistory });

    await withServer(
      source,
      async (baseUrl) => {
        const res = await postChat(baseUrl, "work", { message: "this will fail" });
        expect(res.status).toBe(500);

        // Nothing was persisted — no dangling user message with no reply.
        expect(appendedChatCalls).toHaveLength(0);

        const historyRes = await fetch(`${baseUrl}/api/chat/work/history`);
        const historyBody = (await historyRes.json()) as { messages: ChatHistoryEntry[] };
        expect(historyBody.messages).toEqual([]);
      },
      { chatBackend: backend },
    );
  });

  it("a turn that succeeds AFTER a prior failed turn persists cleanly, with no residue from the failed attempt", async () => {
    let callCount = 0;
    const backend = makeFakeChatBackend({
      impl: async () => {
        callCount += 1;
        if (callCount === 1) throw new Error("simulated transient failure");
        return { text: "second attempt succeeded" };
      },
    });
    const appendedChatCalls: AppendedChatCall[] = [];
    const chatHistory = new Map<DomainId, ChatHistoryEntry[]>();
    const source = makeFakeSource({ appendedChatCalls, chatHistory });

    await withServer(
      source,
      async (baseUrl) => {
        const failedRes = await postChat(baseUrl, "work", { message: "first try" });
        expect(failedRes.status).toBe(500);
        expect(appendedChatCalls).toHaveLength(0);

        const okRes = await postChat(baseUrl, "work", { message: "second try" });
        expect(okRes.status).toBe(200);

        expect(appendedChatCalls).toHaveLength(2);
        expect(appendedChatCalls[0]!.entry).toMatchObject({ role: "user", content: "second try" });
        expect(appendedChatCalls[1]!.entry).toMatchObject({ role: "assistant", content: "second attempt succeeded" });
      },
      { chatBackend: backend },
    );
  });

  it("rejects an empty/missing message with 400 before the backend is called", async () => {
    const backend = makeFakeChatBackend();
    const source = makeFakeSource();
    await withServer(
      source,
      async (baseUrl) => {
        const res1 = await postChat(baseUrl, "work", { message: "" });
        expect(res1.status).toBe(400);
        const res2 = await postChat(baseUrl, "work", {});
        expect(res2.status).toBe(400);
        expect(backend.calls).toHaveLength(0);
      },
      { chatBackend: backend },
    );
  });

  it("wrong method on the chat send route returns 405", async () => {
    const source = makeFakeSource();
    await withServer(source, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/chat/work`, { method: "GET" });
      expect(res.status).toBe(405);
    });
  });

  it("POST to the chat route without the X-Jarvis-Dashboard header returns 403", async () => {
    const source = makeFakeSource();
    await withServer(source, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/chat/work`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hi" }),
      });
      expect(res.status).toBe(403);
    });
  });
});

describe("dashboard HTTP server: chat history route", () => {
  async function withServer<T>(
    source: DashboardSource,
    fn: (baseUrl: string) => Promise<T>,
  ): Promise<T> {
    const server = createDashboardServer(source, defaultServerOptions());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      return await fn(baseUrl);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  }

  it("GET /api/chat/:domain/history round-trips previously appended messages", async () => {
    const chatHistory = new Map<DomainId, ChatHistoryEntry[]>([
      [
        "work",
        [
          { role: "user", content: "hello", attachments: [], createdAt: new Date(Date.now() - 1000).toISOString() },
          {
            role: "assistant",
            content: "hi there",
            attachments: [{ filename: "note.txt", mediaType: "text/plain", sizeBytes: 12 }],
            createdAt: new Date().toISOString(),
          },
        ],
      ],
    ]);
    const source = makeFakeSource({ chatHistory });
    await withServer(source, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/chat/work/history`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { messages: ChatHistoryEntry[] };
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0]!.content).toBe("hello");
      expect(body.messages[1]!.content).toBe("hi there");
      expect(body.messages[1]!.attachments).toEqual([{ filename: "note.txt", mediaType: "text/plain", sizeBytes: 12 }]);
    });
  });

  it("GET history for an unknown domain returns 404", async () => {
    const source = makeFakeSource();
    await withServer(source, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/chat/not-a-real-domain/history`);
      expect(res.status).toBe(404);
    });
  });

  it("work and personal chat histories never leak into each other over HTTP", async () => {
    const chatHistory = new Map<DomainId, ChatHistoryEntry[]>([
      ["work", [{ role: "user", content: "work-only secret content", attachments: [], createdAt: new Date().toISOString() }]],
      ["personal", [{ role: "user", content: "personal-only secret content", attachments: [], createdAt: new Date().toISOString() }]],
    ]);
    const source = makeFakeSource({ chatHistory });
    await withServer(source, async (baseUrl) => {
      const workRes = await fetch(`${baseUrl}/api/chat/work/history`);
      const personalRes = await fetch(`${baseUrl}/api/chat/personal/history`);
      const workBody = (await workRes.json()) as { messages: ChatHistoryEntry[] };
      const personalBody = (await personalRes.json()) as { messages: ChatHistoryEntry[] };
      expect(workBody.messages.map((m) => m.content)).toEqual(["work-only secret content"]);
      expect(personalBody.messages.map((m) => m.content)).toEqual(["personal-only secret content"]);
    });
  });

  it("wrong method on the chat history route returns 405", async () => {
    const source = makeFakeSource();
    await withServer(source, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/chat/work/history`, { method: "POST", headers: { "x-jarvis-dashboard": "1" } });
      expect(res.status).toBe(405);
    });
  });
});
