import { DOMAINS, type DomainId } from "../config/domains.js";
import type { ApprovalRequest } from "../core/approvalGate.js";
import type { ChatHistoryEntry, ChatRole, ChatAttachmentMeta } from "../domain/chatHistoryStore.js";
import type { DashboardSource } from "../dashboard/types.js";
import type { DomainManager } from "./domainManager.js";
import type { OperationalMetadata } from "./operationalMetadata.js";
import type { DomainContentSummary } from "./domainContentSummary.js";

/**
 * The ONLY file allowed to import both DomainManager (which reaches every
 * domain-internal store) and the dashboard's narrow DashboardSource
 * interface. Everything on the dashboard side of this adapter only ever
 * sees manager.bus.snapshot(), manager.contentBus.snapshot(), each domain's
 * approvals.listPending(), and each domain's own chatHistory store reached
 * through the two methods below — no new raw channel across the domain
 * boundary is opened here; chat history crosses through the same
 * metadata-only ChatAttachmentMeta shape it's persisted as.
 */
export function createDashboardSource(manager: DomainManager): DashboardSource {
  return {
    listDomains(): { id: DomainId; label: string }[] {
      return Object.values(DOMAINS).map((config) => ({ id: config.id, label: config.label }));
    },

    snapshot(): ReadonlyMap<DomainId, OperationalMetadata> {
      return manager.bus.snapshot();
    },

    contentSnapshot(): ReadonlyMap<DomainId, DomainContentSummary> {
      return manager.contentBus.snapshot();
    },

    listPending(domainId: DomainId): ReadonlyMap<string, ApprovalRequest> {
      return manager.get(domainId).approvals.listPending();
    },

    async appendChatMessage(
      domainId: DomainId,
      entry: { role: ChatRole; content: string; attachments: ChatAttachmentMeta[] },
    ): Promise<void> {
      const chatHistory = manager.get(domainId).chatHistory;
      const conversationId = await chatHistory.currentConversationId();
      await chatHistory.append(conversationId, entry.role, entry.content, entry.attachments);
    },

    async recentChatHistory(domainId: DomainId, limit?: number): Promise<ChatHistoryEntry[]> {
      return manager.get(domainId).chatHistory.recentForDisplay(limit);
    },

    async recentChatContext(domainId: DomainId, limit?: number): Promise<{ role: ChatRole; content: string }[]> {
      // recentForContext() is conversation-scoped (it resolves the CURRENT
      // conversation id itself, same as appendChatMessage above) — the fix
      // for Tester HIGH #1: this must never be recentForDisplay(), which is
      // domain-wide across every past conversation.
      const entries = await manager.get(domainId).chatHistory.recentForContext(limit);
      return entries.map((e) => ({ role: e.role, content: e.content }));
    },
  };
}
