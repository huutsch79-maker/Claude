import { api } from "../api";
import { useSidebarData } from "../useSidebarData";
import { useInsights } from "../useInsights";
import { useToast } from "../toast";
import { Insights } from "./Insights";
import type { Capability, ScriptDef } from "../types";

function Badge({ text, cls }: { text: string; cls: string }) {
  return <span class={`badge ${cls}`}>{text}</span>;
}

/** Collapsed to one line when everything's fine; only lists credentials when one of them isn't valid — the "always-on wall of text" this replaced showed every credential every time. */
function HealthSection({ health }: { health: ReturnType<typeof useSidebarData>["health"] }) {
  if (!health) return null;
  const problems = health.credentialStatus.filter((c) => c.status !== "valid");
  if (problems.length === 0) {
    return (
      <div class="section health-ok">
        <span class="status-dot ok" /> all credentials valid
      </div>
    );
  }
  return (
    <div class="section">
      <h2>Health</h2>
      {problems.map((c) => (
        <div class="item-row" key={c.credentialRef}>
          <div class="item-title">{c.credentialRef}</div>
          <Badge text={c.status} cls={c.status === "expiring_soon" ? "expiring_soon" : "invalid"} />
        </div>
      ))}
    </div>
  );
}

type AttentionItem =
  | { kind: "proposal"; id: string; title: string; sub: string }
  | { kind: "script"; id: string; title: string; sub: string };

/** Everything that's actually waiting on the user, merged into one list — replaces the old always-visible Proposals and pending-Scripts sections, which took up sidebar space even when empty of anything actionable. */
function NeedsAttentionSection({ data, refresh }: { data: ReturnType<typeof useSidebarData>; refresh: () => void }) {
  const toast = useToast();

  async function actProposal(id: string, action: "approve" | "reject") {
    try {
      await api(`/api/proposals/${id}/${action}`, { method: "POST" });
      refresh();
    } catch (e) {
      toast.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function actScript(id: string, action: "approve" | "reject") {
    try {
      await api(`/api/scripts/${id}/${action}`, { method: "POST" });
      refresh();
    } catch (e) {
      toast.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const pendingRuns = data.scriptRuns.filter((r) => r.status === "pending_approval");
  const items: AttentionItem[] = [
    ...data.proposals.map((p) => ({ kind: "proposal" as const, id: p.id, title: p.summary, sub: p.category })),
    ...pendingRuns.map((r) => ({ kind: "script" as const, id: r.id, title: r.scriptName, sub: r.detail || "awaiting approval" })),
  ];

  if (items.length === 0) return null;

  return (
    <div class="section">
      <h2>
        Needs Attention
        <span class="count-badge">{items.length}</span>
      </h2>
      {items.map((item) => (
        <div class="item-row" key={`${item.kind}-${item.id}`}>
          <div class="item-main">
            <div class="item-title">{item.title}</div>
            <div class="item-sub">{item.sub}</div>
          </div>
          <div class="btn-row">
            <button class="tiny" onClick={() => (item.kind === "proposal" ? actProposal(item.id, "approve") : actScript(item.id, "approve"))}>
              {item.kind === "proposal" ? "Ack" : "Approve"}
            </button>
            <button class="tiny danger" onClick={() => (item.kind === "proposal" ? actProposal(item.id, "reject") : actScript(item.id, "reject"))}>
              {item.kind === "proposal" ? "Dismiss" : "Reject"}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function ScriptsSection({ data, refresh }: { data: ReturnType<typeof useSidebarData>; refresh: () => void }) {
  const toast = useToast();

  async function run(s: ScriptDef) {
    let args: Record<string, string> = {};
    if (s.name === "apply-migration") {
      const file = prompt("migration filename (must exist in db/migrations/):");
      if (!file) return;
      args = { file };
    }
    try {
      const result = await api<{ status: string }>(`/api/scripts/${s.name}/run`, { method: "POST", body: JSON.stringify({ args }) });
      toast.success(result.status === "pending_approval" ? "Proposed — needs approval above." : "Applied.");
      refresh();
    } catch (e) {
      toast.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <div class="section">
      <h2>Scripts</h2>
      {data.scripts.map((s) => (
        <div class="item-row" key={s.name}>
          <div class="item-main">
            <div class="item-title">{s.name}</div>
            <div class="item-sub">{s.description}</div>
          </div>
          <div class="btn-row">
            <Badge text={s.trustTier} cls={s.trustTier} />
            <button class="tiny" onClick={() => run(s)}>
              Run
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function CapabilitiesSection({ data, refresh }: { data: ReturnType<typeof useSidebarData>; refresh: () => void }) {
  const toast = useToast();

  async function connect(c: Capability) {
    try {
      const { url } = await api<{ url: string }>(`/api/oauth/${encodeURIComponent(c.credentialRef ?? "")}/authorize-url`);
      window.location.href = url; // leaves the page for Microsoft's consent screen
    } catch (e) {
      toast.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function toggleEnabled(c: Capability) {
    try {
      await api(`/api/capabilities/${c.name}/enabled`, { method: "POST", body: JSON.stringify({ enabled: !c.enabled }) });
      refresh();
    } catch (e) {
      toast.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <div class="section">
      <h2>Capabilities</h2>
      {data.capabilities.length === 0 && <div class="empty">none registered</div>}
      {data.capabilities.map((c) => (
        <div class="item-row" key={c.name}>
          <div class="item-main">
            <div class="item-title">
              {c.name}
              <span class="cat-chip">{c.category || "uncategorized"}</span>
            </div>
            <div class="item-sub">{c.credentialRef ? `cred: ${c.credentialRef}` : ""}</div>
          </div>
          <div class="btn-row">
            {c.oauthConfigured && (
              <>
                {c.oauthConnected && <Badge text="Connected" cls="valid" />}
                <button class="tiny" onClick={() => connect(c)}>
                  {c.oauthConnected ? "Reconnect" : "Connect"}
                </button>
              </>
            )}
            <button class="tiny" onClick={() => toggleEnabled(c)}>
              {c.enabled ? "Disable" : "Enable"}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** The full catalog — every script and every capability, whether or not anything needs attention right now. Collapsed by default: it's reference/config material, not something worth a permanent block of screen space in a chat-first dashboard. */
function AdvancedSection({ data, refresh }: { data: ReturnType<typeof useSidebarData>; refresh: () => void }) {
  return (
    <details class="section advanced-disclosure">
      <summary>Advanced</summary>
      <ScriptsSection data={data} refresh={refresh} />
      <CapabilitiesSection data={data} refresh={refresh} />
    </details>
  );
}

interface Props {
  open: boolean;
  onOpenSettings: () => void;
}

export function Sidebar({ open, onOpenSettings }: Props) {
  const data = useSidebarData();
  const { insights } = useInsights();

  return (
    <aside class={`sidebar ${open ? "open" : ""}`}>
      <div class="sidebar-header">
        <h1>
          <span class={`status-dot ${data.health ? "ok" : "err"}`} /> JARVIS
        </h1>
        <button class="icon-btn" title="Connection settings" onClick={onOpenSettings}>
          &#9881;
        </button>
      </div>
      <Insights data={insights} />
      <NeedsAttentionSection data={data} refresh={data.refresh} />
      <HealthSection health={data.health} />
      <AdvancedSection data={data} refresh={data.refresh} />
    </aside>
  );
}
