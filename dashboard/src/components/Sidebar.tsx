import { api } from "../api";
import { useSidebarData } from "../useSidebarData";
import { useToast } from "../toast";
import type { Capability, ScriptDef } from "../types";

function Badge({ text, cls }: { text: string; cls: string }) {
  return <span class={`badge ${cls}`}>{text}</span>;
}

function HealthSection({ health }: { health: ReturnType<typeof useSidebarData>["health"] }) {
  return (
    <div class="section">
      <h2>Health</h2>
      {!health ? (
        <div class="empty">no health report yet</div>
      ) : (
        <>
          <div class="item-row">
            <div class="item-sub">last reported</div>
            <div class="item-sub">{new Date(health.reportedAt).toLocaleTimeString()}</div>
          </div>
          {health.credentialStatus.map((c) => (
            <div class="item-row" key={c.credentialRef}>
              <div class="item-title">{c.credentialRef}</div>
              <Badge text={c.status} cls={c.status === "valid" ? "valid" : c.status === "expiring_soon" ? "expiring_soon" : "invalid"} />
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function ProposalsSection({ data, refresh }: { data: ReturnType<typeof useSidebarData>; refresh: () => void }) {
  const toast = useToast();
  async function act(id: string, action: "approve" | "reject") {
    try {
      await api(`/api/proposals/${id}/${action}`, { method: "POST" });
      refresh();
    } catch (e) {
      toast.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return (
    <div class="section">
      <h2>
        Proposals
        {data.proposals.length > 0 && <span class="count-badge">{data.proposals.length}</span>}
      </h2>
      {data.proposals.length === 0 && <div class="empty">none pending</div>}
      {data.proposals.map((p) => (
        <div class="item-row" key={p.id}>
          <div class="item-main">
            <div class="item-title">{p.summary}</div>
            <div class="item-sub">{p.category}</div>
          </div>
          <div class="btn-row">
            <button class="tiny" onClick={() => act(p.id, "approve")}>
              Ack
            </button>
            <button class="tiny danger" onClick={() => act(p.id, "reject")}>
              Dismiss
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
      toast.success(result.status === "pending_approval" ? "Proposed — needs approval below." : "Applied.");
      refresh();
    } catch (e) {
      toast.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function act(id: string, action: "approve" | "reject") {
    try {
      await api(`/api/scripts/${id}/${action}`, { method: "POST" });
      refresh();
    } catch (e) {
      toast.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const pendingRuns = data.scriptRuns.filter((r) => r.status === "pending_approval");

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
      {pendingRuns.map((r) => (
        <div class="item-row" key={r.id}>
          <div class="item-main">
            <div class="item-title">{r.scriptName}</div>
            <div class="item-sub">{r.detail || ""}</div>
          </div>
          <div class="btn-row">
            <button class="tiny" onClick={() => act(r.id, "approve")}>
              Approve
            </button>
            <button class="tiny danger" onClick={() => act(r.id, "reject")}>
              Reject
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

interface Props {
  open: boolean;
  onOpenSettings: () => void;
}

export function Sidebar({ open, onOpenSettings }: Props) {
  const data = useSidebarData();

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
      <HealthSection health={data.health} />
      <ProposalsSection data={data} refresh={data.refresh} />
      <ScriptsSection data={data} refresh={data.refresh} />
      <CapabilitiesSection data={data} refresh={data.refresh} />
    </aside>
  );
}
