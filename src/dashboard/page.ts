import { DOMAIN_IDS } from "../config/domains.js";

/**
 * Static skeleton cards, one per configured domain, so a plain GET / (or
 * curl) shows both domain labels immediately — before any JS has run and
 * before the first /api/state fetch resolves. The poll script below
 * replaces #domains' contents wholesale once real data arrives.
 */
const DOMAIN_SKELETONS = DOMAIN_IDS.map(
  (id) =>
    `<div class="card" data-domain="${id}"><div class="card-header"><h2>${id}</h2></div><p class="age">loading…</p></div>`,
).join("");

/**
 * The dashboard page as an exported template literal, not a file on disk —
 * tsc/Docker copy semantics differ between src/ and dist/, so this avoids
 * needing to ship a static asset alongside the compiled JS. Inline CSS +
 * inline vanilla JS only: no framework, no build step, no CDN.
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
    --pill-valid: #1e7d34;
    --pill-valid-bg: #e4f6e9;
    --pill-warn: #8a5a00;
    --pill-warn-bg: #fff2d9;
    --pill-bad: #a3231f;
    --pill-bad-bg: #fbe6e5;
    --stale: #a3231f;
    --stale-bg: #fbe6e5;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14161a;
      --card-bg: #1e2126;
      --text: #e7e9ec;
      --muted: #9aa1ac;
      --border: #2c3038;
      --pill-valid: #7fe0a0;
      --pill-valid-bg: #163821;
      --pill-warn: #f0c674;
      --pill-warn-bg: #3a2d0e;
      --pill-bad: #f5918e;
      --pill-bad-bg: #3a1716;
      --stale: #f5918e;
      --stale-bg: #3a1716;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  h1 {
    font-size: 20px;
    margin: 0 0 4px;
  }
  .subtitle {
    color: var(--muted);
    font-size: 13px;
    margin: 0 0 20px;
  }
  .domains {
    display: flex;
    flex-wrap: wrap;
    gap: 20px;
    align-items: flex-start;
  }
  .card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 18px;
    min-width: 320px;
    flex: 1 1 380px;
    max-width: 560px;
  }
  .card-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 4px;
  }
  .card-header h2 {
    font-size: 16px;
    margin: 0;
    text-transform: capitalize;
  }
  .age {
    color: var(--muted);
    font-size: 12px;
    margin-bottom: 14px;
  }
  .badge {
    display: inline-block;
    font-size: 11px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--stale-bg);
    color: var(--stale);
  }
  section { margin-bottom: 16px; }
  section:last-child { margin-bottom: 0; }
  .section-title {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
    margin: 0 0 6px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  th, td {
    text-align: left;
    padding: 5px 6px;
    border-bottom: 1px solid var(--border);
  }
  th { color: var(--muted); font-weight: 600; }
  .empty-state {
    color: var(--muted);
    font-size: 13px;
    font-style: italic;
  }
  .pill {
    display: inline-block;
    font-size: 11px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 999px;
  }
  .pill-valid { background: var(--pill-valid-bg); color: var(--pill-valid); }
  .pill-expiring_soon { background: var(--pill-warn-bg); color: var(--pill-warn); }
  .pill-expired, .pill-invalid { background: var(--pill-bad-bg); color: var(--pill-bad); }
  .error-counts { font-size: 13px; display: flex; gap: 18px; }
  .error-counts .fatal-nonzero { color: var(--pill-bad); font-weight: 700; }
  .load-error {
    color: var(--pill-bad);
    font-size: 13px;
    margin-top: 12px;
  }
</style>
</head>
<body>
  <h1>JARVIS v2 Dashboard</h1>
  <p class="subtitle">Operational health &amp; pending approvals — polling every 5s</p>
  <div id="domains" class="domains">${DOMAIN_SKELETONS}</div>
  <div id="load-error" class="load-error" hidden></div>

<script>
(function () {
  var POLL_MS = 5000;
  var domainsEl = document.getElementById("domains");
  var loadErrorEl = document.getElementById("load-error");

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function formatRelativeAge(ageMs) {
    if (ageMs === null || ageMs === undefined) return "never reported";
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

  function renderModuleHealth(rows) {
    if (!rows.length) {
      return '<p class="empty-state">No module restarts recorded.</p>';
    }
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
    if (!rows.length) {
      return '<p class="empty-state">No credentials tracked.</p>';
    }
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

  function renderApprovals(approvals) {
    if (!approvals.length) {
      return '<p class="empty-state">None pending.</p>';
    }
    var body = approvals.map(function (a) {
      return "<tr>" +
        "<td>" + escapeHtml(a.kind) + "</td>" +
        "<td>" + escapeHtml(a.summary) + "</td>" +
        "<td>" + escapeHtml(a.proposedAt) + "</td>" +
        "</tr>";
    }).join("");
    return '<table><thead><tr><th>Kind</th><th>Summary</th><th>Proposed at</th></tr></thead>' +
      "<tbody>" + body + "</tbody></table>";
  }

  function renderDomainCard(d) {
    var badge = (d.stale || d.awaitingFirstReport) ? '<span class="badge">stale</span>' : "";
    var body;
    if (d.awaitingFirstReport) {
      body = '<p class="empty-state">Awaiting first health report…</p>';
    } else {
      body =
        '<section><p class="section-title">Module health</p>' + renderModuleHealth(d.moduleHealth) + "</section>" +
        '<section><p class="section-title">Credential status</p>' + renderCredentialStatus(d.credentialStatus) + "</section>" +
        '<section><p class="section-title">Error counts</p>' + renderErrorCounts(d.errorCounts) + "</section>";
    }
    body += '<section><p class="section-title">Pending approvals</p>' + renderApprovals(d.approvals) + "</section>";

    return '<div class="card" data-domain="' + escapeHtml(d.domain) + '">' +
      '<div class="card-header"><h2>' + escapeHtml(d.domain) + "</h2>" + badge + "</div>" +
      '<p class="age">' + formatRelativeAge(d.ageMs) + "</p>" +
      body +
      "</div>";
  }

  function render(payload) {
    domainsEl.innerHTML = payload.domains.map(renderDomainCard).join("");
  }

  function poll() {
    fetch("/api/state")
      .then(function (res) {
        if (!res.ok) throw new Error("request failed: " + res.status);
        return res.json();
      })
      .then(function (payload) {
        loadErrorEl.hidden = true;
        render(payload);
      })
      .catch(function (err) {
        loadErrorEl.hidden = false;
        loadErrorEl.textContent = "Failed to load dashboard state: " + err.message;
      });
  }

  poll();
  setInterval(poll, POLL_MS);
})();
</script>
</body>
</html>
`;
