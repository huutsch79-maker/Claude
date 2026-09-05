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
 * inline vanilla JS only: no framework, no build step, no CDN, and
 * deliberately no webfont — this console has to render correctly when the
 * things it monitors are broken, and a remote font is one more dependency
 * that can be slow or blocked. The verdict line's serif comes from the
 * system stack instead.
 *
 * Reads verdict-first: one sentence about whether anything needs Alex,
 * then the findings behind it, then everything else behind a disclosure.
 * Drill-down is hash-routed two levels deep (#/work/mail/sender/2), so
 * every view is linkable and the browser back button works. Chat is the
 * floor of every drill-down — the one place that can go deeper than the
 * whitelisted summary.
 *
 * The five-state vocabulary is the core of it. Three of the states look
 * empty on screen and must never be confused with each other:
 *   dashed border  = not_configured — you can connect this
 *   solid + clock  = awaiting       — configured, first report not in yet
 *   solid + dash   = unmeasured     — nothing to wait for, nothing to do
 * See resolveContentState() and CHECK_REGISTRY below.
 */
export const DASHBOARD_HTML: string = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>JARVIS Domain Console</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #eef0f4;
    --bg-detail: #e6e9ee;
    --card-bg: #ffffff;
    --card-2: #f6f7f9;
    --sunk: #e7eaef;
    --text: #171a1f;
    --muted: #5b6270;
    --border: #dce0e7;
    --border-strong: #c3c9d3;
    --surface-hover: #f2f4f7;
    --surface-active: #e8ebef;

    /* Status tokens — one consistent system, reused everywhere a status
       color is needed. Never used for a data mark (chart hue is separate). */
    --pill-valid: #1e7d34;      --pill-valid-bg: #e4f6e9;
    --pill-warn: #8a5a00;       --pill-warn-bg: #fff2d9;
    --pill-expired: #a3231f;    --pill-expired-bg: #fbe6e5;
    --pill-invalid: #a3231f;    --pill-invalid-bg: #fbe6e5;

    /* Neutral ink for the three "empty" states. --ink-quiet is a darker
       step than --ghost-text because these now sit on --bg, where
       --ghost-text only reached 4.43:1. */
    --ghost-border: #c3c9d2;
    --ghost-text: #646b78;
    --ink-quiet: #646b78;

    /* One data accent hue for every chart mark on the page. Track is a
       lighter step of the SAME hue. */
    --data-fill: hsl(211 70% 45%);
    --data-track: hsl(211 55% 88%);
    --focus: hsl(211 70% 45%);

    /* Two low-chroma domain accent colors — chrome only, never a data
       mark or a status color. */
    --accent-work: #3d5a72;
    --accent-personal: #6d4f60;
    --accent: var(--accent-work);

    --bubble-user-bg: hsl(211 70% 45%);
    --bubble-user-text: #ffffff;

    --serif: Georgia, "Iowan Old Style", "Times New Roman", serif;
    --shadow: 0 1px 2px rgba(20,25,35,.05), 0 8px 24px rgba(20,25,35,.06);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #101317;
      --bg-detail: #0b0d10;
      --card-bg: #191d23;
      --card-2: #1f242b;
      --sunk: #14181d;
      --text: #e9ecf1;
      --muted: #9aa1ac;
      --border: #2a3038;
      --border-strong: #3d4650;
      --surface-hover: #22272e;
      --surface-active: #2a3038;

      --pill-valid: #7fe0a0;      --pill-valid-bg: #14301d;
      --pill-warn: #f0c674;       --pill-warn-bg: #33280d;
      --pill-expired: #f5918e;    --pill-expired-bg: #331413;
      --pill-invalid: #f5918e;    --pill-invalid-bg: #331413;

      --ghost-border: #3a4049;
      --ghost-text: #9aa1ac;
      --ink-quiet: #9aa1ac;

      --data-fill: hsl(211 80% 68%);
      --data-track: hsl(211 35% 24%);
      --focus: hsl(211 80% 68%);

      --accent-work: #7fa1bd;
      --accent-personal: #bf98ac;

      --bubble-user-bg: hsl(211 55% 38%);
      --bubble-user-text: #f2f5f8;

      --shadow: 0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.32);
    }
  }
  * { box-sizing: border-box; }
  html, body { background: var(--bg); }
  body {
    margin: 0;
    padding: 0 0 76px;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 15px;
    line-height: 1.5;
    border-left: 4px solid var(--accent);
    transition: background-color .12s ease-out;
  }
  body[data-domain="personal"] { --accent: var(--accent-personal); }
  body[data-depth="detail"] { background: var(--bg-detail); }
  :focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 3px; }
  :focus:not(:focus-visible) { outline: none; }
  @media (prefers-reduced-motion: no-preference) { .wrap { animation: fade .12s ease-out; } }
  @keyframes fade { from { opacity: 0 } to { opacity: 1 } }

  /* ---------- mode bar (sticky, instant swap, never a tab) ---------- */
  .mode-bar {
    position: sticky; top: 0; z-index: 10;
    display: flex; align-items: center; gap: 14px;
    padding: 10px 16px;
    background: var(--card-bg); border-bottom: 1px solid var(--border);
  }
  .wordmark { font-weight: 700; font-size: 14px; letter-spacing: .03em; }
  .segmented { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .segment {
    appearance: none; border: none; background: transparent; color: var(--text);
    font: inherit; font-size: 13px; padding: 8px 14px; cursor: pointer; min-height: 36px;
  }
  .segment + .segment { border-left: 1px solid var(--border); }
  .segment-active { background: var(--accent); color: #fff; font-weight: 600; }
  .fresh { margin-left: auto; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
  @media (max-width: 430px) { .mode-bar { gap: 10px; } }

  .wrap { max-width: 660px; margin: 0 auto; padding: 20px 16px 32px; }
  .wrap.wide { max-width: 960px; }
  @media (max-width: 430px) { .wrap { padding-left: 12px; padding-right: 12px; } }

  /* ---------- verdict ---------- */
  .verdict {
    display: block; width: 100%; text-align: left; cursor: pointer;
    background: none; border: 0; border-bottom: 1px solid var(--border);
    padding: 22px 0 20px; color: inherit; font: inherit;
  }
  .verdict-kicker {
    display: flex; align-items: center; gap: 7px; margin-bottom: 11px;
    font-size: 11px; letter-spacing: .09em; text-transform: uppercase; font-weight: 600; color: var(--muted);
  }
  .verdict h1 {
    font-family: var(--serif); font-weight: 400; margin: 0 0 9px;
    font-size: clamp(27px, 6vw, 37px); line-height: 1.15; letter-spacing: -.012em; text-wrap: balance;
  }
  .verdict h1 em { font-style: italic; color: var(--ink-quiet); font-size: .68em; }
  .verdict p { margin: 0; font-size: 15px; color: var(--muted); max-width: 54ch; }
  .cov { display: flex; align-items: center; gap: 8px; margin-top: 15px; font-size: 13px; color: var(--muted); }
  .cov b { font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; }
  .cov-bar { flex: 1; max-width: 130px; height: 5px; border-radius: 3px; background: var(--sunk); border: 1px solid var(--border); overflow: hidden; }
  .cov-bar i { display: block; height: 100%; background: var(--data-fill); }

  /* ---------- findings ---------- */
  .finding {
    display: flex; gap: 12px; align-items: flex-start; width: 100%; text-align: left;
    background: none; border: 0; border-bottom: 1px solid var(--border);
    padding: 15px 0; cursor: pointer; min-height: 44px; color: inherit; font: inherit;
  }
  .finding .txt { flex: 1; min-width: 0; }
  .finding .h { display: block; font-weight: 600; font-size: 14.5px; margin-bottom: 3px; }
  .finding .e { display: block; font-size: 13px; color: var(--muted); }
  .chev { color: var(--muted); flex: none; margin-top: 2px; }

  /* ---------- setup ---------- */
  .setup { margin-top: 22px; background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow); overflow: hidden; }
  .setup-h { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--border); }
  .setup-h b { font-size: 14px; flex: none; }
  .setup-h span { font-size: 12.5px; color: var(--muted); font-variant-numeric: tabular-nums; flex: none; }
  .setup-prog { flex: 1; display: flex; gap: 4px; }
  .setup-prog i { flex: 1; height: 6px; border-radius: 3px; background: var(--data-track); }
  .setup-prog i.on { background: var(--data-fill); }
  .setup-row {
    display: flex; align-items: center; gap: 11px; width: 100%; text-align: left;
    padding: 12px 16px; border: 0; border-top: 1px solid var(--border); background: none;
    cursor: pointer; min-height: 46px; color: inherit; font: inherit;
  }
  .setup-row:first-of-type { border-top: 0; }
  .setup-row .nm { flex: 1; font-size: 14px; }
  .setup-row .st { font-size: 12.5px; color: var(--ink-quiet); }
  .setup-row .act { font-size: 12.5px; font-weight: 600; display: flex; align-items: center; gap: 2px; }
  .setup-foot { padding: 11px 16px; border-top: 1px solid var(--border); font-size: 12px; color: var(--muted); }
  @media (hover: hover) { .setup-row:hover { background: var(--surface-hover); } }

  /* ---------- disclosure + grid ---------- */
  .disc { margin-top: 22px; border-top: 1px solid var(--border); padding-top: 4px; }
  .disc > summary {
    list-style: none; cursor: pointer; padding: 12px 2px; min-height: 44px;
    font-size: 13.5px; font-weight: 600; color: var(--muted); display: flex; align-items: center; gap: 9px;
  }
  .disc > summary::-webkit-details-marker { display: none; }
  .tri { color: var(--muted); transition: transform .14s ease; }
  .disc[open] > summary .tri { transform: rotate(90deg); }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; padding: 6px 0 4px; }
  @media (min-width: 600px) { .grid { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; } }
  @media (min-width: 900px) { .grid { grid-template-columns: repeat(5, minmax(0, 1fr)); } }
  .cell {
    display: flex; flex-direction: column; gap: 4px; width: 100%; text-align: left;
    background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px;
    padding: 12px 13px; min-height: 96px; cursor: pointer; color: inherit; font: inherit;
  }
  .cell[data-inert] { cursor: default; }
  .cell[data-ghost] { border-style: dashed; border-color: var(--ghost-border); background: none; }
  @media (hover: hover) { .cell:not([data-inert]):hover { background: var(--surface-hover); border-color: var(--border-strong); } }
  .cell:not([data-inert]):active { background: var(--surface-active); }
  .cell .lb { font-size: 10.5px; letter-spacing: .075em; text-transform: uppercase; font-weight: 600; color: var(--muted); }
  .cell .vl { font-size: 25px; font-weight: 600; letter-spacing: -.02em; font-variant-numeric: tabular-nums; line-height: 1.1; }
  .cell .vl.sm { font-size: 15px; font-weight: 500; letter-spacing: 0; }
  .cell .sub { font-size: 11.5px; color: var(--muted); margin-top: auto; font-variant-numeric: tabular-nums; }
  .cell .delta { font-size: 12px; color: var(--muted); font-weight: 500; }
  .dashglyph { display: block; width: 14px; height: 2.5px; border-radius: 2px; background: var(--ink-quiet); margin: 10px 0 4px; }
  .nosig { font-size: 12px; color: var(--ink-quiet); line-height: 1.35; }
  .awaitv { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; color: var(--ink-quiet); line-height: 1.3; margin: 3px 0 2px; }

  /* ---------- detail views ---------- */
  .back { display: inline-flex; align-items: center; gap: 6px; background: none; border: 0; cursor: pointer;
          font: inherit; font-size: 13.5px; color: var(--text); padding: 10px 2px; min-height: 44px; }
  @media (hover: hover) { .back:hover { text-decoration: underline; } }
  .dt-h { margin: 4px 0 18px; }
  .dt-h h2 { font-family: var(--serif); font-weight: 400; font-size: 26px; margin: 0 0 6px; letter-spacing: -.01em; }
  .dt-h .meta { font-size: 13px; color: var(--muted); }
  .panel { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 16px; box-shadow: var(--shadow); margin-bottom: 14px; }
  .panel h3 { font-size: 11px; letter-spacing: .085em; text-transform: uppercase; color: var(--muted); margin: 0 0 13px; font-weight: 600; }
  .big { font-size: 37px; font-weight: 600; letter-spacing: -.025em; font-variant-numeric: tabular-nums; line-height: 1; }
  .bigsub { font-size: 13px; color: var(--muted); margin-top: 5px; }
  .meter { height: 9px; border-radius: 5px; background: var(--data-track); overflow: hidden; margin: 14px 0 7px; }
  .meter i { display: block; height: 100%; background: var(--data-fill); border-radius: 0 5px 5px 0; }
  .mcap { font-size: 12.5px; color: var(--muted); font-variant-numeric: tabular-nums; }

  .rank { display: flex; flex-direction: column; gap: 2px; }
  .rank button {
    display: grid; grid-template-columns: minmax(0, 1fr) 124px auto; gap: 11px; align-items: center;
    background: none; border: 0; border-radius: 7px; padding: 11px 8px; margin: 0 -8px;
    cursor: pointer; text-align: left; min-height: 46px; width: calc(100% + 16px); color: inherit; font: inherit;
  }
  @media (hover: hover) { .rank button:hover { background: var(--surface-hover); } }
  .rank .nm { font-size: 13.5px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rank .tr { height: 9px; border-radius: 0 4px 4px 0; background: var(--data-fill); }
  .rank .vv { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; min-width: 66px; }

  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th { text-align: left; font-size: 10.5px; letter-spacing: .075em; text-transform: uppercase; color: var(--muted);
       font-weight: 600; padding: 0 0 9px; border-bottom: 1px solid var(--border); }
  td { padding: 12px 0; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr:last-child td { border-bottom: 0; }
  .rowbtn { background: none; border: 0; padding: 0; margin: 0; font: inherit; color: inherit; cursor: pointer; text-align: left; width: 100%; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
  .tdlabel { color: var(--muted); width: 40%; }

  .pill { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 9px; border-radius: 999px;
          font-size: 11.5px; font-weight: 600; white-space: nowrap; }
  .p-ok { background: var(--pill-valid-bg); color: var(--pill-valid); }
  .p-warn { background: var(--pill-warn-bg); color: var(--pill-warn); }
  .p-bad { background: var(--pill-expired-bg); color: var(--pill-expired); }
  .p-ghost { color: var(--ghost-text); border: 1px dashed var(--ghost-border); }
  .p-none { color: var(--ink-quiet); border: 1px solid var(--border); }

  .note { border-left: 3px solid var(--border-strong); padding: 11px 0 11px 13px; font-size: 13px; color: var(--muted); margin: 14px 0 0; }
  .note.warnish { border-left-color: var(--pill-warn); background: var(--pill-warn-bg); color: var(--text);
                  padding: 11px 13px; border-radius: 0 7px 7px 0; }
  .stateblock { border: 1px solid var(--border); border-radius: 9px; padding: 15px; color: var(--ink-quiet); background: var(--card-bg); }
  .stateblock.ghost { border-style: dashed; border-color: var(--ghost-border); background: none; }
  .stateblock b { display: flex; align-items: center; gap: 8px; color: var(--text); font-size: 14px; margin-bottom: 6px; }

  .coda { margin-top: 24px; padding-top: 20px; border-top: 1px solid var(--border); }
  .floor {
    display: flex; align-items: center; justify-content: center; gap: 9px; width: 100%;
    background: var(--accent); color: #fff; border: 0; border-radius: 8px; padding: 0 20px;
    min-height: 46px; font: inherit; font-size: 14.5px; font-weight: 600; cursor: pointer;
  }
  @media (hover: hover) { .floor:hover { filter: brightness(1.08); } }
  .seedprompt { margin: 10px 0 0; font-size: 12.5px; color: var(--ink-quiet); font-style: italic; line-height: 1.45; text-align: center; }

  /* ---------- bottom bar ---------- */
  .tabs { position: fixed; left: 0; right: 0; bottom: 0; z-index: 10; display: flex;
          background: var(--card-bg); border-top: 1px solid var(--border); padding-bottom: env(safe-area-inset-bottom); }
  .tabs button { flex: 1; border: 0; background: none; padding: 11px 0 13px; font: inherit; font-size: 11.5px;
                 font-weight: 600; color: var(--muted); cursor: pointer; display: flex; flex-direction: column;
                 align-items: center; gap: 3px; min-height: 56px; }
  .tabs button[aria-current="page"] { color: var(--accent); }

  /* ---------- chat (DOM contract unchanged from Dashboard v2) ---------- */
  .chat { max-width: 660px; margin: 0 auto; padding: 0 16px 32px; }
  .chat-header { font-family: var(--serif); font-weight: 400; font-size: 26px; margin: 4px 0 6px; letter-spacing: -.01em; }
  .chat-sub { font-size: 13px; color: var(--muted); margin: 0 0 16px; }
  .chat-thread { display: flex; flex-direction: column; gap: 13px; margin-bottom: 16px; }
  .bubble { max-width: 82%; padding: 11px 13px; border-radius: 14px; font-size: 14px; line-height: 1.5; }
  .bubble-user { margin-left: auto; background: var(--bubble-user-bg); color: var(--bubble-user-text); border-bottom-right-radius: 5px; }
  .bubble-assistant { background: var(--card-bg); border: 1px solid var(--border-strong); border-bottom-left-radius: 5px; }
  .bubble-thinking { opacity: .72; font-style: italic; }
  .bubble-role-label { font-size: 10.5px; letter-spacing: .075em; text-transform: uppercase; font-weight: 600; opacity: .72; margin-bottom: 5px; }
  .bubble-text { white-space: pre-wrap; overflow-wrap: anywhere; }
  .historical-attachment-note { display: block; margin-top: 7px; font-size: 11.5px; opacity: .8; }
  .session-divider { text-align: center; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin: 6px 0; }
  .chat-loading, .chat-empty, .chat-load-failed { font-size: 13px; color: var(--muted); padding: 8px 0; }
  .chat-load-failed { color: var(--pill-expired); }
  .chat-retry-btn { margin-left: 8px; font: inherit; font-size: 13px; background: none; border: 1px solid var(--border);
                    border-radius: 6px; padding: 5px 10px; cursor: pointer; color: var(--text); min-height: 32px; }

  .pending-attachments:empty { display: none; }
  .pending-attachments { margin-bottom: 8px; display: flex; flex-wrap: wrap; gap: 6px; }
  .pending-attachment-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 12px;
                             background: var(--card-2); border: 1px solid var(--border); border-radius: 999px; padding: 4px 6px 4px 11px; }
  .pending-attachment-error { border-color: var(--pill-expired); color: var(--pill-expired); }
  .pending-attachment-chip button { border: 0; background: none; cursor: pointer; font: inherit; font-size: 15px;
                                    line-height: 1; color: inherit; padding: 2px 6px; min-height: 24px; }

  #chat-composer { background: var(--card-bg); border: 1px solid var(--border-strong); border-radius: 12px; padding: 11px; box-shadow: var(--shadow); }
  .composer-row { display: flex; align-items: flex-end; gap: 8px; }
  #attach-btn { flex: 0 0 auto; border: 1px solid var(--border); background: var(--card-bg); color: var(--text);
                border-radius: 8px; width: 38px; height: 38px; cursor: pointer; font-size: 15px; }
  /* 16px is the iOS Safari no-zoom floor — below it, focusing the composer
     zooms the viewport and never zooms back. */
  #chat-input { flex: 1; resize: none; min-height: 38px; max-height: 150px; border: 0; background: none;
                font: inherit; font-size: 16px; color: var(--text); outline: none; padding: 8px 4px; }
  #send-btn { flex: 0 0 auto; border: 0; border-radius: 8px; padding: 0 16px; height: 38px;
              background: var(--accent); color: #fff; font: inherit; font-size: 13.5px; font-weight: 600; cursor: pointer; }
  #attach-btn:disabled, #chat-input:disabled, #send-btn:disabled { opacity: .5; cursor: not-allowed; }
  .composer-footnote { margin: 9px 0 0; font-size: 12px; color: var(--muted); line-height: 1.5; }

  .load-error { color: var(--pill-expired); font-size: 13px; margin: 0 16px 12px; max-width: 660px; }
  [hidden] { display: none !important; }
