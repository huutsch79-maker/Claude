import { useRef, useState } from "preact/hooks";
import type { Attachment } from "../types";
import { fileToAttachment, attachmentsFromClipboard, SUPPORTED_ATTACHMENT_TYPES } from "../attachments";

interface Props {
  disabled: boolean;
  onSend: (text: string, attachments: Attachment[]) => void;
  prefill: string;
  onPrefillConsumed: () => void;
}

export function Composer({ disabled, onSend, prefill, onPrefillConsumed }: Props) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Attachment[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (prefill && text !== prefill) {
    setText(prefill);
    onPrefillConsumed();
    // Focus after the value actually lands, not this render.
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function addFiles(files: Iterable<File>) {
    Promise.all([...files].map(fileToAttachment)).then((attachments) => setPending((prev) => [...prev, ...attachments]));
  }

  function submit() {
    if (disabled) return; // guards against Enter racing the send button's own disabled state
    const trimmed = text.trim();
    if (!trimmed && pending.length === 0) return;
    onSend(trimmed, pending);
    setText("");
    setPending([]);
  }

  return (
    <div class="composer">
      <div class="composer-inner">
        {pending.length > 0 && (
          <div class="pending-attachments">
            {pending.map((att, i) => (
              <span class="attachment-chip" key={i}>
                📎 {att.filename || att.mediaType}
                <button class="tiny" onClick={() => setPending((prev) => prev.filter((_, j) => j !== i))}>
                  &times;
                </button>
              </span>
            ))}
          </div>
        )}
        <div class="composer-row">
          <button class="icon-btn" title="Attach a file" onClick={() => fileInputRef.current?.click()}>
            📎
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={SUPPORTED_ATTACHMENT_TYPES}
            multiple
            onChange={(e) => {
              const files = (e.target as HTMLInputElement).files;
              if (files) addFiles(files);
              (e.target as HTMLInputElement).value = "";
            }}
          />
          <input
            ref={inputRef}
            type="text"
            placeholder="Message JARVIS…"
            value={text}
            onInput={(e) => setText((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            onPaste={(e) => {
              const files = attachmentsFromClipboard(e);
              if (files.length > 0) {
                e.preventDefault(); // a pasted image's own data: URI would otherwise also land in the text field
                addFiles(files);
              }
            }}
          />
          <button class="primary" disabled={disabled} onClick={submit}>
            Send
          </button>
        </div>
        <div class="composer-hint">Paste a screenshot directly into the message box to attach it.</div>
      </div>
    </div>
  );
}
