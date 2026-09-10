import type { CredentialStore } from "../../../domain/credentialStore.js";
import type { MailSummary } from "../../../orchestrator/domainContentSummary.js";
import { MAX_DISPLAY_NAME_LEN, MAX_TOP_SENDERS } from "../../../orchestrator/domainContentSummary.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const RECENT_WINDOW_SIZE = 50; // how many recent messages to scan for top-sender aggregation

/**
 * Real Microsoft Graph GET /me/messages call pattern, mirroring
 * index.ts's existing fetch/auth pattern, aggregated into a MailSummary.
 * Never throws: a missing credential produces "not_configured", any
 * connector failure is caught into "error". Gated on
 * JARVIS_PERSONAL_HOTMAIL_OAUTH via CredentialStore, exactly like the
 * hotmail capability module's own credential lookup.
 */
export async function fetchHotmailSummary(
  credentials: CredentialStore,
  fetchImpl: typeof fetch = fetch,
): Promise<MailSummary> {
  const credential = credentials.get("hotmail-oauth");
  if (!credential) {
    return notConfigured();
  }

  try {
    const authHeader = { authorization: `Bearer ${credential.value}` };

    const unreadCountRes = await fetchImpl(
      `${GRAPH_BASE}/me/messages?$filter=isRead eq false&$count=true&$top=1&$select=id`,
      { headers: { ...authHeader, ConsistencyLevel: "eventual" } },
    );
    if (!unreadCountRes.ok) throw new Error(`Graph unread-count request failed (${unreadCountRes.status})`);
    const unreadBody = (await unreadCountRes.json()) as { ["@odata.count"]?: number };

    const totalCountRes = await fetchImpl(`${GRAPH_BASE}/me/messages?$count=true&$top=1&$select=id`, {
      headers: { ...authHeader, ConsistencyLevel: "eventual" },
    });
    if (!totalCountRes.ok) throw new Error(`Graph total-count request failed (${totalCountRes.status})`);
    const totalBody = (await totalCountRes.json()) as { ["@odata.count"]?: number };

    const recentRes = await fetchImpl(
      `${GRAPH_BASE}/me/messages?$top=${RECENT_WINDOW_SIZE}&$select=from&$orderby=receivedDateTime desc`,
      { headers: authHeader },
    );
    if (!recentRes.ok) throw new Error(`Graph recent-messages request failed (${recentRes.status})`);
    const recentBody = (await recentRes.json()) as GraphMessagesResponse;

    return {
      status: "connected",
      unreadCount: unreadBody["@odata.count"] ?? 0,
      totalCount: totalBody["@odata.count"] ?? 0,
      topSenders: aggregateTopSenders(recentBody.value ?? []),
      lastSyncedAt: new Date().toISOString(),
    };
  } catch {
    return errorResult();
  }
}

interface GraphMessagesResponse {
  value?: { from?: { emailAddress?: { name?: string; address?: string } } }[];
}

function aggregateTopSenders(messages: NonNullable<GraphMessagesResponse["value"]>): MailSummary["topSenders"] {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const emailAddress = message.from?.emailAddress;
    const name = emailAddress?.name || emailAddress?.address;
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TOP_SENDERS)
    .map(([displayName, messageCount]) => ({
      displayName: displayName.slice(0, MAX_DISPLAY_NAME_LEN),
      messageCount,
    }));
}

function notConfigured(): MailSummary {
  return { status: "not_configured", unreadCount: 0, totalCount: 0, topSenders: [], lastSyncedAt: null };
}

function errorResult(): MailSummary {
  return { status: "error", unreadCount: 0, totalCount: 0, topSenders: [], lastSyncedAt: null };
}
