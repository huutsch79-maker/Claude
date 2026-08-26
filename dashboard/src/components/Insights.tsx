import type { Insights as InsightsData, InsightTile } from "../types";

function formatCurrency(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(value);
  } catch {
    return `${currency} ${value.toFixed(0)}`;
  }
}

/** Renders a tile's not_connected/error states the same way everywhere, or hands off to a per-tile "ok" renderer. */
function Tile<T>({ title, tile, wide, render }: { title: string; tile: InsightTile<T>; wide?: boolean; render: (data: T) => preact.JSX.Element }) {
  return (
    <div class={`insight-tile ${wide ? "insight-tile-wide" : ""}`}>
      <div class="insight-tile-title">{title}</div>
      {tile.status === "not_connected" && <div class="insight-tile-empty">not connected</div>}
      {tile.status === "error" && (
        <div class="insight-tile-empty" title={tile.message}>
          unavailable
        </div>
      )}
      {tile.status === "ok" && render(tile.data)}
    </div>
  );
}

function UnreadTile({ title, tile }: { title: string; tile: InsightTile<{ unreadCount: number; totalCount: number }> }) {
  return (
    <Tile
      title={title}
      tile={tile}
      render={(data) => (
        <div class="insight-stat" title={`${data.unreadCount} unread of ${data.totalCount} in the inbox`}>
          <span class="insight-stat-num">{data.unreadCount}</span>
          <span class="insight-stat-unit">unread</span>
        </div>
      )}
    />
  );
}

function UsageWasteTile({ tile }: { tile: InsightTile<{ inactiveMailboxes: number; totalMailboxes: number }> }) {
  return (
    <Tile
      title="Inactive mailboxes"
      tile={tile}
      render={(data) => (
        <div class="insight-stat" title={`${data.inactiveMailboxes} of ${data.totalMailboxes} NZB mailboxes had no activity in the last 30 days`}>
          <span class="insight-stat-num">{data.inactiveMailboxes}</span>
          <span class="insight-stat-unit">of {data.totalMailboxes} idle 30d</span>
        </div>
      )}
    />
  );
}

function AzureCostTile({ tile }: { tile: InsightTile<{ monthToDate: number; lastMonth: number; currency: string }> }) {
  return (
    <Tile
      title="Azure cost"
      tile={tile}
      wide
      render={(data) => {
        const max = Math.max(data.monthToDate, data.lastMonth, 1);
        return (
          <div class="insight-cost">
            <div class="insight-cost-row" title={`Month to date: ${formatCurrency(data.monthToDate, data.currency)}`}>
              <span class="insight-cost-label">MTD</span>
              <div class="chart-bar-track insight-cost-track">
                <div class="chart-bar-fill" style={{ width: `${(data.monthToDate / max) * 100}%` }} />
              </div>
              <span class="insight-cost-value">{formatCurrency(data.monthToDate, data.currency)}</span>
            </div>
            <div class="insight-cost-row" title={`Last month: ${formatCurrency(data.lastMonth, data.currency)}`}>
              <span class="insight-cost-label">Last mo.</span>
              <div class="chart-bar-track insight-cost-track">
                <div class="chart-bar-fill insight-cost-fill-muted" style={{ width: `${(data.lastMonth / max) * 100}%` }} />
              </div>
              <span class="insight-cost-value">{formatCurrency(data.lastMonth, data.currency)}</span>
            </div>
          </div>
        );
      }}
    />
  );
}

const RUN_STATUS_META: Array<{ key: "applied" | "failed" | "pending" | "rejected"; label: string; cls: string }> = [
  { key: "applied", label: "Applied", cls: "insight-bar-good" },
  { key: "failed", label: "Failed", cls: "insight-bar-critical" },
  { key: "pending", label: "Pending", cls: "insight-bar-warning" },
  { key: "rejected", label: "Rejected", cls: "insight-bar-muted" },
];

function ScriptRunHistoryTile({ tile }: { tile: InsightTile<{ applied: number; failed: number; pending: number; rejected: number }> }) {
  return (
    <Tile
      title="Recent script runs"
      tile={tile}
      wide
      render={(data) => {
        const total = data.applied + data.failed + data.pending + data.rejected;
        if (total === 0) return <div class="insight-tile-empty">no runs yet</div>;
        const max = Math.max(data.applied, data.failed, data.pending, data.rejected, 1);
        return (
          <div class="insight-cost">
            {RUN_STATUS_META.filter((s) => data[s.key] > 0).map((s) => (
              <div class="insight-cost-row" key={s.key}>
                <span class="insight-cost-label">{s.label}</span>
                <div class="chart-bar-track insight-cost-track">
                  <div class={`chart-bar-fill ${s.cls}`} style={{ width: `${(data[s.key] / max) * 100}%` }} />
                </div>
                <span class="insight-cost-value">{data[s.key]}</span>
              </div>
            ))}
          </div>
        );
      }}
    />
  );
}

/** Only status entries that aren't fully valid ever reach here (see fetchCredentialHealth) — an empty list means everything tracked is healthy. */
export function CredentialHealthSection({
  tile,
}: {
  tile: InsightTile<{ totalTracked: number; atRisk: Array<{ credentialRef: string; status: string; daysRemaining: number | null }> }>;
}) {
  if (tile.status !== "ok") return null;
  if (tile.data.atRisk.length === 0) {
    return (
      <div class="section health-ok">
        <span class="status-dot ok" /> all {tile.data.totalTracked} tracked credentials valid
      </div>
    );
  }
  return (
    <div class="section">
      <h2>Credential Health</h2>
      {tile.data.atRisk.map((c) => (
        <div class="item-row" key={c.credentialRef}>
          <div class="item-title">{c.credentialRef}</div>
          <div class="btn-row">
            {c.daysRemaining !== null && <span class="item-sub">{c.daysRemaining >= 0 ? `${c.daysRemaining}d left` : "expired"}</span>}
            <span class={`badge ${c.status}`}>{c.status}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function Insights({ data }: { data: InsightsData | null }) {
  if (!data) return null;
  return (
    <div class="section insight-grid">
      <UnreadTile title="Personal inbox" tile={data.personalUnread} />
      <UnreadTile title="Work inbox" tile={data.workUnread} />
      <UsageWasteTile tile={data.usageWaste} />
      <AzureCostTile tile={data.azureCost} />
      <ScriptRunHistoryTile tile={data.scriptRunHistory} />
    </div>
  );
}