</style>
</head>
<body data-domain="${DOMAIN_IDS[0]}" data-depth="top">
  <header class="mode-bar">
    <span class="wordmark">JARVIS</span>
    <div class="segmented" role="radiogroup" aria-label="Domain">${MODE_BAR_SEGMENTS}</div>
    <span id="fresh" class="fresh"></span>
  </header>

  <div id="load-error" class="load-error" hidden></div>

  <!-- First paint, before any fetch resolves: never a green all-clear.
       renderView() replaces this as soon as /api/state lands. -->
  <main id="view" class="wrap">
    <div class="verdict">
      <span class="verdict-kicker">${escapeForTemplate(DOMAINS[DOMAIN_IDS[0]].label)}</span>
      <h1>Checking&hellip;</h1>
    </div>
  </main>

  <section id="chat" class="chat" hidden>
    <button type="button" class="back" data-nav="overview">Back to overview</button>
    <h2 id="chat-header" class="chat-header"></h2>
    <p class="chat-sub">This conversation stays with this domain and is saved.</p>
    <div id="chat-thread" class="chat-thread" aria-live="polite"></div>
    <form id="chat-composer">
      <div id="pending-attachments" class="pending-attachments"></div>
      <div class="composer-row">
        <button type="button" id="attach-btn" aria-label="Attach file" title="Attach file">&#128206;</button>
        <input type="file" id="file-input" multiple hidden>
        <textarea id="chat-input" rows="1" placeholder="Ask JARVIS&hellip;" aria-label="Message"></textarea>
        <button type="submit" id="send-btn">Send</button>
      </div>
      <p class="composer-footnote">
        Conversation is saved for this domain.<br>
        Attachments are only visible to JARVIS in the message you send them — they can't be reopened later.
      </p>
    </form>
  </section>

  <nav class="tabs">
    <button type="button" data-tab="dash" aria-current="page">Dashboard</button>
    <button type="button" data-tab="chat">Ask JARVIS</button>
  </nav>

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
  var latestPayload = null;
  var discOpen = false;
  var scrollMem = {};
  var seededPrompt = "";

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
    if (value === null || value === undefined || !isFinite(value)) return "—";
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: currency }).format(value);
    } catch (e) {
      // Unrecognised ISO code — still better than throwing on a cost panel.
      return value.toFixed(2) + " " + currency;
    }
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


  // ---------------- icons ----------------
  // Each state gets its own silhouette, not just its own color: red/amber/
  // green converge under deuteranopia, so shape + word carry the meaning
  // and color is only reinforcement.
  var ICON = {
    ok: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M5.4 8.2l1.9 1.9 3.4-3.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    warn: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M8 2.2l6 10.6H2z" stroke-linejoin="round"/><path d="M8 6.4v2.9M8 11.2v.1" stroke-linecap="round"/></svg>',
    crit: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M5.4 1.9h5.2l3.5 3.5v5.2l-3.5 3.5H5.4L1.9 10.6V5.4z" stroke-linejoin="round"/><path d="M8 4.9v3.6M8 11v.1" stroke-linecap="round"/></svg>',
    ghost: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="8" cy="8" r="6.2" stroke-dasharray="2.6 2.2"/></svg>',
    clock: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.6V8l2.3 1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    dash: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M3.4 8h9.2" stroke-linecap="round"/></svg>',
    chev: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    left: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M10 3.5L5.5 8 10 12.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    chat: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M14 9.2a2 2 0 01-2 2H5.4L2.6 13.4V4.8a2 2 0 012-2h7.4a2 2 0 012 2z" stroke-linejoin="round"/></svg>'
  };

  function iconFor(state) {
    if (state === "blocking") return ICON.crit;
    if (state === "attention") return ICON.warn;
    if (state === "ok") return ICON.ok;
    if (state === "notconf") return ICON.ghost;
    if (state === "awaiting") return ICON.clock;
    return ICON.dash;
  }
  function colorFor(state) {
    if (state === "blocking") return "var(--pill-expired)";
    if (state === "attention") return "var(--pill-warn)";
    if (state === "ok") return "var(--pill-valid)";
    return "var(--ink-quiet)";
  }

  // ---------------- state vocabulary ----------------

  /**
   * The five-state resolver. The distinction this exists to make:
   *   content === null           -> "awaiting"  (configured, nothing reported yet)
   *   sub.status "not_configured"-> "notconf"   (never configured)
   * Dashboard v2 collapsed both into "Not configured", which meant every
   * restart claimed the integration was missing until the first content
   * report landed. They are different facts and get different treatments.
   * The key argument is "mail" or "azureCost"; a null sub-summary means the domain
   * structurally has no such channel (personal never has Azure cost).
   */
  function resolveContentState(d, key) {
    if (!d) return "awaiting";
    if (d.content === null || d.content === undefined) return "awaiting";
    var sub = d.content[key];
    if (sub === null || sub === undefined) return "na";
    if (sub.status === "not_configured") return "notconf";
    if (sub.status === "error") return "error";
    if (sub.status === "stale") return "stale";
    return "connected";
  }

  /** A numeral is only ever rendered for these two — see designer's rule. */
  function hasNumeral(state) { return state === "connected" || state === "stale"; }

  function contentSub(d, key) {
    if (!d || !d.content) return null;
    return d.content[key] || null;
  }

  /**
   * Ranks credentials by URGENCY, for choosing what the verdict names.
   * This deliberately differs from readModel.ts's table sort, which ranks
   * by anomaly (expired > invalid > expiring_soon > valid). The two answer
   * different questions: the table asks "what looks most wrong", the
   * headline asks "what needs Alex soonest". A credential that has never
   * been configured has no deadline and has broken nothing, so it must not
   * outrank one that lapses in six days.
   */
  var CRED_RANK = { expired: 0, expiring_soon: 1, invalid: 2, valid: 3 };
  function worstCredentialStatus(list) {
    if (!list || !list.length) return null;
    var worst = null;
    for (var i = 0; i < list.length; i++) {
      if (worst === null || CRED_RANK[list[i].status] < CRED_RANK[worst]) worst = list[i].status;
    }
    return worst;
  }
  function worstCredentialEntry(list) {
    if (!list || !list.length) return null;
    var worst = list[0];
    for (var i = 1; i < list.length; i++) {
      if (CRED_RANK[list[i].status] < CRED_RANK[worst.status]) worst = list[i];
    }
    return worst;
  }
  function credentialPill(status) {
    if (status === "valid") return '<span class="pill p-ok">' + ICON.ok + 'Valid</span>';
    if (status === "expiring_soon") return '<span class="pill p-warn">' + ICON.warn + 'Expiring soon</span>';
    if (status === "expired") return '<span class="pill p-bad">' + ICON.crit + 'Expired</span>';
    return '<span class="pill p-none">' + ICON.dash + 'Never configured</span>';
  }

  /**
   * Checks the orchestrator does not currently instrument, with the reason
   * stated where a reader can check it. These are NOT derivable from the
   * payload — errorCounts and totalPending are legitimately-shaped zeros
   * whether or not anything is counting — so the honest reading has to be
   * declared here until the backend publishes it.
   *
   *   errors    : orchestrator/index.ts calls startScheduledCycles() with no
   *               argument, so domainManager.ts's zero-default getErrorLog is
   *               used for every cycle. The count is a constant, not a
   *               measurement.
   *   approvals : SelfHeal is constructed (domain/Domain.ts) but .handle() is
   *               never called anywhere, so reviewer proposals never reach the
   *               ApprovalGate and listPending() cannot become non-empty.
   *
   * Delete an entry here the moment its producer is wired up — a stale entry
   * would under-report real data, which is the opposite of the point.
   */
  var UNMEASURED = {
    errors: "no error source is connected, so this always reads zero",
    approvals: "proposals never reach the approval gate"
  };

  // ---------------- check registry ----------------

  /**
   * Single source of truth for the verdict, the findings, the Setup card and
   * the grid. Every check reports one of:
   *   ok | attention | blocking   -> measured, counts toward coverage
   *   notconf | awaiting | unmeasured -> not measured
   *   na                          -> structurally absent for this domain
   */
  function buildChecks(d) {
    var out = [];
    var dom = d ? d.domain : currentDomain;
    function push(id, label, state, head, ev, route) {
      out.push({ id: id, label: label, state: state, head: head, ev: ev, route: route });
    }
    var base = "#/" + dom;

    // 1. health reporting
    if (!d || d.awaitingFirstReport) {
      push("report", "Health reporting", "awaiting", "No health report yet",
        "The domain has not published its first report since starting", base + "/errors");
    } else if (d.stale) {
      push("report", "Health reporting", "attention", "Health report is stale",
        "Last report " + formatRelativeAge(d.ageMs), base + "/errors");
    } else {
      push("report", "Health reporting", "ok", "Reporting normally",
        "Last report " + formatRelativeAge(d.ageMs), base + "/errors");
    }

    // 2. credentials
    var creds = (d && d.credentialStatus) || [];
    var worstEntry = worstCredentialEntry(creds);
    if (!creds.length) {
      push("credentials", "Credentials", "unmeasured", "No credentials tracked",
        "the domain reported an empty credential list", base + "/credentials");
    } else if (worstEntry.status === "expired") {
      push("credentials", "Credentials", "blocking", worstEntry.credentialRef + " has expired",
        "Anything using it is failing now", base + "/credentials/" + encodeURIComponent(worstEntry.credentialRef));
    } else if (worstEntry.status === "expiring_soon") {
      push("credentials", "Credentials", "attention", worstEntry.credentialRef + " expires soon",
        "Rotate it before it lapses", base + "/credentials/" + encodeURIComponent(worstEntry.credentialRef));
    } else if (worstEntry.status === "invalid") {
      push("credentials", "Credentials", "attention", worstEntry.credentialRef + " is not configured",
        "It has no stored value to check", base + "/credentials/" + encodeURIComponent(worstEntry.credentialRef));
    } else {
      push("credentials", "Credentials", "ok", creds.length + " tracked, all valid", null, base + "/credentials");
    }

    // 3. mail
    var mailState = resolveContentState(d, "mail");
    var mail = contentSub(d, "mail");
    if (mailState === "awaiting") {
      push("mail", "Mail sync", "awaiting", "Mail has not reported yet",
        "First sync since the restart has not arrived", base + "/mail");
    } else if (mailState === "notconf") {
      push("mail", "Mail sync", "notconf", "Mail is not connected", "Needs mail credentials", base + "/setup");
    } else if (mailState === "error") {
      push("mail", "Mail sync", "blocking", "Mail sync is failing", "The last sync returned an error", base + "/mail");
    } else if (mailState === "stale") {
      push("mail", "Mail sync", "attention", "Mail data is stale",
        "Last synced " + relativeIso(mail.lastSyncedAt), base + "/mail");
    } else {
      push("mail", "Mail sync", "ok", mail.unreadCount + " unread of " + mail.totalCount.toLocaleString(),
        "Synced " + relativeIso(mail.lastSyncedAt), base + "/mail");
    }

    // 4. azure cost (structurally absent on personal — never data-driven)
    var costState = resolveContentState(d, "azureCost");
    var cost = contentSub(d, "azureCost");
    if (costState === "na") {
      push("cost", "Azure cost", "na", null, null, null);
    } else if (costState === "awaiting") {
      push("cost", "Azure cost", "awaiting", "Cost has not reported yet",
        "First query since the restart has not arrived", base + "/cost");
    } else if (costState === "notconf") {
      push("cost", "Azure cost", "notconf", "Azure cost is not connected", "Needs Azure credentials", base + "/setup");
    } else if (costState === "error") {
      push("cost", "Azure cost", "blocking", "Azure cost query is failing",
        "The last Cost Management call returned an error", base + "/cost");
    } else if (costState === "stale") {
      push("cost", "Azure cost", "attention", "Cost data is stale",
        "Last synced " + relativeIso(cost.lastSyncedAt), base + "/cost");
    } else {
      push("cost", "Azure cost", "ok",
        formatCurrency(cost.monthToDateCost, cost.currency) + " month to date",
        "Synced " + relativeIso(cost.lastSyncedAt), base + "/cost");
    }

    // 5. modules — a roster built from restart counts never lists a module
    //    that has not restarted, so an empty list is absence of measurement,
    //    not absence of modules.
    var mods = (d && d.moduleHealth) || [];
    if (!mods.length) {
      push("modules", "Module roster", "unmeasured", "Roster not published",
        "only modules that have restarted are ever published", base + "/modules");
    } else {
      var bad = mods.filter(function (m) { return m.status === "crashed" || m.status === "degraded"; });
      if (bad.length) {
        push("modules", "Module roster", bad.some(function (m) { return m.status === "crashed"; }) ? "blocking" : "attention",
          bad.length + " module" + (bad.length > 1 ? "s" : "") + " not healthy",
          bad.map(function (m) { return m.moduleId; }).join(", "), base + "/modules");
      } else {
        push("modules", "Module roster", "ok", mods.length + " registered, none degraded", null, base + "/modules");
      }
    }

    // 6. errors
    if (UNMEASURED.errors) {
      push("errors", "Errors 24h", "unmeasured", "Error log not connected", UNMEASURED.errors, base + "/errors");
    } else {
      var ec = (d && d.errorCounts) || { fatal24h: 0, transient24h: 0 };
      push("errors", "Errors 24h", ec.fatal24h > 0 ? "blocking" : "ok",
        ec.fatal24h + " fatal, " + ec.transient24h + " transient", null, base + "/errors");
    }

    // 7. approvals
    if (UNMEASURED.approvals) {
      push("approvals", "Awaiting your decision", "unmeasured", "Approvals queue has no producer",
        UNMEASURED.approvals, base + "/approvals");
    } else {
      var pending = (d && d.totalPending) || 0;
      push("approvals", "Awaiting your decision", pending ? "attention" : "ok",
        pending ? pending + " awaiting you" : "Nothing awaiting you", null, base + "/approvals");
    }

    return out;
  }

  var MEASURED_STATES = { ok: 1, attention: 1, blocking: 1 };

  /**
   * Ranking, worst first: a real finding always outranks "still loading".
   * blocking > attention > awaiting > partial coverage > all clear.
   * Only the two non-clear verdicts ink their headline — a large green
   * sentence reads as a success toast on the 95% of days nothing is wrong.
   */
  function computeVerdict(checks) {
    var real = checks.filter(function (c) { return c.state !== "na"; });
    var measured = real.filter(function (c) { return MEASURED_STATES[c.state]; }).length;
    var blocking = real.filter(function (c) { return c.state === "blocking"; });
    var attention = real.filter(function (c) { return c.state === "attention"; });
    var awaiting = real.filter(function (c) { return c.state === "awaiting"; });
    var unmeasured = real.filter(function (c) { return !MEASURED_STATES[c.state]; });

    var v = {
      measured: measured, total: real.length, unmeasured: unmeasured.length,
      findings: blocking.concat(attention)
    };
    if (blocking.length) {
      v.kind = "blocking"; v.title = "Needs you"; v.line = blocking[0].head;
    } else if (attention.length) {
      v.kind = "attention"; v.title = "Worth a look"; v.line = attention[0].head;
    } else if (awaiting.length) {
      v.kind = "awaiting"; v.title = "Checking…";
      v.line = awaiting.length + " check" + (awaiting.length > 1 ? "s have" : " has") +
        " not reported in yet — nothing here is stale, it simply has not arrived.";
    } else if (unmeasured.length) {
      v.kind = "partial"; v.title = "All clear";
      v.line = "on the " + measured + " check" + (measured === 1 ? "" : "s") + " that are actually measured.";
    } else {
      v.kind = "ok"; v.title = "All clear"; v.line = "Everything measured is within bounds.";
    }
    return v;
  }

  function relativeIso(iso) {
    if (!iso) return "never";
    return formatRelativeAge(ageFromIso(iso));
  }

  // ---------------- overview ----------------

  function renderOverview(d) {
    var dom = d ? d.domain : currentDomain;
    var checks = buildChecks(d);
    var v = computeVerdict(checks);
    var base = "#/" + dom;
    var h = "";

    var vs = v.kind === "partial" ? "ok" : v.kind;
    var inked = v.kind === "blocking" || v.kind === "attention";
    h += '<button type="button" class="verdict" data-go="' +
      (v.findings[0] ? v.findings[0].route : base + "/setup") + '">';
    h += '<span class="verdict-kicker"><span style="display:inline-flex;color:' + colorFor(vs) + '">' +
      iconFor(vs) + '</span>' + escapeHtml(DOMAIN_LABELS[dom] || dom) + '</span>';
    h += '<h1' + (inked ? ' style="color:' + colorFor(v.kind) + '"' : '') + '>' + escapeHtml(v.title) +
      (v.kind === "partial" ? ' <em>on ' + v.measured + ' of ' + v.total + ' checks</em>' : '') + '</h1>';
    h += '<p>' + escapeHtml(v.line) + '</p>';
    h += '<span class="cov"><b>' + v.measured + '/' + v.total + '</b> measured' +
      '<span class="cov-bar"><i style="width:' + Math.round(v.measured / Math.max(v.total, 1) * 100) + '%"></i></span>' +
      (v.unmeasured ? '<b>' + v.unmeasured + '</b> not measured' : '') + '</span>';
    h += '</button>';

    for (var i = 0; i < v.findings.length; i++) {
      var c = v.findings[i];
      h += '<button type="button" class="finding" data-go="' + c.route + '">' +
        '<span style="flex:none;margin-top:1px;color:' + colorFor(c.state) + '">' + iconFor(c.state) + '</span>' +
        '<span class="txt"><span class="h">' + escapeHtml(c.head) + '</span>' +
        (c.ev ? '<span class="e">' + escapeHtml(c.ev) + '</span>' : '') + '</span>' +
        '<span class="chev">' + ICON.chev + '</span></button>';
    }

    h += renderSetupCard(checks, dom);
    h += renderEverythingElse(d, checks, dom);
    return h;
  }

  /**
   * Collapses the not_configured panels into one card that reads as progress
   * rather than as a row of failures. Unconnected rows keep full-contrast
   * labels — a dimmed label reads as disabled, a full one reads as a to-do.
   */
  function renderSetupCard(checks, dom) {
    var connectable = checks.filter(function (c) { return c.state !== "na" && c.state !== "unmeasured"; });
    var notconf = connectable.filter(function (c) { return c.state === "notconf"; });
    if (!notconf.length || !connectable.length) return "";

    var connected = connectable.length - notconf.length;
    var segs = "";
    for (var i = 0; i < connectable.length; i++) segs += '<i' + (i < connected ? ' class="on"' : '') + '></i>';

    var h = '<div class="setup"><div class="setup-h"><b>Setup</b>' +
      '<span class="setup-prog">' + segs + '</span>' +
      '<span>' + connected + ' of ' + connectable.length + ' connected</span></div>';

    // Connected first: the eye enters on evidence something already works.
    var ordered = connectable.filter(function (c) { return c.state !== "notconf"; })
      .concat(notconf);
    for (var j = 0; j < ordered.length; j++) {
      var c = ordered[j];
      var done = c.state !== "notconf";
      h += '<button type="button" class="setup-row" data-go="#/' + dom + '/setup"' + (done ? ' tabindex="-1"' : '') + '>' +
        '<span style="flex:none;color:' + (done ? "var(--pill-valid)" : "var(--ink-quiet)") + '">' +
        (done ? ICON.ok : ICON.ghost) + '</span>' +
        '<span class="nm">' + escapeHtml(c.label) + '</span>' +
        (done ? '<span class="st">Connected</span>'
              : '<span class="act">Connect ' + ICON.chev + '</span>') + '</button>';
    }
    h += '<div class="setup-foot">' + notconf.length + ' left</div></div>';
    return h;
  }

  function cell(label, valueHtml, sub, route, opts) {
    opts = opts || {};
    var attrs = 'class="cell"';
    if (opts.inert) attrs += ' data-inert="1"';
    if (opts.ghost) attrs += ' data-ghost="1"';
    if (route) attrs += ' data-go="' + route + '"';
    return '<button type="button" ' + attrs + '><span class="lb">' + escapeHtml(label) + '</span>' +
      valueHtml + (sub ? '<span class="sub">' + escapeHtml(sub) + '</span>' : '') + '</button>';
  }
  /** dashed = you can connect this. */
  function ghostCell(label, route) {
    return cell(label, '<span class="awaitv" style="color:var(--ghost-text)">' + ICON.ghost + 'Not connected</span>',
      "Connect in Setup", route, { ghost: true });
  }
  /** solid + clock = configured, waiting on the first report. */
  function awaitCell(label, route) {
    return cell(label, '<span class="awaitv">' + ICON.clock + 'First sync not in yet</span>', null, route, {});
  }
  /** solid + dash = nothing to wait for and nothing to do. No chevron: there is no detail behind it. */
  function unmeasuredCell(label, why) {
    return cell(label, '<span class="dashglyph"></span><span class="nosig">Not measured — ' + escapeHtml(why) + '</span>',
      null, null, { inert: true });
  }

  function renderEverythingElse(d, checks, dom) {
    var base = "#/" + dom;
    var h = '<details class="disc"' + (discOpen ? " open" : "") + '><summary><span class="tri">' + ICON.chev +
      '</span>Everything else</summary><div class="grid">';

    var mailState = resolveContentState(d, "mail");
    var mail = contentSub(d, "mail");
    if (hasNumeral(mailState)) {
      h += cell("Unread mail", '<span class="vl">' + mail.unreadCount.toLocaleString() + '</span>',
        relativeIso(mail.lastSyncedAt), base + "/mail");
      h += cell("Total messages", '<span class="vl">' + mail.totalCount.toLocaleString() + '</span>',
        relativeIso(mail.lastSyncedAt), base + "/mail");
    } else if (mailState === "awaiting") {
      h += awaitCell("Unread mail", base + "/mail");
      h += awaitCell("Total messages", base + "/mail");
    } else if (mailState === "error") {
      h += cell("Unread mail", '<span class="awaitv" style="color:var(--pill-expired)">' + ICON.crit + 'Sync failed</span>',
        null, base + "/mail");
      h += cell("Total messages", '<span class="awaitv" style="color:var(--pill-expired)">' + ICON.crit + 'Sync failed</span>',
        null, base + "/mail");
    } else {
      h += ghostCell("Unread mail", base + "/setup");
      h += ghostCell("Total messages", base + "/setup");
    }

    var costState = resolveContentState(d, "azureCost");
    var cost = contentSub(d, "azureCost");
    if (costState !== "na") {
      if (hasNumeral(costState)) {
        h += cell("Azure month to date", '<span class="vl">' + escapeHtml(formatCurrency(cost.monthToDateCost, cost.currency)) + '</span>',
          relativeIso(cost.lastSyncedAt), base + "/cost");
      } else if (costState === "awaiting") {
        h += awaitCell("Azure month to date", base + "/cost");
      } else if (costState === "error") {
        h += cell("Azure month to date", '<span class="awaitv" style="color:var(--pill-expired)">' + ICON.crit + 'Query failed</span>',
          null, base + "/cost");
      } else {
        h += ghostCell("Azure month to date", base + "/setup");
      }
    }

    var creds = (d && d.credentialStatus) || [];
    if (creds.length) {
      var worst = worstCredentialStatus(creds);
      var needs = creds.filter(function (c) { return c.status !== "valid"; }).length;
      h += cell("Credentials", '<span class="vl">' + creds.length + '</span><span class="delta">' +
        (needs ? escapeHtml(needs + " need attention") : "all valid") + '</span>', null, base + "/credentials");
    } else {
      h += unmeasuredCell("Credentials", "the domain reported an empty credential list");
    }

    var mods = (d && d.moduleHealth) || [];
    if (mods.length) {
      h += cell("Modules", '<span class="vl">' + mods.length + '</span><span class="delta">registered</span>',
        null, base + "/modules");
    } else {
      h += unmeasuredCell("Modules", "only modules that have restarted are ever published");
    }

    if (UNMEASURED.errors) {
      h += unmeasuredCell("Errors 24h", UNMEASURED.errors);
    } else {
      var ec = (d && d.errorCounts) || { fatal24h: 0, transient24h: 0 };
      h += cell("Errors 24h", '<span class="vl">' + ec.fatal24h + '</span><span class="delta">' +
        ec.transient24h + ' transient</span>', null, base + "/errors");
    }

    if (UNMEASURED.approvals) {
      h += unmeasuredCell("Awaiting decision", UNMEASURED.approvals);
    } else {
      h += cell("Awaiting decision", '<span class="vl">' + ((d && d.totalPending) || 0) + '</span>',
        null, base + "/approvals");
    }

    var reportState = (!d || d.awaitingFirstReport) ? "awaiting" : (d.stale ? "stale" : "ok");
    if (reportState === "awaiting") {
      h += awaitCell("Health reporting", base + "/errors");
    } else {
      h += cell("Health reporting",
        '<span class="vl sm">' + (reportState === "stale" ? "Stale" : "Reporting") + '</span>',
        "last report " + formatRelativeAge(d.ageMs), base + "/errors");
    }

    h += '</div></details>';
    return h;
  }

  // ---------------- detail frame ----------------

  function frame(dom, title, meta, body, floorLabel, floorSeed) {
    var h = '<button type="button" class="back" data-go="#/' + dom + '">' + ICON.left +
      escapeHtml(DOMAIN_LABELS[dom] || dom) + ' overview</button>';
    h += '<div class="dt-h"><h2>' + escapeHtml(title) + '</h2>' +
      (meta ? '<div class="meta">' + escapeHtml(meta) + '</div>' : '') + '</div>';
    h += body;
    if (floorLabel) {
      // Show the question before composing it — a button that silently
      // writes on your behalf is the thing that erodes trust in an assistant.
      h += '<div class="coda"><button type="button" class="floor" data-seed="' + escapeHtml(floorSeed) + '">' +
        ICON.chat + escapeHtml(floorLabel) + '</button>' +
        '<p class="seedprompt">“' + escapeHtml(floorSeed) + '” — you can edit it before sending</p></div>';
    }
    return h;
  }

  function stateBlock(kind, title, bodyText) {
    var icon = kind === "ghost" ? ICON.ghost : kind === "await" ? ICON.clock : ICON.dash;
    return '<div class="stateblock' + (kind === "ghost" ? " ghost" : "") + '">' +
      '<b><span style="color:var(--ink-quiet)">' + icon + '</span>' + escapeHtml(title) + '</b>' +
      escapeHtml(bodyText) + '</div>';
  }

  function renderRankRow(route, name, valueText, width) {
    return '<button type="button" ' + (route ? 'data-go="' + route + '"' : "") + '>' +
      '<span class="nm" title="' + escapeHtml(name) + '">' + escapeHtml(name) + '</span>' +
      '<span class="tr" style="width:' + width + 'px"></span>' +
      '<span class="vv">' + escapeHtml(valueText) + '</span></button>';
  }

  // ---------------- detail views ----------------

  function viewMail(dom, d) {
    var state = resolveContentState(d, "mail");
    var mail = contentSub(d, "mail");
    if (state === "awaiting") {
      return frame(dom, "Mail", null, stateBlock("await", "First sync has not arrived",
        "The mail module is configured. Nothing here is stale, because nothing has been measured yet — " +
        "the first report since starting has not come in."));
    }
    if (state === "notconf") {
      return frame(dom, "Mail", null, stateBlock("ghost", "Not connected",
        "Mail credentials are not configured for this domain, so no mail data is being collected."));
    }
    if (state === "error") {
      return frame(dom, "Mail", null, stateBlock("dash", "Mail sync is failing",
        "The last sync returned an error, so the counts below would be wrong and are not shown."),
        "Ask JARVIS about this", "Why is my " + (DOMAIN_LABELS[dom] || dom) + " mail sync failing?");
    }

    var pct = mail.totalCount > 0 ? Math.round(mail.unreadCount / mail.totalCount * 100) : 0;
    var body = '<div class="panel"><h3>Unread</h3><div class="big">' + mail.unreadCount.toLocaleString() + '</div>' +
      '<div class="bigsub">of ' + mail.totalCount.toLocaleString() + ' messages · synced ' +
      escapeHtml(relativeIso(mail.lastSyncedAt)) + '</div>' +
      '<div class="meter"><i style="width:' + Math.max(pct, mail.unreadCount > 0 ? 2 : 0) + '%"></i></div>' +
      '<div class="mcap">' + pct + '% unread</div></div>';

    var senders = mail.topSenders || [];
    if (senders.length) {
      var max = senders[0].messageCount || 1;
      var sum = 0;
      body += '<div class="panel"><h3>Top senders</h3><div class="rank">';
      for (var i = 0; i < senders.length; i++) {
        sum += senders[i].messageCount;
        body += renderRankRow("#/" + dom + "/mail/sender/" + i, senders[i].displayName,
          String(senders[i].messageCount), Math.max(Math.round(senders[i].messageCount / max * 124), 3));
      }
      body += '</div><p class="note">These ' + senders.length + ' are the head of the distribution, not the whole of it — ' +
        'they account for ' + sum + ' of ' + mail.unreadCount + ' unread.</p></div>';
    }

    return frame(dom, "Mail", "Counts and sender names only — the summary that crosses the domain boundary carries no subjects",
      body, "Ask JARVIS about this mailbox",
      "Summarise what's been arriving in my " + (DOMAIN_LABELS[dom] || dom) + " inbox lately");
  }

  function viewSender(dom, d, idx) {
    var mail = contentSub(d, "mail");
    if (!mail || !mail.topSenders || !mail.topSenders[idx]) return viewMail(dom, d);
    var s = mail.topSenders[idx];
    var topTotal = mail.topSenders.reduce(function (a, b) { return a + b.messageCount; }, 0) || 1;
    var body = '<div class="panel"><h3>Messages</h3><div class="big">' + s.messageCount + '</div>' +
      '<div class="bigsub">rank ' + (idx + 1) + ' of ' + mail.topSenders.length + ' · ' +
      Math.round(s.messageCount / topTotal * 100) + '% of the top senders' +
      (mail.unreadCount > 0 ? ' · ' + Math.round(s.messageCount / mail.unreadCount * 100) + '% of all unread' : '') +
      '</div></div>';
    body += '<div class="panel"><h3>What the dashboard can see</h3>' +
      '<p style="margin:0;font-size:13.5px;color:var(--muted)">The mail summary that crosses the domain boundary carries ' +
      'counts and a capped display name — no subjects, no message list, no addresses. That is a deliberate property of ' +
      'the channel, not a missing feature. To go further, hand it to JARVIS.</p></div>';
    return frame(dom, s.displayName, "Last synced " + relativeIso(mail.lastSyncedAt), body,
      "Ask JARVIS about this sender", "Summarise recent mail from " + s.displayName);
  }

  function viewCost(dom, d) {
    var state = resolveContentState(d, "azureCost");
    var cost = contentSub(d, "azureCost");
    if (state === "na") return null;
    if (state === "awaiting") {
      return frame(dom, "Azure cost", null, stateBlock("await", "First query has not arrived",
        "Cost Management is configured. The first query since starting has not returned yet."));
    }
    if (state === "notconf") {
      return frame(dom, "Azure cost", null, stateBlock("ghost", "Not connected",
        "Azure credentials are not configured, so no cost data is being collected."));
    }
    if (state === "error") {
      return frame(dom, "Azure cost", null, stateBlock("dash", "Cost query is failing",
        "The last Cost Management call returned an error, so no figure is shown rather than a misleading zero."),
        "Ask JARVIS about this", "Why is my Azure cost query failing?");
    }

    var body = '<div class="panel"><h3>Month to date</h3><div class="big">' +
      escapeHtml(formatCurrency(cost.monthToDateCost, cost.currency)) + '</div>' +
      '<div class="bigsub">synced ' + escapeHtml(relativeIso(cost.lastSyncedAt)) + '</div></div>';

    var services = cost.topServices || [];
    if (services.length) {
      var max = services[0].cost || 1;
      var top = 0;
      body += '<div class="panel"><h3>Top services</h3><div class="rank">';
      for (var i = 0; i < services.length; i++) {
        top += services[i].cost;
        body += renderRankRow("#/" + dom + "/cost/service/" + i, services[i].serviceName,
          formatCurrency(services[i].cost, cost.currency), Math.max(Math.round(services[i].cost / max * 124), 3));
      }
      body += '</div>';
      if (cost.monthToDateCost !== null && cost.monthToDateCost > top) {
        body += '<p class="note">Top ' + services.length + ' account for ' + escapeHtml(formatCurrency(top, cost.currency)) +
          ' of ' + escapeHtml(formatCurrency(cost.monthToDateCost, cost.currency)) + ' month to date. The remaining ' +
          escapeHtml(formatCurrency(cost.monthToDateCost - top, cost.currency)) + ' is spread across everything else.</p>';
      }
      body += '</div>';
    }
    body += '<p class="note">Cost is queried without a time grain, so there is no day-by-day trend to show yet.</p>';

    return frame(dom, "Azure cost", "Cost Management, month to date, grouped by service", body,
      "Ask JARVIS about this spend", "Why is my Azure spend what it is this month?");
  }

  function viewService(dom, d, idx) {
    var cost = contentSub(d, "azureCost");
    if (!cost || !cost.topServices || !cost.topServices[idx]) return viewCost(dom, d);
    var s = cost.topServices[idx];
    var top = cost.topServices.reduce(function (a, b) { return a + b.cost; }, 0) || 1;
    var body = '<div class="panel"><h3>Month to date</h3><div class="big">' +
      escapeHtml(formatCurrency(s.cost, cost.currency)) + '</div>' +
      '<div class="bigsub">rank ' + (idx + 1) + ' of ' + cost.topServices.length + ' · ' +
      Math.round(s.cost / top * 100) + '% of the top services' +
      (cost.monthToDateCost ? ' · ' + Math.round(s.cost / cost.monthToDateCost * 100) + '% of total spend' : '') +
      '</div></div>';
    return frame(dom, s.serviceName, "Azure service · " + cost.currency, body,
      "Ask JARVIS about this service", "What is driving my Azure " + s.serviceName + " spend this month?");
  }

  function viewCredentials(dom, d) {
    var creds = (d && d.credentialStatus) || [];
    if (!creds.length) {
      return frame(dom, "Credentials", null, stateBlock("dash", "No credentials tracked",
        "This domain reported an empty credential list, so there is nothing to audit for expiry."));
    }
    var body = '<div class="panel"><table><thead><tr><th>Credential</th><th>Status</th><th>Expires</th></tr></thead><tbody>';
    for (var i = 0; i < creds.length; i++) {
      var c = creds[i];
      body += '<tr><td><button type="button" class="rowbtn" data-go="#/' + dom + '/credentials/' +
        encodeURIComponent(c.credentialRef) + '"><span class="mono">' + escapeHtml(c.credentialRef) + '</span></button></td>' +
        '<td>' + credentialPill(c.status) + '</td>' +
        '<td style="color:var(--muted)">' + escapeHtml(c.expiresAt ? relativeIso(c.expiresAt) : "—") + '</td></tr>';
    }
    body += '</tbody></table></div>';
    if (creds.some(function (c) { return c.status === "invalid"; })) {
      body += '<p class="note">A credential shown as never configured has no stored value to check. That is a setup gap, ' +
        'not a failure — nothing has broken because of it.</p>';
    }
    return frame(dom, "Credentials", creds.length + " tracked, worst first", body,
      "Ask JARVIS about these credentials", "Which of my credentials need attention and in what order?");
  }

  function viewCredential(dom, d, ref) {
    var creds = (d && d.credentialStatus) || [];
    var c = null;
    for (var i = 0; i < creds.length; i++) if (creds[i].credentialRef === ref) c = creds[i];
    if (!c) return viewCredentials(dom, d);
    var body = '<div class="panel"><h3>Status</h3><div style="margin-bottom:14px">' + credentialPill(c.status) + '</div>' +
      '<table><tbody>' +
      '<tr><td class="tdlabel">Reference</td><td><span class="mono">' + escapeHtml(c.credentialRef) + '</span></td></tr>' +
      '<tr><td class="tdlabel">Expires</td><td>' + escapeHtml(c.expiresAt ? relativeIso(c.expiresAt) : "no expiry recorded") + '</td></tr>' +
      '</tbody></table></div>';
    if (c.status === "invalid") {
      body += '<p class="note">This reference has no stored value. Until one is set, anything depending on it stays dark — ' +
        'but nothing is failing that was previously working.</p>';
    } else if (c.status === "expired") {
      body += '<p class="note warnish">This credential has already lapsed. Anything that uses it is failing now.</p>';
    } else if (c.status === "expiring_soon") {
      body += '<p class="note warnish">Rotate this before it lapses. Rotation happens in the environment file on the host, ' +
        'followed by a restart — the dashboard has no write path to credentials by design.</p>';
    }
    return frame(dom, c.credentialRef, "Credential detail", body,
      "Ask JARVIS about this credential", "What breaks if " + c.credentialRef + " expires, and how do I rotate it?");
  }

  function viewModules(dom, d) {
    var mods = (d && d.moduleHealth) || [];
    if (!mods.length) {
      return frame(dom, "Modules", null, stateBlock("dash", "Roster not published",
        "Module health is built from restart counts, so a module that has never restarted never appears — which on a " +
        "healthy system means none of them do. An empty roster is absence of measurement, not absence of modules."));
    }
    var body = '<div class="panel"><table><thead><tr><th>Module</th><th>Status</th><th style="text-align:right">Restarts 24h</th></tr></thead><tbody>';
    for (var i = 0; i < mods.length; i++) {
      var m = mods[i];
      var pill = m.status === "healthy" ? '<span class="pill p-ok">' + ICON.ok + 'Healthy</span>'
        : m.status === "degraded" ? '<span class="pill p-warn">' + ICON.warn + 'Degraded</span>'
        : m.status === "crashed" ? '<span class="pill p-bad">' + ICON.crit + 'Crashed</span>'
        : '<span class="pill p-ghost">' + ICON.ghost + 'Disabled</span>';
      body += '<tr><td><span class="mono">' + escapeHtml(m.moduleId) + '</span></td><td>' + pill +
        '</td><td style="text-align:right;font-variant-numeric:tabular-nums">' + m.restartCount24h + '</td></tr>';
    }
    body += '</tbody></table></div>';
    return frame(dom, "Modules", mods.length + " in the roster", body,
      "Ask JARVIS about these modules", "Are all my modules doing what they should be?");
  }

  function viewErrors(dom, d) {
    var body = "";
    if (UNMEASURED.errors) {
      body += stateBlock("dash", "Error counts are not connected",
        "The orchestrator starts its cycles without an error source, so this reports zero regardless of what is " +
        "actually happening. A green zero here would mean nothing is being counted.");
    } else {
      var ec = (d && d.errorCounts) || { fatal24h: 0, transient24h: 0 };
      body += '<div class="panel"><h3>Last 24 hours</h3><div style="display:flex;gap:28px">' +
        '<div><div class="big">' + ec.fatal24h + '</div><div class="bigsub">fatal</div></div>' +
        '<div><div class="big" style="color:var(--muted)">' + ec.transient24h + '</div><div class="bigsub">transient</div></div>' +
        '</div></div>';
    }
    body += '<div class="panel"><h3>Health reporting</h3><table><tbody>' +
      '<tr><td class="tdlabel">Last report</td><td>' +
      escapeHtml(d && !d.awaitingFirstReport ? formatRelativeAge(d.ageMs) : "not yet") + '</td></tr>' +
      '<tr><td class="tdlabel">State</td><td>' +
      (!d || d.awaitingFirstReport ? '<span class="pill p-none">' + ICON.clock + 'Awaiting first report</span>'
        : d.stale ? '<span class="pill p-warn">' + ICON.warn + 'Stale</span>'
        : '<span class="pill p-ok">' + ICON.ok + 'Fresh</span>') + '</td></tr>' +
      '</tbody></table></div>';
    return frame(dom, "Errors and reporting", "Operational counts for this domain", body,
      "Ask JARVIS about this", "Have there been any errors worth my attention today?");
  }

  function viewApprovals(dom, d) {
    var body = "";
    if (UNMEASURED.approvals) {
      body += stateBlock("dash", "Nothing reaches this queue",
        "The reviewer writes proposals every cycle, but they are never handed to the approval gate — so this queue is " +
        "empty for structural reasons, not because there is nothing to decide.");
    }
    var list = (d && d.approvals) || [];
    if (list.length) {
      body += '<div class="panel"><h3>Awaiting your decision</h3><div class="rank">';
      for (var i = 0; i < list.length; i++) {
        body += '<button type="button" style="grid-template-columns:1fr auto">' +
          '<span style="min-width:0"><span style="display:block;font-size:13.5px;white-space:normal;line-height:1.4">' +
          escapeHtml(list[i].summary) + '</span><span style="display:block;font-size:11.5px;color:var(--muted);margin-top:3px">' +
          escapeHtml(list[i].kind) + ' · ' + escapeHtml(relativeIso(list[i].proposedAt)) + '</span></span></button>';
      }
      body += '</div></div>';
      if (d.totalPending > list.length) {
        body += '<p class="note">Showing ' + list.length + ' of ' + d.totalPending + ' pending.</p>';
      }
    }
    body += '<p class="note">Approving or rejecting from the dashboard is not available. It needs a write path, and the ' +
      'dashboard deliberately has none for approvals.</p>';
    return frame(dom, "Awaiting your decision", null, body,
      "Ask JARVIS about this", "What decisions are waiting on me?");
  }

  function viewSetup(dom, d) {
    var checks = buildChecks(d).filter(function (c) { return c.state === "notconf"; });
    var body = "";
    if (!checks.length) {
      body = '<div class="panel"><p style="margin:0">Everything that can be connected is connected.</p></div>';
    } else {
      for (var i = 0; i < checks.length; i++) {
        body += '<div class="panel"><h3>' + escapeHtml(checks[i].label) + '</h3>' +
          '<p style="margin:0;font-size:13.5px;color:var(--muted)">' +
          escapeHtml(checks[i].id === "cost"
            ? "Connecting this unlocks month-to-date spend and the top services behind it."
            : "Connecting this unlocks unread and total counts, and the senders behind them.") +
          '</p></div>';
      }
      body += '<p class="note">Credentials are set in the environment file on the host and picked up on restart. ' +
        'The dashboard has no write path to them by design, so it can tell you what is missing but never set it.</p>';
    }
    return frame(dom, "Setup", "What is not connected, and what connecting it gives you", body);
  }

  // ---------------- routing ----------------

  function findDomainPayload(payload, domain) {
    if (!payload || !payload.domains) return null;
    for (var i = 0; i < payload.domains.length; i++) {
      if (payload.domains[i].domain === domain) return payload.domains[i];
    }
    return null;
  }

  function parseRoute() {
    // Deliberately not a regex: inside this template literal a backslash
    // escape is consumed before it reaches the browser, so /^#\/?/ would ship
    // as /^#/?/ and throw at parse time. String ops can't regress that way.
    var raw = location.hash;
    if (raw.charAt(0) === "#") raw = raw.slice(1);
    if (raw.charAt(0) === "/") raw = raw.slice(1);
    var parts = raw ? raw.split("/") : [];
    var dom = DOMAIN_LABELS.hasOwnProperty(parts[0]) ? parts[0] : currentDomain;
    return { dom: dom, sec: parts[1] || "", a: parts[2] || "", b: parts[3] || "" };
  }

  function go(hash) {
    scrollMem[location.hash] = window.scrollY;
    location.hash = hash;
  }

  function renderDetail(r, d) {
    if (r.sec === "mail" && r.a === "sender") return viewSender(r.dom, d, parseInt(r.b, 10));
    if (r.sec === "mail") return viewMail(r.dom, d);
    if (r.sec === "cost" && r.a === "service") return viewService(r.dom, d, parseInt(r.b, 10));
    if (r.sec === "cost") return viewCost(r.dom, d);
    if (r.sec === "credentials" && r.a) return viewCredential(r.dom, d, decodeURIComponent(r.a));
    if (r.sec === "credentials") return viewCredentials(r.dom, d);
    if (r.sec === "modules") return viewModules(r.dom, d);
    if (r.sec === "errors") return viewErrors(r.dom, d);
    if (r.sec === "approvals") return viewApprovals(r.dom, d);
    if (r.sec === "setup") return viewSetup(r.dom, d);
    return null;
  }

  function renderView() {
    var r = parseRoute();
    if (r.dom !== currentDomain) switchDomain(r.dom);

    var viewEl = document.getElementById("view");
    var chatEl = document.getElementById("chat");
    var onChat = r.sec === "chat";

    chatEl.hidden = !onChat;
    viewEl.hidden = onChat;
    document.body.setAttribute("data-depth", r.sec && !onChat ? "detail" : "top");

    var tabs = document.querySelectorAll(".tabs button");
    for (var i = 0; i < tabs.length; i++) {
      var isChatTab = tabs[i].getAttribute("data-tab") === "chat";
      tabs[i].setAttribute("aria-current", isChatTab === onChat ? "page" : "false");
    }

    if (!onChat) {
      var d = findDomainPayload(latestPayload, r.dom);
      var html = r.sec ? renderDetail(r, d) : null;
      // An unknown or structurally-absent section (e.g. /cost on personal)
      // falls back to the overview rather than rendering an empty shell.
      if (r.sec && html === null) {
        viewEl.innerHTML = renderOverview(d);
        viewEl.className = "wrap" + (discOpen ? " wide" : "");
      } else if (r.sec) {
        viewEl.innerHTML = html;
        viewEl.className = "wrap";
      } else {
        viewEl.innerHTML = renderOverview(d);
        viewEl.className = "wrap" + (discOpen ? " wide" : "");
      }
    } else if (seededPrompt) {
      var input = document.getElementById("chat-input");
      if (input && !input.value) {
        input.value = seededPrompt;
        updateSendAvailability();
        input.focus();
        try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) {}
      }
      seededPrompt = "";
    }

    window.scrollTo(0, scrollMem[location.hash] || 0);
  }

  function renderFreshness() {
    var el = document.getElementById("fresh");
    if (!el) return;
    var d = findDomainPayload(latestPayload, currentDomain);
    if (!d) { el.textContent = ""; return; }
    el.textContent = d.awaitingFirstReport ? "no report yet" : "as of " + formatRelativeAge(d.ageMs);
  }

  function renderAll() {
    renderView();
    renderFreshness();
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
        renderAll();
      })
      .catch(function (err) {
        loadErrorEl.hidden = false;
        loadErrorEl.textContent = "Can't reach JARVIS: " + err.message;
      });
  }

  // ---------------- domain switch ----------------

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

    loadChatHistory(domain, domainGeneration);
  }

  function setupModeBar() {
    var segments = document.querySelectorAll(".segment");
    for (var i = 0; i < segments.length; i++) {
      (function (seg) {
        seg.addEventListener("click", function () { go("#/" + seg.getAttribute("data-domain")); });
        seg.addEventListener("keydown", function (ev) {
          if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
          ev.preventDefault();
          var domains = Object.keys(DOMAIN_LABELS);
          var idx = domains.indexOf(currentDomain);
          var next = domains[(idx + (ev.key === "ArrowRight" ? 1 : domains.length - 1)) % domains.length];
          go("#/" + next);
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

  function setupNavigation() {
    document.addEventListener("click", function (ev) {
      var seed = ev.target.closest ? ev.target.closest("[data-seed]") : null;
      if (seed) {
        seededPrompt = seed.getAttribute("data-seed");
        go("#/" + currentDomain + "/chat");
        return;
      }
      var target = ev.target.closest ? ev.target.closest("[data-go]") : null;
      if (target) { go(target.getAttribute("data-go")); return; }
      var nav = ev.target.closest ? ev.target.closest("[data-nav]") : null;
      if (nav && nav.getAttribute("data-nav") === "overview") { go("#/" + currentDomain); return; }
      var tab = ev.target.closest ? ev.target.closest(".tabs button") : null;
      if (tab) {
        go(tab.getAttribute("data-tab") === "chat" ? "#/" + currentDomain + "/chat" : "#/" + currentDomain);
      }
    });

    // The disclosure is the one piece of view state the hash does not carry:
    // it is a reading preference, not a location, so it survives re-render
    // and polling but is deliberately not linkable.
    document.addEventListener("toggle", function (ev) {
      if (ev.target && ev.target.classList && ev.target.classList.contains("disc")) {
        discOpen = ev.target.open;
        var viewEl = document.getElementById("view");
        if (viewEl) viewEl.className = "wrap" + (discOpen ? " wide" : "");
      }
    }, true);

    window.addEventListener("hashchange", renderAll);
  }

  function init() {
    try {
      var saved = window.localStorage.getItem("jarvis-dashboard-domain");
      if (saved && DOMAIN_LABELS.hasOwnProperty(saved)) currentDomain = saved;
    } catch (e) {}

    setupModeBar();
    updateModeBarSelection();
    setupChat();
    setupNavigation();

    if (!location.hash) location.hash = "#/" + currentDomain;
    renderView();

    poll();
    setInterval(poll, POLL_MS);
    setInterval(renderFreshness, 1000);
    loadChatHistory(currentDomain, domainGeneration);
  }

  // Test-only escape hatch: exposes the pure state-vocabulary and verdict
  // functions so they can be exercised by real unit tests against this
  // actual shipped script, instead of a reimplementation. Inert in
  // production — window.__JARVIS_TEST_MODE__ is never set by real clients,
  // so this branch never runs there and init() always fires exactly as before.
  if (typeof window !== "undefined" && window.__JARVIS_TEST_MODE__) {
    window.__jarvisInternals = {
      resolveContentState: resolveContentState,
      hasNumeral: hasNumeral,
      buildChecks: buildChecks,
      computeVerdict: computeVerdict,
      worstCredentialStatus: worstCredentialStatus,
      worstCredentialEntry: worstCredentialEntry,
      credentialPill: credentialPill,
      renderOverview: renderOverview,
      renderSetupCard: renderSetupCard,
      renderEverythingElse: renderEverythingElse,
      viewMail: viewMail,
      viewCost: viewCost,
      viewCredentials: viewCredentials,
      viewModules: viewModules,
      viewErrors: viewErrors,
      stateBlock: stateBlock,
      relativeIso: relativeIso,
      UNMEASURED: UNMEASURED,
      setCurrentDomain: function (d) { currentDomain = d; }
    };
  } else {
    init();
  }
})();
</script>
</body>
</html>
`;
