import type { Insights as InsightsData, InsightTile } from "../types";

function formatCurrency(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(value);
  } catch {
    return `${currency} ${value.toFixed(0)}`;
  }
}

/** Renders a tile's not_connected/error states the same way everywhere, or hands off to a per-tile "ok" renderer. */
function Tile<T>({ title, tile, render }: { title: string; tile: InsightTile<T>; render: (data: T) => preact.JSX.Element }) {
  return (
    <div class="insight-tile">
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

function AzureCostTile({ tile }: { tile: InsightTile<{ monthToDate: number; lastMonth: number; currency: string }> }) {
  return (
    <Tile
      title="Azure cost"
      tile={tile}
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

export function Insights({ data }: { data: InsightsData | null }) {
  if (!data) return null;
  return (
    <div class="section insight-grid">
      <UnreadTile title="Personal inbox" tile={data.personalUnread} />
      <UnreadTile title="Work inbox" tile={data.workUnread} />
      <AzureCostTile tile={data.azureCost} />
    </div>
  );
}
