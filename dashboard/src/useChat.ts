import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api";
import { loadChatLog, saveChatLog, getSessionId } from "./storage";
import type { Attachment, ChatMessage, ChatTurnStatus } from "./types";

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 20 * 60 * 1000; // generous — a long content edit can mean many sequential tool calls

export function useChat() {
  const [log, setLog] = useState<ChatMessage[]>(() => loadChatLog());
  const [sending, setSending] = useState(false);
  const sessionId = useRef(getSessionId());

  function appendAndPersist(message: ChatMessage) {
    setLog((prev) => {
      const next = [...prev, message];
      saveChatLog(next);
      return next;
    });
  }

  async function send(text: string, attachments: Attachment[]) {
    if (sending) return; // guards against a second send racing this one's poll loop over the same session
    appendAndPersist({
      role: "user",
      text,
      attachments: attachments.map((a) => ({ mediaType: a.mediaType, filename: a.filename })),
    });
    setSending(true);

    try {
      await api("/api/chat", {
        method: "POST",
        body: JSON.stringify({ sessionId: sessionId.current, message: text, attachments }),
      });
      // The turn now runs server-side, not held open on this request — a
      // multi-tool-call turn can genuinely outlast Cloudflare's ~100s edge
      // timeout, so poll for the result instead of awaiting one long
      // request (that's what used to surface as "(error: HTTP 524)" even
      // when the turn was actually still working).
      await pollForReply();
    } catch (e) {
      appendAndPersist({ role: "assistant", text: `(error: ${e instanceof Error ? e.message : String(e)})` });
      setSending(false);
    }
  }

  async function pollForReply() {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const status = await api<ChatTurnStatus>(`/api/chat/${encodeURIComponent(sessionId.current)}/poll`);
      if (status.state === "done") {
        appendAndPersist({ role: "assistant", text: status.result.reply, toolCalls: status.result.toolCalls, widgets: status.result.widgets });
        break;
      }
      if (status.state === "error") {
        appendAndPersist({ role: "assistant", text: `(error: ${status.message})` });
        break;
      }
      // "running" or "idle" (a stale poll racing the turn's own startup) — keep waiting.
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    setSending(false);
  }

  return { log, sending, send };
}

/** Runs a callback on an interval, cleaned up automatically. */
export function useInterval(callback: () => void, ms: number) {
  useEffect(() => {
    const id = setInterval(callback, ms);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms]);
}
