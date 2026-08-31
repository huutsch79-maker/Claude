import { DOMAIN_IDS, DOMAINS } from "../config/domains.js";

/**
 * Static skeleton, built server-side from DOMAIN_IDS/DOMAINS so a plain
 * GET / (or curl) shows the mode bar and both domain labels immediately —
 * before any JS has run and before the first /api/state fetch resolves.
 */
const MODE_BAR_SEGMENTS = DOMAIN_IDS.map(
  (id, i) =>
    `<button type="button" class="segment${i === 0 ? " segment-active" : ""}" role="radio" aria-checked="${i === 0 ? "true" : "false"}" data-domain="${id}">${escapeForTemplate(DOMAINS[id].label)}</button>`,
).join("");

const DOMAIN_LABELS_JSON = JSON.stringify(
  Object.fromEntries(DOMAIN_IDS.map((id) => [id, DOMAINS[id].label])),
);

function escapeForTemplate(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * The dashboard page as an exported template literal, not a file on disk —
 * tsc/Docker copy semantics differ between src/ and dist/, so this avoids
 * needing to ship a static asset alongside the compiled JS. Inline CSS +
 * inline vanilla JS only: no framework, no build step, no CDN.
 *
 * "Domain Mode": one domain on screen at a time via a real mode switch (the
 * mode bar), not a tab. The 5s /api/state poll always carries BOTH
 * domains' data (see readModel.ts) so a domain switch never needs a fresh
 * network fetch of health/content — only chat history is domain-specific
 * and fetched on switch. See the big inline <script> below for the state
 * machine (renderAll/switchDomain/sendMessage).
 */
export const DASHBOARD_HTML: string = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>JARVIS v2 Dashboard</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f4f5f7;
    --card-bg: #ffffff;
    --text: #1b1e23;
    --muted: #5b6270;
    --border: #dde1e6;

    /* Status tokens — one consistent system, reused everywhere a status
       color is needed (pills, chips, freshness line, error banners).
       Never used for a data mark (chart hue is separate, below). */
    --pill-valid: #1e7d34;      --pill-valid-bg: #e4f6e9;
    --pill-warn: #8a5a00;       --pill-warn-bg: #fff2d9;
    --pill-expired: #a3231f;    --pill-expired-bg: #fbe6e5;
    --pill-invalid: #a3231f;    --pill-invalid-bg: #fbe6e5;

    /* Neutral ghost/gray ink for not_configured / awaiting-first-report —
       visually distinct from every status color above. */
    --ghost-border: #b6bcc6;
    --ghost-text: #6b7280;
    --ghost-bg: transparent;

    /* One data accent hue for every chart mark on the page (meter fill +
       both ranked-bar lists). Track is a lighter step of the SAME hue. */
    --data-fill: hsl(211 70% 45%);
    --data-track: hsl(211 55% 90%);

    /* Two low-chroma domain accent colors — chrome only (mode bar tint +
       edge stripe), never a data mark or status color. */
    --accent-work: #3d5a72;
    --accent-personal: #6d4f60;

    --bubble-user-bg: hsl(211 70% 45%);
    --bubble-user-text: #ffffff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14161a;
      --card-bg: #1e2126;
      --text: #e7e9ec;
      --muted: #9aa1ac;
      --border: #2c3038;

      --pill-valid: #7fe0a0;      --pill-valid-bg: #163821;
      --pill-warn: #f0c674;       --pill-warn-bg: #3a2d0e;
      --pill-expired: #f5918e;    --pill-expired-bg: #3a1716;
      --pill-invalid: #f5918e;    --pill-invalid-bg: #3a1716;

      --ghost-border: #454b56;
      --ghost-text: #9aa1ac;

      --data-fill: hsl(211 80% 68%);
      --data-track: hsl(211 35% 22%);

      --accent-work: #7fa1bd;
      --accent-personal: #bf98ac;

      --bubble-user-bg: hsl(211 55% 38%);
      --bubble-user-text: #f2f5f8;
    }
  }
  * { box-sizing: border-box; }
  html, body { background: var(--bg); }
  body {
    margin: 0;
    padding: 0 0 32px;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    border-left: 4px solid var(--accent-work);
  }
  body[data-domain="personal"] { border-left-color: var(--accent-personal); }

  /* ---------- mode bar (sticky, instant swap, never a tab) ---------- */
  .mode-bar {
    position: sticky;
    top: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 10px 20px;
    background: var(--card-bg);
    border-bottom: 1px solid var(--border);
  }
  .wordmark { font-weight: 700; font-size: 14px; letter-spacing: 0.03em; }
  .segmented { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .segment {
    appearance: none;
    border: none;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: 13px;
    padding: 6px 14px;
    cursor: pointer;
  }
  .segment + .segment { border-left: 1px solid var(--border); }
  .segment-active { background: var(--accent-work); color: #fff; font-weight: 600; }
  body[data-domain="personal"] .segment-active { background: var(--accent-personal); }

  main { max-width: 1080px; margin: 0 auto; padding: 20px; }

  /* ---------- KPI row ---------- */
  .kpi-row { display: flex; flex-wrap: wrap; gap: 14px; margin-bottom: 20px; }
  .tile {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 16px;
    flex: 1 1 180px;
    min-width: 150px;
  }
  .tile-label { margin: 0 0 6px; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .tile-value { margin: 0; font-size: 32px; font-weight: 600; font-variant-numeric: proportional-nums; line-height: 1.1; }
  #kpi-content .tile:first-child .tile-value { font-size: 48px; }
  .tile-value-warn { color: var(--pill-warn); }
  .tile-sub { margin: 4px 0 0; font-size: 12px; color: var(--muted); }
  .metric-dim { opacity: 0.55; }

  /* ghost block — not_configured / awaiting-first-report. Never a status
     color, never a numeral. */
  .ghost-block {
    border: 1px dashed var(--ghost-border);
    border-radius: 8px;
    padding: 10px 12px;
    color: var(--ghost-text);
    background: var(--ghost-bg);
  }
  .ghost-reason { margin: 0 0 2px; font-size: 13px; font-weight: 600; }
  .ghost-fix { margin: 0; font-size: 12px; }

  .content-error-banner {
    background: var(--pill-expired-bg);
    color: var(--pill-expired);
    font-size: 12px;
    font-weight: 600;
    padding: 4px 8px;
    border-radius: 6px;
    margin-bottom: 8px;
  }

  .freshness { font-size: 12px; color: var(--muted); margin: 4px 0 0; }
  .freshness-stale { color: var(--pill-warn); font-weight: 600; }

  /* ---------- status chips (health band summary line) ---------- */
  .chip { display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; margin-right: 6px; }
  .chip-valid { background: var(--pill-valid-bg); color: var(--pill-valid); }
  .chip-warn { background: var(--pill-warn-bg); color: var(--pill-warn); }
  .chip-expired { background: var(--pill-expired-bg); color: var(--pill-expired); }
  .chip-ghost { background: transparent; border: 1px dashed var(--ghost-border); color: var(--ghost-text); }

  /* ---------- panel grid ---------- */
  .panel-grid { display: flex; flex-wrap: wrap; gap: 14px; margin-bottom: 20px; align-items: flex-start; }
  .panel {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px;
    flex: 1 1 360px;
    min-width: 280px;
  }
  .panel-full { flex-basis: 100%; }
  .panel-title { margin: 0 0 10px; font-size: 14px; }

  .meter { height: 10px; border-radius: 6px; background: var(--data-track); overflow: hidden; }
  .meter-fill { height: 100%; background: var(--data-fill); }
  .meter-caption { margin: 6px 0 0; font-size: 12px; color: var(--muted); }

  .bar-list { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
  .bar-row { display: flex; align-items: center; gap: 8px; }
  .bar-label { flex: 0 0 130px; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-track { flex: 1; height: 20px; max-height: 24px; border-radius: 4px; background: var(--data-track); overflow: hidden; }
  .bar-fill { height: 100%; background: var(--data-fill); }
  .bar-value { flex: 0 0 auto; font-size: 12px; color: var(--muted); min-width: 24px; text-align: right; }

  .empty-state { color: var(--muted); font-size: 13px; font-style: italic; margin: 4px 0 0; }

  /* ---------- health band ---------- */
  .health-band {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    margin-bottom: 20px;
    padding: 0;
  }
  .health-band > summary {
    list-style: none;
    cursor: pointer;
    padding: 12px 16px;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    font-weight: 600;
  }
  .health-band > summary::-webkit-details-marker { display: none; }
  .health-band > summary::before { content: "▸"; display: inline-block; transition: none; color: var(--muted); font-weight: 400; }
  .health-band[open] > summary::before { content: "▾"; }
  .health-band-body { padding: 0 16px 16px; }
  section { margin-bottom: 16px; }
  section:last-child { margin-bottom: 0; }
  .section-title { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin: 0 0 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 600; }
  .pill { display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; }
  .pill-valid { background: var(--pill-valid-bg); color: var(--pill-valid); }
  .pill-expiring_soon { background: var(--pill-warn-bg); color: var(--pill-warn); }
  .pill-expired { background: var(--pill-expired-bg); color: var(--pill-expired); }
  .pill-invalid { background: var(--pill-invalid-bg); color: var(--pill-invalid); }
  .error-counts { font-size: 13px; display: flex; gap: 18px; }
  .error-counts .fatal-nonzero { color: var(--pill-expired); font-weight: 700; }

  /* ---------- chat ---------- */
  .chat { background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
  .chat-header { margin: 0 0 10px; font-size: 15px; }
  .chat-thread {
    max-height: min(60vh, 640px);
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px;
    background: var(--bg);
  }
  .chat-loading, .chat-empty { color: var(--muted); font-size: 13px; }
  .chat-empty { color: var(--text); }
  .chat-load-failed { background: var(--pill-expired-bg); color: var(--pill-expired); padding: 8px 10px; border-radius: 8px; font-size: 13px; }
  .chat-retry-btn { margin-left: 8px; font: inherit; font-size: 12px; cursor: pointer; border: 1px solid currentColor; background: transparent; color: inherit; border-radius: 6px; padding: 2px 8px; }

  .bubble { max-width: 82%; margin-bottom: 10px; padding: 8px 12px; border-radius: 12px; font-size: 13.5px; line-height: 1.45; }
  .bubble-role-label { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin-bottom: 2px; }
  .bubble-user { margin-left: auto; background: var(--bubble-user-bg); color: var(--bubble-user-text); border-bottom-right-radius: 3px; }
  .bubble-assistant { margin-right: auto; background: transparent; border: 1px solid var(--border); color: var(--text); border-bottom-left-radius: 3px; }
  .bubble-text { white-space: pre-wrap; word-break: break-word; }
  .bubble-thinking .bubble-text { animation: jarvis-pulse 1.6s ease-in-out infinite; }
  @keyframes jarvis-pulse { 0%, 100% { opacity: 0.45; } 50% { opacity: 1; } }

  .session-divider { display: flex; align-items: center; gap: 8px; margin: 14px 0; color: var(--muted); font-size: 11px; }
  .session-divider::before, .session-divider::after { content: ""; flex: 1; height: 1px; background: var(--border); }

  /* Pending attachment chip (before sending) and the historical attachment
     note (after sending / on reload) are DELIBERATELY separate component
     classes with no shared base class. */
  .pending-attachment-chip {
    display: inline-flex; align-items: center; gap: 6px;
    border: 1px solid var(--border); border-radius: 8px;
    padding: 3px 6px 3px 10px; font-size: 12px; color: var(--text);
    margin: 2px 6px 2px 0;
  }
  .pending-attachment-error { border-color: var(--pill-expired); color: var(--pill-expired); }
  .pending-attachment-chip button {
    border: none; background: none; cursor: pointer; color: inherit;
    font-size: 15px; line-height: 1; padding: 0 2px;
  }
  .historical-attachment-note {
    display: block; font-size: 11px; color: var(--muted); margin-top: 4px;
    pointer-events: none;
  }

  .pending-attachments:empty { display: none; }
  .pending-attachments { margin-bottom: 6px; }

  .composer-row { display: flex; align-items: flex-end; gap: 8px; }
  #attach-btn {
    flex: 0 0 auto; border: 1px solid var(--border); background: var(--card-bg); color: var(--text);
    border-radius: 8px; width: 34px; height: 34px; cursor: pointer; font-size: 15px;
  }
  #chat-input {
    flex: 1; resize: vertical; min-height: 34px; max-height: 160px;
    border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px;
    font: inherit; font-size: 13.5px; background: var(--card-bg); color: var(--text);
  }
  #send-btn {
    flex: 0 0 auto; border: none; border-radius: 8px; padding: 0 16px; height: 34px;
    background: var(--accent-work); color: #fff; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
  }
  body[data-domain="personal"] #send-btn { background: var(--accent-personal); }
  #attach-btn:disabled, #chat-input:disabled, #send-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .composer-footnote { margin: 8px 0 0; font-size: 11px; color: var(--muted); line-height: 1.5; }

  .load-error { color: var(--pill-expired); font-size: 13px; margin: 0 20px 16px; }
  [hidden] { display: none !important; }
</style>
</head>
<body data-domain="${DOMAIN_IDS[0]}">
  <header class="mode-bar">
    <span class="wordmark">JARVIS</span>
    <div class="segmented" role="radiogroup" aria-label="Domain">${MODE_BAR_SEGMENTS}</div>
  </header>

  <div id="load-error" class="load-error" hidden></div>

  <main>
    <div id="kpi-content" class="kpi-row"></div>
    <div id="kpi-health" class="kpi-row"></div>

    <div id="panel-grid" class="panel-grid"></div>

    <details id="health-band" class="health-band">
      <summary><span id="health-band-chips"></span></summary>
      <div id="health-band-body" class="health-band-body"></div>
    </details>

    <section id="chat" class="chat">
      <h2 id="chat-header" class="chat-header"></h2>
      <div id="chat-thread" class="chat-thread" aria-live="polite"></div>
      <form id="chat-composer">
        <div id="pending-attachments" class="pending-attachments"></div>
        <div class="composer-row">
          <button type="button" id="attach-btn" aria-label="Attach file" title="Attach file">📎</button>
          <input type="file" id="file-input" multiple hidden>
          <textarea id="chat-input" rows="1" placeholder="Ask JARVIS…" aria-label="Message"></textarea>
          <button type="submit" id="send-btn">Send</button>
        </div>
        <p class="composer-footnote">
          Conversation is saved for this domain.<br>
          Attachments are only visible to JARVIS in the message you send them — they can't be reopened later.
        </p>
      </form>
    </section>
  </main>

<script>
(function () {
  var DOMAIN_LABELS = ${DOMAIN_LABELS_JSON};
  var POLL_MS = 5000;
  var MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  var MAX_IMAGES = 5;
  var MAX_DOC_BYTES = 10 * 1024 * 1024;
  var IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
  var DOC_TYPES = ["application/pdf", "text/plain"];

  var currentDomain = "${DOMAIN_IDS[0]}";
  var domainGeneration = 0;
  var healthBandRenderedGen = -1;
  var latestPayload = null;

  var chatMessages = [];
  var chatThreadState = "loading"; // loading | loaded | empty | load-failed
  var chatAbortController = null;
  var sendInFlight = false;

  var pendingAttachments = [];
  var pendingAttachmentSeq = 0;

  var loadErrorEl = document.getElementById("load-error");

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function formatRelativeAge(ageMs) {
    if (ageMs === null || ageMs === undefined || !isFinite(ageMs)) return "never";
    if (ageMs < 0) ageMs = 0;
    var s = Math.floor(ageMs / 1000);
    if (s < 60) return s + "s ago";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    var d = Math.floor(h / 24);
    return d + "d ago";
  }

  function ageFromIso(iso) {
    if (!iso) return null;
    var t = new Date(iso).getTime();
    if (!isFinite(t)) return null;
    return Date.now() - t;
  }

  function formatBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }

  function mb(bytes) { return (bytes / (1024 * 1024)).toFixed(1); }

  function formatCurrency(value, currency) {
    return value.toFixed(2) + " " + currency;
  }

  function shortMediaType(mt) {
    var map = { "application/pdf": "PDF", "text/plain": "Text", "image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WebP", "image/gif": "GIF" };
    return map[mt] || mt;
  }

  function formatDateLabel(date) {
    try {
      return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    } catch (e) {
      return date.toDateString();
    }
  }

  function tileWrap(label, bodyHtml) {
    return '<div class="tile"><p class="tile-label">' + escapeHtml(label) + '</p>' + bodyHtml + '</div>';
  }

  function renderGhostBlock(reason, fix) {
    return '<div class="ghost-block"><p class="ghost-reason">' + escapeHtml(reason) + '</p><p class="ghost-fix">' + escapeHtml(fix) + '</p></div>';
  }

  function mailNotConfiguredFix() {
    return currentDomain === "work"
      ? "Set JARVIS_WORK_NZB_M365_OAUTH to see mail data"
      : "Set JARVIS_PERSONAL_HOTMAIL_OAUTH to see mail data";
  }

  function azureNotConfiguredFix() {
    return "Set JARVIS_WORK_AZURE_TENANT_ID, JARVIS_WORK_AZURE_CLIENT_ID, JARVIS_WORK_AZURE_CLIENT_SECRET, and JARVIS_WORK_AZURE_SUBSCRIPTION_ID to see Azure cost data";
  }

  function freshnessLine(summary) {
    if (summary.status === "stale") {
      return '<p class="freshness freshness-stale">synced ' + escapeHtml(formatRelativeAge(ageFromIso(summary.lastSyncedAt))) + ' — may be out of date</p>';
    }
    if (summary.lastSyncedAt) {
      return '<p class="freshness">synced ' + escapeHtml(formatRelativeAge(ageFromIso(summary.lastSyncedAt))) + '</p>';
    }
    return "";
  }

  function renderTopBars(items, labelKey, valueKey) {
    if (!items.length) return '<p class="empty-state">No data yet.</p>';
    var max = 0;
    for (var i = 0; i < items.length; i++) if (items[i][valueKey] > max) max = items[i][valueKey];
    var rows = items.map(function (item) {
      var pct = max > 0 ? Math.round((item[valueKey] / max) * 100) : 0;
      var label = escapeHtml(item[labelKey]);
      var value = valueKey === "cost" ? item[valueKey].toFixed(2) : item[valueKey];
      return '<div class="bar-row">' +
        '<span class="bar-label" title="' + label + '">' + label + '</span>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
        '<span class="bar-value">' + escapeHtml(value) + '</span>' +
        '</div>';
    }).join("");
    return '<div class="bar-list">' + rows + '</div>';
  }

  // ---------------- KPI content (mail/cost) ----------------

  function renderMailHeroTile(mail) {
    if (!mail || mail.status === "not_configured") {
      return tileWrap("Unread mail", renderGhostBlock("Not configured", mailNotConfiguredFix()));
    }
    var errorBanner = mail.status === "error" ? '<div class="content-error-banner">Sync failed</div>' : "";
    var dim = mail.status === "error" ? " metric-dim" : "";
    return '<div class="tile">' + errorBanner +
      '<div class="' + dim.trim() + '">' +
      '<p class="tile-label">Unread mail</p>' +
      '<p class="tile-value">' + escapeHtml(mail.unreadCount) + '</p>' +
      freshnessLine(mail) +
      '</div></div>';
  }

  function renderMailTotalTile(mail) {
    if (!mail || mail.status === "not_configured") {
      return tileWrap("Total messages", renderGhostBlock("Not configured", mailNotConfiguredFix()));
    }
    var dim = mail.status === "error" ? " metric-dim" : "";
    return '<div class="' + dim.trim() + '">' + tileWrap("Total messages", '<p class="tile-value">' + escapeHtml(mail.totalCount) + '</p>') + '</div>';
  }

  function renderAzureTile(azureCost) {
    if (!azureCost || azureCost.status === "not_configured") {
      return tileWrap("Azure cost (MTD)", renderGhostBlock("Not configured", azureNotConfiguredFix()));
    }
    var errorBanner = azureCost.status === "error" ? '<div class="content-error-banner">Sync failed</div>' : "";
    var dim = azureCost.status === "error" ? " metric-dim" : "";
    var value = azureCost.monthToDateCost === null ? "—" : formatCurrency(azureCost.monthToDateCost, azureCost.currency);
    return '<div class="tile">' + errorBanner +
      '<div class="' + dim.trim() + '">' +
      '<p class="tile-label">Azure cost (MTD)</p>' +
      '<p class="tile-value">' + escapeHtml(value) + '</p>' +
      freshnessLine(azureCost) +
      '</div></div>';
  }

  function renderKpiContent(d) {
    var el = document.getElementById("kpi-content");
    var content = d.content;
    var mail = content ? content.mail : null;
    var azureCost = content ? content.azureCost : null;
    var html = renderMailHeroTile(mail) + renderMailTotalTile(mail);
    if (currentDomain === "work") html += renderAzureTile(azureCost);
    el.innerHTML = html;
  }

  // ---------------- KPI health (modules/credentials rollup) ----------------

  function worstCredentialStatus(list) {
    // readModel.ts already sorts worst-first: expired > invalid > expiring_soon > valid.
    return list.length ? list[0].status : null;
  }

  function renderKpiHealth(d) {
    var el = document.getElementById("kpi-health");
    if (d.awaitingFirstReport) {
      el.innerHTML =
        tileWrap("Modules", renderGhostBlock("Awaiting first report", "This domain has not reported health yet.")) +
        tileWrap("Credentials", renderGhostBlock("Awaiting first report", "This domain has not reported health yet."));
      return;
    }
    var badModules = d.moduleHealth.filter(function (m) { return m.status === "crashed" || m.status === "degraded"; }).length;
    var moduleValueClass = badModules > 0 ? " tile-value-warn" : "";
    var modulesHtml =
      '<p class="tile-value' + moduleValueClass + '">' + escapeHtml(d.moduleHealth.length) + '</p>' +
      '<p class="tile-sub">' + badModules + ' crashed/degraded</p>';

    var worst = worstCredentialStatus(d.credentialStatus);
    var credValueClass = worst && worst !== "valid" ? " tile-value-warn" : "";
    var credSub = worst ? escapeHtml(worst.replace(/_/g, " ")) : "no credentials tracked";
    var credsHtml =
      '<p class="tile-value' + credValueClass + '">' + escapeHtml(d.credentialStatus.length) + '</p>' +
      '<p class="tile-sub">' + credSub + '</p>';

    el.innerHTML = tileWrap("Modules", modulesHtml) + tileWrap("Credentials", credsHtml);
  }

  // ---------------- panel grid (mail / azure cost) ----------------

  function renderMailPanelInner(d) {
    var mail = d.content ? d.content.mail : null;
    var html = '<h3 class="panel-title">Mail</h3>';
    if (!mail || mail.status === "not_configured") {
      return html + renderGhostBlock("Not configured", mailNotConfiguredFix());
    }
    var errorBanner = mail.status === "error" ? '<div class="content-error-banner">Sync failed</div>' : "";
    var dim = mail.status === "error" ? " metric-dim" : "";
    html += errorBanner + '<div class="' + dim.trim() + '">';
    html += freshnessLine(mail);
    if (mail.totalCount === 0) {
      html += '<p class="empty-state">No messages.</p>';
    } else {
      var pct = Math.round((mail.unreadCount / mail.totalCount) * 100);
      html += '<div class="meter"><div class="meter-fill" style="width:' + pct + '%"></div></div>';
      html += '<p class="meter-caption">' + escapeHtml(mail.unreadCount) + ' unread of ' + escapeHtml(mail.totalCount) + '</p>';
    }
    html += renderTopBars(mail.topSenders, "displayName", "messageCount");
    html += '</div>';
    return html;
  }

  function renderCostPanelInner(d) {
    var azureCost = d.content ? d.content.azureCost : null;
    var html = '<h3 class="panel-title">Azure cost</h3>';
    if (!azureCost || azureCost.status === "not_configured") {
      return html + renderGhostBlock("Not configured", azureNotConfiguredFix());
    }
    var errorBanner = azureCost.status === "error" ? '<div class="content-error-banner">Sync failed</div>' : "";
    var dim = azureCost.status === "error" ? " metric-dim" : "";
    html += errorBanner + '<div class="' + dim.trim() + '">';
    html += freshnessLine(azureCost);
    var value = azureCost.monthToDateCost === null ? "—" : formatCurrency(azureCost.monthToDateCost, azureCost.currency);
    html += '<p class="meter-caption">Month to date: <strong>' + escapeHtml(value) + '</strong></p>';
    html += renderTopBars(azureCost.topServices, "serviceName", "cost");
    html += '</div>';
    return html;
  }

  function renderPanelGrid(d) {
    var grid = document.getElementById("panel-grid");
    var isPersonalLike = currentDomain !== "work";
    var mailHtml = '<div id="panel-mail" class="panel' + (isPersonalLike ? " panel-full" : "") + '">' + renderMailPanelInner(d) + '</div>';
    // Azure cost panel is NOT-APPLICABLE (not not_configured) outside the
    // work domain: it does not exist in the DOM at all — no ghost, no header.
    var costHtml = currentDomain === "work" ? '<div id="panel-cost" class="panel">' + renderCostPanelInner(d) + '</div>' : "";
    grid.innerHTML = mailHtml + costHtml;
  }

  // ---------------- health band ----------------

  function chip(kind, text) {
    return '<span class="chip chip-' + kind + '">' + escapeHtml(text) + '</span>';
  }

  function shouldAutoExpand(d) {
    if (d.awaitingFirstReport) return true;
    if (d.credentialStatus.some(function (c) { return c.status !== "valid"; })) return true;
    if (d.moduleHealth.some(function (m) { return m.status === "crashed" || m.status === "degraded"; })) return true;
    if (d.errorCounts.fatal24h > 0) return true;
    return false;
  }

  function renderHealthBandChips(d) {
    // Bug fix from Phase 1: a domain that has never reported health
    // (awaitingFirstReport) gets the neutral ghost chip, NOT the same
    // "stale" warning treatment as a domain whose report went stale after
    // previously working.
    if (d.awaitingFirstReport) {
      return chip("ghost", "awaiting first report") + chip(d.totalPending > 0 ? "warn" : "valid", d.totalPending + " pending approval" + (d.totalPending === 1 ? "" : "s"));
    }
    var html = "";
    if (d.stale) html += chip("warn", "stale — " + formatRelativeAge(d.ageMs));
    var badModules = d.moduleHealth.filter(function (m) { return m.status === "crashed" || m.status === "degraded"; }).length;
    html += chip(badModules > 0 ? "warn" : "valid", d.moduleHealth.length + " module" + (d.moduleHealth.length === 1 ? "" : "s"));
    var worst = worstCredentialStatus(d.credentialStatus);
    if (worst && worst !== "valid") {
      html += chip(worst === "expired" || worst === "invalid" ? "expired" : "warn", worst.replace(/_/g, " "));
    } else {
      html += chip("valid", "credentials valid");
    }
    html += chip(d.errorCounts.fatal24h > 0 ? "expired" : "valid", d.errorCounts.fatal24h + " fatal (24h)");
    html += chip(d.totalPending > 0 ? "warn" : "valid", d.totalPending + " pending approval" + (d.totalPending === 1 ? "" : "s"));
    return html;
  }

  function renderModuleHealth(rows) {
    if (!rows.length) return '<p class="empty-state">No module restarts recorded.</p>';
    var body = rows.map(function (r) {
      return "<tr>" +
        "<td>" + escapeHtml(r.moduleId) + "</td>" +
        "<td>" + escapeHtml(r.status) + "</td>" +
        "<td>" + escapeHtml(r.restartCount24h) + "</td>" +
        "<td>" + (r.lastRestartAt ? escapeHtml(r.lastRestartAt) : "—") + "</td>" +
        "</tr>";
    }).join("");
    return '<table><thead><tr><th>Module</th><th>Status</th><th>Restarts (24h)</th><th>Last restart</th></tr></thead>' +
      "<tbody>" + body + "</tbody></table>";
  }

  function renderCredentialStatus(rows) {
    if (!rows.length) return '<p class="empty-state">No credentials tracked.</p>';
    var body = rows.map(function (r) {
      return "<tr>" +
        "<td>" + escapeHtml(r.credentialRef) + "</td>" +
        '<td><span class="pill pill-' + escapeHtml(r.status) + '">' + escapeHtml(r.status) + "</span></td>" +
        "<td>" + (r.expiresAt ? escapeHtml(r.expiresAt) : "—") + "</td>" +
        "</tr>";
    }).join("");
    return '<table><thead><tr><th>Credential</th><th>Status</th><th>Expires</th></tr></thead>' +
      "<tbody>" + body + "</tbody></table>";
  }

  function renderErrorCounts(counts) {
    var fatalClass = counts.fatal24h > 0 ? "fatal-nonzero" : "";
    return '<div class="error-counts">' +
      "<span>Transient (24h): " + escapeHtml(counts.transient24h) + "</span>" +
      '<span class="' + fatalClass + '">Fatal (24h): ' + escapeHtml(counts.fatal24h) + "</span>" +
      "</div>";
  }

  function renderApprovals(approvals, totalPending) {
    if (!totalPending) return '<p class="empty-state">None pending.</p>';
    var body = approvals.map(function (a) {
      return "<tr>" +
        "<td>" + escapeHtml(a.kind) + "</td>" +
        "<td>" + escapeHtml(a.summary) + "</td>" +
        "<td>" + escapeHtml(a.proposedAt) + "</td>" +
        "</tr>";
    }).join("");
    var table = '<table><thead><tr><th>Kind</th><th>Summary</th><th>Proposed at</th></tr></thead>' +
      "<tbody>" + body + "</tbody></table>";
    if (totalPending > approvals.length) {
      table += '<p class="empty-state">Showing ' + approvals.length + " of " + totalPending + " (oldest first).</p>";
    }
    return table;
  }

  function renderHealthBandBody(d) {
    var body;
    if (d.awaitingFirstReport) {
      body = renderGhostBlock("Awaiting first report", "This domain has not published a health report yet.");
    } else {
      body = "";
      if (d.stale) {
        body += '<p class="freshness freshness-stale">stale — last reported ' + escapeHtml(formatRelativeAge(d.ageMs)) + '</p>';
      }
      body +=
        '<section><p class="section-title">Module health</p>' + renderModuleHealth(d.moduleHealth) + "</section>" +
        '<section><p class="section-title">Credential status</p>' + renderCredentialStatus(d.credentialStatus) + "</section>" +
        '<section><p class="section-title">Error counts</p>' + renderErrorCounts(d.errorCounts) + "</section>";
    }
    body += '<section><p class="section-title">Pending approvals</p>' + renderApprovals(d.approvals, d.totalPending) + "</section>";
    return body;
  }

  function renderHealthBand(d) {
    document.getElementById("health-band-chips").innerHTML = renderHealthBandChips(d);
    document.getElementById("health-band-body").innerHTML = renderHealthBandBody(d);
    // Open/closed state is only ever set on the FIRST render after a domain
    // switch (or initial load) — every subsequent 5s poll re-render for the
    // SAME domain leaves .open untouched, so it never fights a user's
    // manual toggle and never wipes it mid-poll.
    if (healthBandRenderedGen !== domainGeneration) {
      document.getElementById("health-band").open = shouldAutoExpand(d);
      healthBandRenderedGen = domainGeneration;
    }
  }

  // ---------------- top-level render / poll ----------------

  function findDomainPayload(payload, domain) {
    for (var i = 0; i < payload.domains.length; i++) {
      if (payload.domains[i].domain === domain) return payload.domains[i];
    }
    return null;
  }

  function renderAll(payload) {
    var d = findDomainPayload(payload, currentDomain);
    if (!d) return;
    renderKpiContent(d);
    renderKpiHealth(d);
    renderPanelGrid(d);
    renderHealthBand(d);
  }

  function poll() {
    fetch("/api/state")
      .then(function (res) {
        if (!res.ok) throw new Error("request failed: " + res.status);
        return res.json();
      })
      .then(function (payload) {
        loadErrorEl.hidden = true;
        latestPayload = payload;
        renderAll(payload);
      })
      .catch(function (err) {
        loadErrorEl.hidden = false;
        loadErrorEl.textContent = "Failed to load dashboard state: " + err.message;
      });
  }

  // ---------------- mode bar / domain switch ----------------

  function updateModeBarSelection() {
    var segments = document.querySelectorAll(".segment");
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      var active = seg.getAttribute("data-domain") === currentDomain;
      seg.setAttribute("aria-checked", active ? "true" : "false");
      seg.className = "segment" + (active ? " segment-active" : "");
    }
    document.body.setAttribute("data-domain", currentDomain);
    var header = document.getElementById("chat-header");
    if (header) header.textContent = "Ask JARVIS about " + (DOMAIN_LABELS[currentDomain] || currentDomain);
  }

  function switchDomain(domain) {
    if (domain === currentDomain || !DOMAIN_LABELS.hasOwnProperty(domain)) return;
    currentDomain = domain;
    domainGeneration += 1;
    healthBandRenderedGen = -1;
    try { window.localStorage.setItem("jarvis-dashboard-domain", domain); } catch (e) {}

    updateModeBarSelection(); // instant swap, no transition animation

    // Blank the chat thread immediately — never hold the outgoing domain's
    // messages, even briefly, to avoid flashing private content across domains.
    chatMessages = [];
    chatThreadState = "loading";
    renderChatThread();

    // Drafts do NOT survive a domain switch — intentional.
    document.getElementById("chat-input").value = "";
    pendingAttachments = [];
    renderPendingAttachments();

    if (latestPayload) renderAll(latestPayload);

    var gen = domainGeneration;
    loadChatHistory(domain, gen);
  }

  function setupModeBar() {
    var segments = document.querySelectorAll(".segment");
    for (var i = 0; i < segments.length; i++) {
      (function (seg) {
        seg.addEventListener("click", function () { switchDomain(seg.getAttribute("data-domain")); });
        seg.addEventListener("keydown", function (ev) {
          if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
          ev.preventDefault();
          var domains = Object.keys(DOMAIN_LABELS);
          var idx = domains.indexOf(currentDomain);
          var next = domains[(idx + (ev.key === "ArrowRight" ? 1 : domains.length - 1)) % domains.length];
          switchDomain(next);
          var el = document.querySelector('.segment[data-domain="' + next + '"]');
          if (el) el.focus();
        });
      })(segments[i]);
    }
  }

  // ---------------- chat ----------------

  function isImageType(a) { return IMAGE_TYPES.indexOf(a.mediaType) !== -1; }
  function isDocType(a) { return DOC_TYPES.indexOf(a.mediaType) !== -1; }

  function recomputeAttachmentErrors() {
    var images = pendingAttachments.filter(isImageType);
    var docs = pendingAttachments.filter(isDocType);
    pendingAttachments.forEach(function (a) { a.error = null; });
    pendingAttachments.forEach(function (a) {
      if (!isImageType(a) && !isDocType(a)) a.error = "unsupported file type — " + a.mediaType;
    });
    if (images.length > 0 && docs.length > 0) {
      images.concat(docs).forEach(function (a) { if (!a.error) a.error = "attach images OR a single document, not both"; });
    } else if (docs.length > 1) {
      docs.forEach(function (a) { if (!a.error) a.error = "only one document is allowed per message"; });
    } else {
      docs.forEach(function (a) { if (!a.error && a.sizeBytes > MAX_DOC_BYTES) a.error = "too large — " + mb(a.sizeBytes) + " MB, limit 10 MB"; });
      if (images.length > MAX_IMAGES) {
        images.forEach(function (a) { if (!a.error) a.error = "too many images — " + images.length + ", limit " + MAX_IMAGES; });
      } else {
        images.forEach(function (a) { if (!a.error && a.sizeBytes > MAX_IMAGE_BYTES) a.error = "too large — " + mb(a.sizeBytes) + " MB, limit 5 MB"; });
      }
    }
  }

  function renderPendingAttachments() {
    var el = document.getElementById("pending-attachments");
    el.innerHTML = pendingAttachments.map(function (a) {
      var cls = "pending-attachment-chip" + (a.error ? " pending-attachment-error" : "");
      var text = a.error
        ? escapeHtml(a.filename) + " — " + escapeHtml(a.error)
        : escapeHtml(a.filename) + " · " + escapeHtml(formatBytes(a.sizeBytes));
      return '<span class="' + cls + '">' + text +
        '<button type="button" data-remove="' + a._id + '" aria-label="Remove ' + escapeHtml(a.filename) + '">×</button></span>';
    }).join("");
    var buttons = el.querySelectorAll("button[data-remove]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener("click", function (ev) {
        var id = Number(ev.currentTarget.getAttribute("data-remove"));
        pendingAttachments = pendingAttachments.filter(function (a) { return a._id !== id; });
        recomputeAttachmentErrors();
        renderPendingAttachments();
      });
    }
    updateSendAvailability();
  }

  function handleFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    files.forEach(function (file) {
      var reader = new FileReader();
      reader.onload = function () {
        var result = String(reader.result || "");
        var base64 = result.indexOf(",") !== -1 ? result.slice(result.indexOf(",") + 1) : "";
        pendingAttachments.push({
          _id: ++pendingAttachmentSeq,
          filename: file.name,
          mediaType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          dataBase64: base64,
          error: null,
        });
        recomputeAttachmentErrors();
        renderPendingAttachments();
      };
      reader.readAsDataURL(file);
    });
  }

  function setComposerDisabled(disabled) {
    var input = document.getElementById("chat-input");
    var attach = document.getElementById("attach-btn");
    if (input) input.disabled = disabled;
    if (attach) attach.disabled = disabled;
    updateSendAvailability();
  }

  function updateSendAvailability() {
    var btn = document.getElementById("send-btn");
    if (!btn) return;
    var hasErrors = pendingAttachments.some(function (a) { return a.error; });
    btn.disabled = hasErrors || sendInFlight || chatThreadState === "loading";
  }

  function renderBubble(m, showLabel) {
    var cls = "bubble " + (m.role === "user" ? "bubble-user" : "bubble-assistant");
    if (m.pending) cls += " bubble-thinking";
    var label = showLabel ? '<div class="bubble-role-label">' + (m.role === "user" ? "You" : "JARVIS") + '</div>' : "";
    var text = m.pending ? "Thinking…" : escapeHtml(m.content);
    var attachmentsHtml = "";
    if (m.attachments && m.attachments.length) {
      attachmentsHtml = m.attachments.map(function (a) {
        return '<span class="historical-attachment-note">📎 ' + escapeHtml(a.filename) + ' · ' + escapeHtml(shortMediaType(a.mediaType)) + ' · ' + escapeHtml(formatBytes(a.sizeBytes)) + '</span>';
      }).join("");
    }
    return '<div class="' + cls + '">' + label + '<div class="bubble-text">' + text + '</div>' + attachmentsHtml + '</div>';
  }

  function renderMessages(messages) {
    var html = "";
    var lastRole = null;
    var lastTime = null;
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      var t = m.createdAt ? new Date(m.createdAt).getTime() : Date.now();
      if (lastTime !== null && isFinite(t) && (t - lastTime) > 24 * 60 * 60 * 1000) {
        html += '<div class="session-divider">' + escapeHtml(formatDateLabel(new Date(t))) + '</div>';
        lastRole = null;
      }
      html += renderBubble(m, m.role !== lastRole);
      lastRole = m.role;
      lastTime = t;
    }
    return html;
  }

  function renderChatThread() {
    var el = document.getElementById("chat-thread");
    setComposerDisabled(chatThreadState === "loading");

    if (chatThreadState === "loading") {
      el.innerHTML = '<p class="chat-loading">Loading conversation…</p>';
      return;
    }
    if (chatThreadState === "load-failed") {
      el.innerHTML = '<div class="chat-load-failed">Failed to load conversation history.' +
        '<button type="button" class="chat-retry-btn" id="chat-retry">Retry</button></div>';
      var retry = document.getElementById("chat-retry");
      if (retry) retry.addEventListener("click", function () { loadChatHistory(currentDomain, domainGeneration); });
      return;
    }
    if (chatThreadState === "empty") {
      el.innerHTML = '<p class="chat-empty">No messages yet.</p>';
      return;
    }
    el.innerHTML = renderMessages(chatMessages);
    el.scrollTop = el.scrollHeight;
  }

  function loadChatHistory(domain, gen) {
    chatThreadState = "loading";
    renderChatThread();
    if (chatAbortController) chatAbortController.abort();
    var controller = new AbortController();
    chatAbortController = controller;
    fetch("/api/chat/" + encodeURIComponent(domain) + "/history", { signal: controller.signal })
      .then(function (res) {
        if (!res.ok) throw new Error("history request failed: " + res.status);
        return res.json();
      })
      .then(function (body) {
        if (gen !== domainGeneration) return; // switched away — discard
        chatMessages = (body && body.messages) || [];
        chatThreadState = chatMessages.length ? "loaded" : "empty";
        renderChatThread();
      })
      .catch(function (err) {
        if (err && err.name === "AbortError") return;
        if (gen !== domainGeneration) return;
        chatThreadState = "load-failed";
        renderChatThread();
      });
  }

  function sendMessage(ev) {
    ev.preventDefault();
    var input = document.getElementById("chat-input");
    var text = input.value.trim();
    var hasErrors = pendingAttachments.some(function (a) { return a.error; });
    if (!text || hasErrors || sendInFlight) return;
    // "load-failed" deliberately stays sendable — the server-side model
    // context (recentChatContext) is intact and independent of whether this
    // client's rendering of the OLD transcript succeeded; only "loading" is
    // blocked, since there's nothing yet to append the optimistic bubbles
    // onto. See Designer's state matrix section 7 (user-reviewer HIGH repro:
    // the button looked active but silently no-op'd in load-failed before
    // this fix).
    if (chatThreadState === "loading") return;

    var sentDomain = currentDomain;
    var sentGen = domainGeneration;
    var attachmentMeta = pendingAttachments.map(function (a) {
      return { filename: a.filename, mediaType: a.mediaType, sizeBytes: a.sizeBytes };
    });
    var attachmentPayload = pendingAttachments.map(function (a) {
      return { filename: a.filename, mediaType: a.mediaType, dataBase64: a.dataBase64 };
    });

    chatMessages = chatMessages.concat([
      { role: "user", content: text, attachments: attachmentMeta, createdAt: new Date().toISOString() },
      { role: "assistant", content: "", attachments: [], createdAt: new Date().toISOString(), pending: true },
    ]);
    chatThreadState = "loaded";
    renderChatThread();

    input.value = "";
    pendingAttachments = [];
    renderPendingAttachments();
    sendInFlight = true;
    updateSendAvailability();

    fetch("/api/chat/" + encodeURIComponent(sentDomain), {
      method: "POST",
      headers: { "content-type": "application/json", "X-Jarvis-Dashboard": "1" },
      body: JSON.stringify({ message: text, attachments: attachmentPayload }),
    })
      .then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return {}; }).then(function (b) {
            throw new Error((b && b.error) || ("request failed: " + res.status));
          });
        }
        return res.json();
      })
      .then(function (body) {
        sendInFlight = false;
        updateSendAvailability();
        // A reply that arrives after the user switched domains is discarded
        // client-side — it's still persisted server-side and will show next
        // time that domain loads.
        if (sentGen !== domainGeneration) return;
        chatMessages = chatMessages.filter(function (m) { return !m.pending; });
        chatMessages.push({ role: "assistant", content: body.reply.text, attachments: [], createdAt: body.reply.createdAt });
        chatThreadState = "loaded";
        renderChatThread();
      })
      .catch(function (err) {
        sendInFlight = false;
        updateSendAvailability();
        if (sentGen !== domainGeneration) return;
        chatMessages = chatMessages.filter(function (m) { return !m.pending; });
        chatMessages.push({ role: "assistant", content: "Error: " + err.message, attachments: [], createdAt: new Date().toISOString() });
        chatThreadState = "loaded";
        renderChatThread();
      });
  }

  function setupChat() {
    document.getElementById("chat-composer").addEventListener("submit", sendMessage);
    document.getElementById("chat-input").addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && !ev.shiftKey) sendMessage(ev);
    });
    document.getElementById("attach-btn").addEventListener("click", function () {
      document.getElementById("file-input").click();
    });
    document.getElementById("file-input").addEventListener("change", function (ev) {
      handleFiles(ev.target.files);
      ev.target.value = "";
    });
    var composer = document.getElementById("chat-composer");
    composer.addEventListener("paste", function (ev) {
      if (ev.clipboardData && ev.clipboardData.files && ev.clipboardData.files.length) {
        handleFiles(ev.clipboardData.files);
      }
    });
    composer.addEventListener("dragover", function (ev) { ev.preventDefault(); });
    composer.addEventListener("drop", function (ev) {
      ev.preventDefault();
      if (ev.dataTransfer && ev.dataTransfer.files) handleFiles(ev.dataTransfer.files);
    });
  }

  // ---------------- init ----------------

  function init() {
    try {
      var saved = window.localStorage.getItem("jarvis-dashboard-domain");
      if (saved && DOMAIN_LABELS.hasOwnProperty(saved)) currentDomain = saved;
    } catch (e) {}

    setupModeBar();
    updateModeBarSelection();
    setupChat();

    poll();
    setInterval(poll, POLL_MS);
    loadChatHistory(currentDomain, domainGeneration);
  }

  init();
})();
</script>
</body>
</html>
`;
