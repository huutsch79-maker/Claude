import { createContext } from "preact";
import { useContext, useState, useCallback, useRef } from "preact/hooks";
import type { ComponentChildren } from "preact";

interface Toast {
  id: number;
  message: string;
  kind: "success" | "error";
}

interface ToastApi {
  success(message: string): void;
  error(message: string): void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast() called outside <ToastProvider>");
  return ctx;
}

const AUTO_DISMISS_MS = 5000;

export function ToastProvider({ children }: { children: ComponentChildren }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const push = useCallback((message: string, kind: Toast["kind"]) => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, message, kind }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), AUTO_DISMISS_MS);
  }, []);

  const api: ToastApi = {
    success: (message) => push(message, "success"),
    error: (message) => push(message, "error"),
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div class="toast-stack">
        {toasts.map((t) => (
          <div key={t.id} class={`toast ${t.kind}`}>
            {t.message}
            <button class="toast-close" onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))} aria-label="Dismiss">
              &times;
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
