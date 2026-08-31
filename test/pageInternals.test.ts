import { describe, expect, it } from "vitest";
import * as vm from "node:vm";
import { DASHBOARD_HTML } from "../src/dashboard/page.js";
import type { MailSummary, AzureCostSummary } from "../src/orchestrator/domainContentSummary.js";

/**
 * Exercises the actual shipped src/dashboard/page.ts script (not a
 * reimplementation) via the __JARVIS_TEST_MODE__ escape hatch it exports
 * itself — see the comment above that block in page.ts. Before this file,
 * the only test touching page.ts was a static-analysis import check; the
 * state-vocabulary rendering (not_configured / connected-zero / stale /
 * error) had zero executable coverage, flagged by both the Tester and the
 * Manager as the one real residual risk in the whole Dashboard v2 build.
 */
interface JarvisInternals {
  renderGhostBlock(reason: string, fix: string): string;
  freshnessLine(summary: { status: string; lastSyncedAt: string | null }): string;
  renderMailHeroTile(mail: MailSummary | null): string;
  renderMailTotalTile(mail: MailSummary | null): string;
  renderAzureTile(azureCost: AzureCostSummary | null): string;
  worstCredentialStatus(list: { status: string }[]): string | null;
  renderMailPanelInner(d: { content: { mail: MailSummary | null } | null }): string;
  renderCostPanelInner(d: { content: { azureCost: AzureCostSummary | null } | null }): string;
  chip(kind: string, text: string): string;
  shouldAutoExpand(d: {
    awaitingFirstReport: boolean;
    credentialStatus: { status: string }[];
    moduleHealth: { status: string }[];
    errorCounts: { fatal24h: number };
  }): boolean;
  renderHealthBandChips(d: unknown): string;
  renderHealthBandBody(d: unknown): string;
  setCurrentDomain(d: "work" | "personal"): void;
}

function extractScript(html: string): string {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error("no <script> block found in DASHBOARD_HTML — page.ts structure changed");
  return match[1]!;
}

function fakeElement(): Record<string, unknown> {
  return {
    addEventListener() {},
    removeEventListener() {},
    classList: { add() {}, remove() {}, toggle() {} },
    style: {},
    setAttribute() {},
    querySelectorAll: () => [],
  };
}

