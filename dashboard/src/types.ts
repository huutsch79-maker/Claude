// Mirrors the response shapes dashboard.ts actually sends — kept as plain
// types here rather than imported from the orchestrator, since this is a
// separate frontend project with its own toolchain (see package.json).

export interface HealthReport {
  reportedAt: string;
  credentialStatus: Array<{ credentialRef: string; status: "valid" | "expiring_soon" | "invalid" }>;
}

export interface Proposal {
  id: string;
  summary: string;
  category: string;
  status: "pending" | "approved" | "rejected" | "applied";
}

export interface ScriptDef {
  name: string;
  description: string;
  trustTier: "auto_fix" | "requires_approval";
}

export interface ScriptRun {
  id: string;
  scriptName: string;
  detail?: string;
  status: "applied" | "pending_approval" | "rejected" | "failed";
}

export interface Capability {
  name: string;
  category: string | null;
  enabled: boolean;
  priority: number;
  credentialRef: string | null;
  modelOverride: string | null;
  oauthConfigured: boolean;
  oauthConnected: boolean;
}

export type InsightTile<T> = { status: "ok"; data: T } | { status: "not_connected" } | { status: "error"; message: string };

export interface Insights {
  personalUnread: InsightTile<{ unreadCount: number; totalCount: number }>;
  workUnread: InsightTile<{ unreadCount: number; totalCount: number }>;
  azureCost: InsightTile<{ monthToDate: number; lastMonth: number; currency: string }>;
  needsAttention: InsightTile<{ pendingProposals: number; pendingScripts: number }>;
}

export interface Attachment {
  mediaType: string;
  base64Data: string;
  filename?: string;
}

export type ChatWidget =
  | { type: "chart"; title: string; chartType: "bar" | "line"; series: Array<{ label: string; value: number }>; unit?: string }
  | { type: "list"; title: string; items: Array<{ primary: string; secondary?: string; meta?: string }> }
  | { type: "image"; url: string; caption?: string };

export interface ToolCall {
  capability: string;
  ok: boolean;
  summary: string;
}

export interface ChatTurnResult {
  reply: string;
  toolCalls: ToolCall[];
  widgets: ChatWidget[];
}

export type ChatTurnStatus =
  | { state: "idle" }
  | { state: "running" }
  | { state: "done"; result: ChatTurnResult }
  | { state: "error"; message: string };

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  attachments?: Array<{ mediaType: string; filename?: string }>;
  toolCalls?: ToolCall[];
  widgets?: ChatWidget[];
}
