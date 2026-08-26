import type { ChatMessage as ChatMessageT, ChatWidget } from "../types";
import { renderMarkdown } from "../markdown";

function Widget({ widget }: { widget: ChatWidget }) {
  if (widget.type === "chart") {
    const max = Math.max(1, ...widget.series.map((s) => Number(s.value) || 0));
    return (
      <div class="widget">
        <div class="widget-title">{widget.title || "Chart"}</div>
        {widget.series.map((point, i) => {
          const pct = Math.max(2, ((Number(point.value) || 0) / max) * 100);
          return (
            <div class="chart-row" key={i}>
              <div class="chart-label">{point.label}</div>
              <div class="chart-bar-track">
                <div class="chart-bar-fill" style={{ width: `${pct}%` }} />
              </div>
              <div class="chart-value">
                {point.value}
                {widget.unit || ""}
              </div>
            </div>
          );
        })}
      </div>
    );
  }
  if (widget.type === "list") {
    return (
      <div class="widget">
        <div class="widget-title">{widget.title || "List"}</div>
        {widget.items.map((item, i) => (
          <div class="widget-list-item" key={i}>
            <div class="widget-list-primary">{item.primary}</div>
            {item.secondary && <div class="widget-list-secondary">{item.secondary}</div>}
            {item.meta && <div class="widget-list-meta">{item.meta}</div>}
          </div>
        ))}
      </div>
    );
  }
  // widget.type === "image"
  return (
    <div class="widget">
      <img src={widget.url} alt={widget.caption || ""} />
      {widget.caption && <div class="widget-caption">{widget.caption}</div>}
    </div>
  );
}

export function ChatMessage({ message }: { message: ChatMessageT }) {
  return (
    <div class={`chat-msg-row ${message.role}`}>
      <div class="chat-msg">
        {message.role === "assistant" ? (
          message.text && <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.text) }} />
        ) : (
          message.text
        )}

        {(message.attachments || []).map((att, i) => (
          <div class="attachment-chip" key={i}>
            📎 {att.filename || att.mediaType}
          </div>
        ))}

        {message.toolCalls && message.toolCalls.length > 0 && (
          <div class="tool-note">
            {message.toolCalls.map((t, i) => (
              <span class={t.ok ? "ok" : "err"} key={i}>
                {t.ok ? "✓" : "✗"} {t.capability}
              </span>
            ))}
          </div>
        )}

        {(message.widgets || []).map((w, i) => (
          <Widget widget={w} key={i} />
        ))}
      </div>
    </div>
  );
}

export function TypingIndicator() {
  return (
    <div class="typing-row">
      <div class="typing-bubble">
        <span class="typing-dot" />
        <span class="typing-dot" />
        <span class="typing-dot" />
      </div>
    </div>
  );
}
