import { useEffect, useState } from "preact/hooks";
import { api, getToken, setToken, ApiError } from "./api";
import { useChat } from "./useChat";
import { useToast } from "./toast";
import { Sidebar } from "./components/Sidebar";
import { ChatPane } from "./components/ChatPane";
import { Composer } from "./components/Composer";
import { ConnectScreen } from "./components/ConnectScreen";
import type { HealthReport } from "./types";

/** Reads ?oauth_connected=<ref> left by Microsoft's OAuth redirect, surfaces it, then drops the query param so a refresh doesn't re-show it. */
function useOauthRedirectToast(active: boolean) {
  const toast = useToast();
  useEffect(() => {
    if (!active) return;
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("oauth_connected");
    if (!connected) return;
    history.replaceState(null, "", window.location.pathname);
    toast.success(`Connected "${connected}" — it can be used right away, no redeploy needed.`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}

export function App() {
  const [connected, setConnected] = useState(false);
  const [connectError, setConnectError] = useState("");
  const [showConnect, setShowConnect] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [prefill, setPrefill] = useState("");
  const chat = useChat();

  async function tryConnect() {
    try {
      await api<HealthReport>("/api/health");
      setConnected(true);
      setShowConnect(false);
      setConnectError("");
    } catch (e) {
      setConnected(false);
      setShowConnect(true);
      setConnectError(e instanceof ApiError && e.message === "unauthorized" ? "Invalid token." : e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    tryConnect();
  }, []);

  useOauthRedirectToast(connected);

  if (showConnect) {
    return (
      <ConnectScreen
        initialToken={getToken()}
        error={connectError}
        onConnect={(token) => {
          setToken(token);
          tryConnect();
        }}
      />
    );
  }

  return (
    <div id="app">
      <Sidebar
        open={sidebarOpen}
        onOpenSettings={() => {
          setShowConnect(true);
          setSidebarOpen(false);
        }}
      />
      {sidebarOpen && <div class="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}
      <main class="main">
        <div class="mobile-topbar">
          <button class="icon-btn" title="Menu" onClick={() => setSidebarOpen((v) => !v)}>
            &#9776;
          </button>
          <span>JARVIS</span>
        </div>
        <ChatPane log={chat.log} sending={chat.sending} onPickPrompt={setPrefill} />
        <Composer disabled={chat.sending} onSend={chat.send} prefill={prefill} onPrefillConsumed={() => setPrefill("")} />
      </main>
    </div>
  );
}