/** Runs the real, shipped dashboard script in test mode and returns its exposed pure render functions. */
function loadInternals(): JarvisInternals {
  const script = extractScript(DASHBOARD_HTML);
  const sandbox: Record<string, unknown> = {
    window: { __JARVIS_TEST_MODE__: true, localStorage: { getItem: () => null, setItem() {} } },
    document: {
      getElementById: () => fakeElement(),
      addEventListener() {},
      createElement: () => fakeElement(),
    },
    fetch: () => Promise.reject(new Error("fetch is disabled in this test — init() should not run in test mode")),
    setInterval: () => 0,
    clearInterval() {},
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  const win = sandbox.window as { __jarvisInternals?: JarvisInternals };
  if (!win.__jarvisInternals) throw new Error("__jarvisInternals was not set — __JARVIS_TEST_MODE__ hook is missing or broken");
  return win.__jarvisInternals;
}

function mail(overrides: Partial<MailSummary> = {}): MailSummary {
  return { status: "connected", unreadCount: 3, totalCount: 42, topSenders: [{ displayName: "Alice", messageCount: 5 }], lastSyncedAt: new Date().toISOString(), ...overrides };
}

function azure(overrides: Partial<AzureCostSummary> = {}): AzureCostSummary {
  return { status: "connected", currency: "USD", monthToDateCost: 123.45, topServices: [{ serviceName: "Storage", cost: 12.3 }], lastSyncedAt: new Date().toISOString(), ...overrides };
}

describe("page.ts state vocabulary — real shipped script", () => {
  describe("not_configured never renders a numeral", () => {
    it("mail hero tile: not_configured shows no unread number, just the ghost block", () => {
      const { renderMailHeroTile } = loadInternals();
      const html = renderMailHeroTile(mail({ status: "not_configured" }));
      expect(html).toContain("ghost-block");
      expect(html).toContain("Not configured");
      expect(html).not.toContain("tile-value");
    });

    it("mail hero tile: not_configured via a null summary (never fetched at all) also ghosts, not '0'", () => {
      const { renderMailHeroTile } = loadInternals();
      const html = renderMailHeroTile(null);
      expect(html).toContain("ghost-block");
      expect(html).not.toContain("tile-value");
    });

    it("azure tile: not_configured shows no cost figure, just the ghost block", () => {
      const { renderAzureTile } = loadInternals();
      const html = renderAzureTile(azure({ status: "not_configured" }));
      expect(html).toContain("ghost-block");
      expect(html).not.toContain("tile-value");
    });

    it("ghost fix text is domain-specific — work names the NZB env var, personal names Hotmail's (user-reviewer's required fix)", () => {
      const { renderMailHeroTile, setCurrentDomain } = loadInternals();
      setCurrentDomain("work");
      expect(renderMailHeroTile(mail({ status: "not_configured" }))).toContain("JARVIS_WORK_NZB_M365_OAUTH");
      setCurrentDomain("personal");
      expect(renderMailHeroTile(mail({ status: "not_configured" }))).toContain("JARVIS_PERSONAL_HOTMAIL_OAUTH");
    });
  });

  describe("connected + zero renders identically to any real value — never a falsy-check regression", () => {
    it("mail hero tile: unreadCount 0 renders the numeral 0 as a normal tile, not a ghost", () => {
      const { renderMailHeroTile } = loadInternals();
      const html = renderMailHeroTile(mail({ status: "connected", unreadCount: 0 }));
      expect(html).toContain("tile-value");
      expect(html).toContain(">0<");
      expect(html).not.toContain("ghost-block");
    });

    it("mail total tile: totalCount 0 renders the numeral 0, not a ghost", () => {
      const { renderMailTotalTile } = loadInternals();
      const html = renderMailTotalTile(mail({ status: "connected", totalCount: 0 }));
      expect(html).toContain(">0<");
      expect(html).not.toContain("ghost-block");
    });

    it("mail panel: totalCount 0 shows the 'No messages.' empty state, not a ghost, and the panel header still renders", () => {
      const { renderMailPanelInner } = loadInternals();
      const html = renderMailPanelInner({ content: { mail: mail({ status: "connected", totalCount: 0, unreadCount: 0 }) } });
      expect(html).toContain("No messages.");
      expect(html).not.toContain("ghost-block");
      expect(html).toContain("Mail</h3>");
    });

    it("azure tile: monthToDateCost of exactly 0 is a real value (not the null-sentinel em dash)", () => {
      const { renderAzureTile } = loadInternals();
      const html = renderAzureTile(azure({ status: "connected", monthToDateCost: 0 }));
      expect(html).toContain("0.00 USD");
      expect(html).not.toContain("—");
    });
  });

  describe("stale keeps the figure at full weight, warns only on the freshness line", () => {
    it("freshnessLine renders the warning class + wording only for stale, not for connected", () => {
      const { freshnessLine } = loadInternals();
      const staleHtml = freshnessLine({ status: "stale", lastSyncedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() });
      expect(staleHtml).toContain("freshness-stale");
      expect(staleHtml).toContain("may be out of date");
      const okHtml = freshnessLine({ status: "connected", lastSyncedAt: new Date().toISOString() });
      expect(okHtml).not.toContain("freshness-stale");
    });

    it("mail hero tile: stale still renders the real unread number, not dimmed, not ghosted", () => {
      const { renderMailHeroTile } = loadInternals();
      const html = renderMailHeroTile(mail({ status: "stale", unreadCount: 7 }));
      expect(html).toContain(">7<");
      expect(html).not.toContain("metric-dim");
      expect(html).not.toContain("ghost-block");
    });
  });

  describe("error dims the figure and adds a banner — distinct from both stale and not_configured", () => {
    it("mail hero tile: error dims the value and shows the sync-failed banner", () => {
      const { renderMailHeroTile } = loadInternals();
      const html = renderMailHeroTile(mail({ status: "error", unreadCount: 5 }));
      expect(html).toContain("metric-dim");
      expect(html).toContain("content-error-banner");
      expect(html).toContain("Sync failed");
      expect(html).not.toContain("ghost-block");
    });

    it("azure tile: error dims the value and shows the sync-failed banner", () => {
      const { renderAzureTile } = loadInternals();
      const html = renderAzureTile(azure({ status: "error" }));
      expect(html).toContain("metric-dim");
      expect(html).toContain("Sync failed");
    });
  });

  describe("worstCredentialStatus / credential rollup", () => {
    it("returns null for an empty list rather than throwing or returning 'valid'", () => {
      const { worstCredentialStatus } = loadInternals();
      expect(worstCredentialStatus([])).toBeNull();
    });

    it("trusts the already-sorted-worst-first order from readModel.ts (first element wins)", () => {
      const { worstCredentialStatus } = loadInternals();
      expect(worstCredentialStatus([{ status: "expired" }, { status: "valid" }])).toBe("expired");
    });
  });

  describe("shouldAutoExpand — the health band's escalation rule", () => {
    const healthy = { awaitingFirstReport: false, credentialStatus: [{ status: "valid" }], moduleHealth: [{ status: "healthy" }], errorCounts: { fatal24h: 0 } };

    it("does not auto-expand when everything is healthy", () => {
      const { shouldAutoExpand } = loadInternals();
      expect(shouldAutoExpand(healthy)).toBe(false);
    });

    it("auto-expands when the domain has never reported (awaitingFirstReport) — a never-reported domain must NOT look like it's merely stale", () => {
      const { shouldAutoExpand } = loadInternals();
      expect(shouldAutoExpand({ ...healthy, awaitingFirstReport: true })).toBe(true);
    });

    it("auto-expands on a non-valid credential", () => {
      const { shouldAutoExpand } = loadInternals();
      expect(shouldAutoExpand({ ...healthy, credentialStatus: [{ status: "expiring_soon" }] })).toBe(true);
    });

    it("auto-expands on a crashed/degraded module", () => {
      const { shouldAutoExpand } = loadInternals();
      expect(shouldAutoExpand({ ...healthy, moduleHealth: [{ status: "crashed" }] })).toBe(true);
    });

    it("auto-expands on any fatal error in the last 24h", () => {
      const { shouldAutoExpand } = loadInternals();
      expect(shouldAutoExpand({ ...healthy, errorCounts: { fatal24h: 1 } })).toBe(true);
    });
  });

  describe("awaitingFirstReport renders as the neutral ghost chip, never the red 'stale' badge (Phase-1 bug the Designer/ui-designer required fixing)", () => {
    it("renderHealthBandChips shows the 'ghost' chip kind, not 'warn', when a domain has never reported", () => {
      const { renderHealthBandChips } = loadInternals();
      const html = renderHealthBandChips({
        awaitingFirstReport: true,
        stale: true, // readModel.ts sets both true simultaneously for a never-reported domain — the UI must still pick the ghost treatment
        moduleHealth: [],
        credentialStatus: [],
        errorCounts: { fatal24h: 0 },
        totalPending: 0,
      });
      expect(html).toContain("chip-ghost");
      expect(html).toContain("awaiting first report");
      expect(html).not.toContain("chip-warn");
    });

    it("renderHealthBandBody shows the ghost block, not the module/credential tables, when awaiting first report", () => {
      const { renderHealthBandBody } = loadInternals();
      const html = renderHealthBandBody({ awaitingFirstReport: true, stale: true, moduleHealth: [], credentialStatus: [], errorCounts: { fatal24h: 0 }, approvals: [], totalPending: 0 });
      expect(html).toContain("ghost-block");
      expect(html).toContain("Awaiting first report");
      expect(html).not.toContain("Module health");
    });

    it("a domain that went stale AFTER previously reporting (not awaitingFirstReport) gets the warn chip, correctly distinct from never-reported", () => {
      const { renderHealthBandChips } = loadInternals();
      const html = renderHealthBandChips({
        awaitingFirstReport: false,
        stale: true,
        ageMs: 3 * 60 * 60 * 1000,
        moduleHealth: [{ status: "healthy" }],
        credentialStatus: [{ status: "valid" }],
        errorCounts: { fatal24h: 0 },
        totalPending: 0,
      });
      expect(html).toContain("chip-warn");
      expect(html).toContain("stale");
      expect(html).not.toContain("chip-ghost");
    });
  });

  describe("azure cost panel absence vs. not_configured — must not look alike (Designer's non-applicable rule)", () => {
    it("renderCostPanelInner on a null azureCost (personal domain) still renders the not_configured ghost when called directly", () => {
      // Note: the caller (renderPanelGrid) is responsible for not calling this
      // at all on the personal domain — that's the real "not applicable"
      // behavior and lives in DOM-touching code this harness doesn't exercise.
      // This test just confirms the inner function's own null-handling is the
      // ghost treatment, consistent with every other not_configured case.
      const { renderCostPanelInner } = loadInternals();
      const html = renderCostPanelInner({ content: { azureCost: null } });
      expect(html).toContain("ghost-block");
    });
  });
});
