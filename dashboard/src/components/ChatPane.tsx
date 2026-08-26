import { useEffect, useRef } from "preact/hooks";
import type { ChatMessage as ChatMessageT } from "../types";
import { ChatMessage, TypingIndicator } from "./ChatMessage";

const EXAMPLE_PROMPTS = [
  "What's this VM's performance looking like?",
  "Show me my last few emails",
  "What's on my calendar this week?",
  "Any open reviewer proposals?",
];

function Welcome({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div class="welcome">
      <div class="welcome-mark">●</div>
      <h2>JARVIS is ready</h2>
      <p>One assistant, one memory, across work and everything else. Ask a question, attach a file, or try one of these:</p>
      <div class="welcome-prompts">
        {EXAMPLE_PROMPTS.map((p) => (
          <button key={p} onClick={() => onPick(p)}>
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

interface Props {
  log: ChatMessageT[];
  sending: boolean;
  onPickPrompt: (prompt: string) => void;
}

export function ChatPane({ log, sending, onPickPrompt }: Props) {
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log, sending]);

  return (
    <div class="chat-log" ref={logRef}>
      <div class="chat-log-inner">
        {log.length === 0 ? (
          <Welcome onPick={onPickPrompt} />
        ) : (
          <>
            {log.map((msg, i) => (
              <ChatMessage message={msg} key={i} />
            ))}
            {sending && <TypingIndicator />}
          </>
        )}
      </div>
    </div>
  );
}
