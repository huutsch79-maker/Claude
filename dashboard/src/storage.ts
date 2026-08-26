import type { ChatMessage } from "./types";

const CHAT_LOG_KEY = "jarvis_chat_log";
const CHAT_LOG_MAX = 200;
const SESSION_KEY = "jarvis_chat_session";

export function loadChatLog(): ChatMessage[] {
  try {
    return JSON.parse(localStorage.getItem(CHAT_LOG_KEY) || "[]");
  } catch {
    return [];
  }
}

export function saveChatLog(log: ChatMessage[]): void {
  localStorage.setItem(CHAT_LOG_KEY, JSON.stringify(log.slice(-CHAT_LOG_MAX)));
}

export function getSessionId(): string {
  const existing = localStorage.getItem(SESSION_KEY);
  if (existing) return existing;
  const fresh = crypto.randomUUID();
  localStorage.setItem(SESSION_KEY, fresh);
  return fresh;
}
