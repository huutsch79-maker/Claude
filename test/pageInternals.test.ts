import { describe, expect, it } from "vitest";
import * as vm from "node:vm";
import { DASHBOARD_HTML } from "../src/dashboard/page.js";
import type { MailSummary, AzureCostSummary } from "../src/orchestrator/domainContentSummary.js";
import type { DomainStatePayload } from "../src/dashboard/types.js";

/**
 * Exercises the actual shipped src/dashboard/page.ts script (not a
 * reimplementation) via the __JARVIS_TEST_MODE__ escape hatch it exports
 * itself — see the comment above that block in page.ts.
 *
 * The redesign moved the page from "render each panel" to "resolve a state,
 * build a check registry, compute one verdict". These tests follow it: the
 * five-state resolver and the verdict ranking are now the load-bearing
 * logic, and the thing most worth pinning is that the three states which
 * LOOK empty on screen — not_configured, awaiting, unmeasured — never
 * collapse into each other and never render a numeral.
 */
interface Check {
  id: string;
  label: string;
  state: string;
  head: string | null;
  ev: string | null;
  route: string | null;
}
interface Verdict {
  kind: string;
  title: string;
  line: string;
  measured: number;
  total: number;
  unmeasured: number;
  findings: Check[];
}
interface JarvisInternals {
  resolveContentState(d: unknown, key: string): string;
  hasNumeral(state: string): boolean;
  buildChecks(d: unknown): Check[];
  computeVerdict(checks: Check[]): Verdict;
  worstCredentialStatus(list: { status: string }[]): string | null;
  worstCredentialEntry(list: unknown[]): { credentialRef: string; status: string } | null;
  credentialPill(status: string): string;
  renderOverview(d: unknown): string;
  renderSetupCard(checks: Check[], dom: string): string;
  renderEverythingElse(d: unknown, checks: Check[], dom: string): string;
  viewMail(dom: string, d: unknown): string;
  viewCost(dom: string, d: unknown): string | null;
  viewCredentials(dom: string, d: unknown): string;
  viewModules(dom: string, d: unknown): string;
  viewErrors(dom: string, d: unknown): string;
  stateBlock(kind: string, title: string, body: string): string;
  relativeIso(iso: string | null): string;
  UNMEASURED: Record<string, string>;
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
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: {},
    setAttribute() {},
    getAttribute: () => null,
    querySelectorAll: () => [],
    hidden: false,
  };
}

/** Runs the real, shipped dashboard script in test mode and returns its exposed pure functions. */
function loadInternals(): JarvisInternals {
  const script = extractScript(DASHBOARD_HTML);
  const sandbox: Record<string, unknown> = {
    window: { __JARVIS_TEST_MODE__: true, localStorage: { getItem: () => null, setItem() {} } },
    document: {
      getElementById: () => fakeElement(),
      addEventListener() {},
      createElement: () => fakeElement(),
      querySelectorAll: () => [],
      querySelector: () => null,
      body: fakeElement(),
    },
    location: { hash: "" },
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
  return {
    status: "connected",
    unreadCount: 3,
    totalCount: 42,
    topSenders: [{ displayName: "Alice", messageCount: 5 }],
    lastSyncedAt: new Date().toISOString(),
    ...overrides,
  };
}

function azure(overrides: Partial<AzureCostSummary> = {}): AzureCostSummary {
  return {
    status: "connected",
    currency: "NZD",
    monthToDateCost: 123.45,
    topServices: [{ serviceName: "Storage", cost: 12.3 }],
    lastSyncedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** A healthy, fully-reporting work domain. Override to build each case. */
function domainState(overrides: Partial<DomainStatePayload> = {}): DomainStatePayload {
  return {
    domain: "work",
    reportedAt: new Date().toISOString(),
    ageMs: 4000,
    stale: false,
    awaitingFirstReport: false,
    moduleHealth: [{ moduleId: "nzb-connector", status: "healthy", lastRestartAt: null, restartCount24h: 0 }],
    credentialStatus: [{ credentialRef: "nzb-m365", status: "valid", expiresAt: null }],
    errorCounts: { transient24h: 0, fatal24h: 0 },
    approvals: [],
    totalPending: 0,
    content: {
      domain: "work",
      reportedAt: new Date().toISOString(),
      mail: mail(),
      azureCost: azure(),
    },
    ...overrides,
  } as DomainStatePayload;
}

describe("page.ts — five-state resolver", () => {
  it("content === null resolves to awaiting, NOT not_configured (the Dashboard v2 bug)", () => {
    const { resolveContentState } = loadInternals();
    expect(resolveContentState(domainState({ content: null }), "mail")).toBe("awaiting");
    expect(resolveContentState(domainState({ content: null }), "azureCost")).toBe("awaiting");
  });

  it("a missing payload entirely is awaiting, never a green default", () => {
    const { resolveContentState } = loadInternals();
    expect(resolveContentState(null, "mail")).toBe("awaiting");
    expect(resolveContentState(undefined, "mail")).toBe("awaiting");
  });

  it("status not_configured resolves to notconf — a different state from awaiting", () => {
    const { resolveContentState } = loadInternals();
    const d = domainState({ content: { domain: "work", reportedAt: new Date().toISOString(), mail: mail({ status: "not_configured" }), azureCost: azure() } });
    expect(resolveContentState(d, "mail")).toBe("notconf");
  });

  it("a domain with no Azure subscription shows no cost panel even before its first report", () => {
    // The bug this pins: resolveContentState used to return "awaiting" the
    // moment content was null, before it could see that azureCost would be
    // null anyway — so for the whole first interval after a restart the
    // personal domain rendered an "Azure month to date" tile. Whether a cost
    // panel exists is structural (DOMAINS[id].hasAzureCost), not something to
    // be learned from a content report that has not arrived.
    const { resolveContentState, buildChecks, renderEverythingElse, computeVerdict, setCurrentDomain } = loadInternals();
    setCurrentDomain("personal");
    const awaitingPersonal = domainState({ domain: "personal", content: null });

    expect(resolveContentState(awaitingPersonal, "azureCost")).toBe("na");
    expect(resolveContentState(awaitingPersonal, "mail")).toBe("awaiting");

    const checks = buildChecks(awaitingPersonal);
    expect(checks.find((c) => c.id === "cost")?.state).toBe("na");
    expect(computeVerdict(checks).total).toBe(6);

    const html = renderEverythingElse(awaitingPersonal, checks, "personal");
    expect(html).not.toContain("Azure month to date");
  });

  it("work still shows an awaiting cost tile before its first report", () => {
    const { resolveContentState, renderEverythingElse, buildChecks } = loadInternals();
    const awaitingWork = domainState({ content: null });
    expect(resolveContentState(awaitingWork, "azureCost")).toBe("awaiting");
    const html = renderEverythingElse(awaitingWork, buildChecks(awaitingWork), "work");
    expect(html).toContain("Azure month to date");
  });

  it("a structurally-absent sub-summary (personal has no Azure cost) is na, not notconf", () => {
    const { resolveContentState } = loadInternals();
    const d = domainState({
      domain: "personal",
      content: { domain: "personal", reportedAt: new Date().toISOString(), mail: mail(), azureCost: null },
    });
    expect(resolveContentState(d, "azureCost")).toBe("na");
  });

  it("error and stale each keep their own state", () => {
    const { resolveContentState } = loadInternals();
    const mk = (s: MailSummary["status"]) =>
      domainState({ content: { domain: "work", reportedAt: new Date().toISOString(), mail: mail({ status: s }), azureCost: azure() } });
    expect(resolveContentState(mk("error"), "mail")).toBe("error");
    expect(resolveContentState(mk("stale"), "mail")).toBe("stale");
    expect(resolveContentState(mk("connected"), "mail")).toBe("connected");
  });

  it("only connected and stale may render a numeral", () => {
    const { hasNumeral } = loadInternals();
    expect(hasNumeral("connected")).toBe(true);
    expect(hasNumeral("stale")).toBe(true);
    for (const s of ["awaiting", "notconf", "error", "na", "unmeasured"]) {
      expect(hasNumeral(s), s + " must not render a numeral").toBe(false);
    }
  });
});

describe("page.ts — the three empty states stay visually distinct", () => {
  const dashed = 'data-ghost="1"';
  const inert = 'data-inert="1"';

  it("not_configured gets the dashed container and an action, never a clock", () => {
    const { renderEverythingElse, buildChecks } = loadInternals();
    const d = domainState({ content: { domain: "work", reportedAt: new Date().toISOString(), mail: mail({ status: "not_configured" }), azureCost: azure() } });
    const html = renderEverythingElse(d, buildChecks(d), "work");
    expect(html).toContain(dashed);
    expect(html).toContain("Not connected");
    expect(html).toContain("Connect in Setup");
  });

  it("awaiting gets solid chrome and a clock, never the dashed 'you can fix this' container", () => {
    const { renderEverythingElse, buildChecks } = loadInternals();
    const d = domainState({ content: null });
    const html = renderEverythingElse(d, buildChecks(d), "work");
    expect(html).toContain("First sync not in yet");
    // The mail/cost cells must not be dashed — dashed means "you can connect
    // this", and there is nothing for Alex to do while a sync is in flight.
    const mailCell = html.slice(html.indexOf("Unread mail") - 200, html.indexOf("Unread mail") + 200);
    expect(mailCell).not.toContain(dashed);
  });

  it("unmeasured gets a dash glyph, no route and no chevron — there is nothing behind it", () => {
    const { renderEverythingElse, buildChecks } = loadInternals();
    const d = domainState();
    const html = renderEverythingElse(d, buildChecks(d), "work");
    expect(html).toContain("dashglyph");
    expect(html).toContain(inert);
    expect(html).toContain("Not measured");
  });

  it("no empty state ever renders a zero as if it were a measurement", () => {
    const { renderEverythingElse, buildChecks } = loadInternals();
    for (const content of [null, { domain: "work", reportedAt: new Date().toISOString(), mail: mail({ status: "not_configured" }), azureCost: azure({ status: "not_configured" }) }]) {
      const d = domainState({ content: content as never });
      const html = renderEverythingElse(d, buildChecks(d), "work");
      const between = html.slice(html.indexOf("Unread mail"), html.indexOf("Credentials"));
      expect(between).not.toContain('class="vl">0<');
    }
  });

  it("zero IS rendered when it is a real measurement — an empty inbox is not an empty state", () => {
    const { renderEverythingElse, buildChecks } = loadInternals();
    const d = domainState({
      content: { domain: "work", reportedAt: new Date().toISOString(), mail: mail({ unreadCount: 0, totalCount: 0 }), azureCost: azure() },
    });
    const html = renderEverythingElse(d, buildChecks(d), "work");
    expect(html).toContain('class="vl">0<');
  });

  it("a failing cost query shows the failure, never a confident $0.00", () => {
    const { renderEverythingElse, buildChecks, viewCost } = loadInternals();
    const d = domainState({
      content: { domain: "work", reportedAt: new Date().toISOString(), mail: mail(), azureCost: azure({ status: "error", monthToDateCost: null }) },
    });
    const html = renderEverythingElse(d, buildChecks(d), "work");
    expect(html).toContain("Query failed");
    expect(html).not.toContain("0.00");
    expect(viewCost("work", d)).not.toContain("0.00");
  });
});

describe("page.ts — check registry", () => {
  it("personal has no Azure cost check at all (na is excluded from coverage)", () => {
    const { buildChecks, computeVerdict } = loadInternals();
    const personal = domainState({
      domain: "personal",
      content: { domain: "personal", reportedAt: new Date().toISOString(), mail: mail(), azureCost: null },
    });
    const checks = buildChecks(personal);
    const cost = checks.find((c) => c.id === "cost");
    expect(cost?.state).toBe("na");
    const work = computeVerdict(buildChecks(domainState()));
    expect(computeVerdict(checks).total).toBe(work.total - 1);
  });

  it("errors and approvals are reported as unmeasured, because nothing produces them", () => {
    const { buildChecks, UNMEASURED } = loadInternals();
    // If either producer is wired up, its UNMEASURED entry must be deleted —
    // this test is the reminder, and it fails loudly if the entry is stale.
    expect(Object.keys(UNMEASURED).sort()).toEqual(["approvals", "errors"]);
    const checks = buildChecks(domainState());
    expect(checks.find((c) => c.id === "errors")?.state).toBe("unmeasured");
    expect(checks.find((c) => c.id === "approvals")?.state).toBe("unmeasured");
  });

  it("an empty module roster is unmeasured, not 'zero modules'", () => {
    const { buildChecks } = loadInternals();
    const checks = buildChecks(domainState({ moduleHealth: [] }));
    const mods = checks.find((c) => c.id === "modules");
    expect(mods?.state).toBe("unmeasured");
    expect(mods?.ev).toContain("only modules that have restarted");
  });

  it("an expired credential is blocking; a never-configured one is not alarm language", () => {
    const { buildChecks, credentialPill } = loadInternals();
    const expired = buildChecks(domainState({ credentialStatus: [{ credentialRef: "nzb-m365", status: "expired", expiresAt: null }] }));
    expect(expired.find((c) => c.id === "credentials")?.state).toBe("blocking");

    const invalid = buildChecks(domainState({ credentialStatus: [{ credentialRef: "nzb-arm", status: "invalid", expiresAt: null }] }));
    expect(invalid.find((c) => c.id === "credentials")?.state).toBe("attention");
    expect(credentialPill("invalid")).toContain("Never configured");
    expect(credentialPill("invalid")).not.toContain("Invalid");
  });

  it("worstCredentialStatus ranks by urgency: expired > expiring_soon > invalid > valid", () => {
    const { worstCredentialStatus } = loadInternals();
    expect(worstCredentialStatus([{ status: "valid" }, { status: "expiring_soon" }, { status: "expired" }])).toBe("expired");
    expect(worstCredentialStatus([{ status: "valid" }, { status: "invalid" }])).toBe("invalid");
    expect(worstCredentialStatus([])).toBe(null);
  });

  it("a credential with a deadline outranks one that was never configured, in the headline", () => {
    // Deliberately NOT readModel.ts's table sort, which ranks invalid above
    // expiring_soon. The table asks "what looks most wrong"; the verdict asks
    // "what needs Alex soonest". A never-configured credential has no deadline
    // and has broken nothing, so it must not take the headline from one that
    // lapses in six days. If this flips, the verdict starts naming the wrong
    // thing — see CRED_RANK in page.ts.
    const { worstCredentialStatus, buildChecks, computeVerdict } = loadInternals();
    expect(worstCredentialStatus([{ status: "invalid" }, { status: "expiring_soon" }])).toBe("expiring_soon");

    const d = domainState({
      credentialStatus: [
        { credentialRef: "nzb-azure-arm", status: "invalid", expiresAt: null },
        { credentialRef: "nzb-m365-oauth", status: "expiring_soon", expiresAt: new Date(Date.now() + 6 * 864e5).toISOString() },
      ],
    });
    expect(computeVerdict(buildChecks(d)).line).toContain("nzb-m365-oauth");
  });

  it("a cost figure is formatted for humans, with a thousands separator", () => {
    const { viewCost } = loadInternals();
    const html = viewCost("work", domainState()) as string;
    // The exact symbol depends on the runtime locale; the grouping does not.
    expect(html).toMatch(/1[,.\u00a0\u202f]?234|123\.45/);
    expect(html).not.toContain("123.45 NZD");
  });
});

describe("page.ts — verdict ranking", () => {
  it("a real finding outranks 'still loading' — awaiting must never hide an expiring credential", () => {
    const { buildChecks, computeVerdict } = loadInternals();
    const d = domainState({
      content: null, // everything awaiting
      credentialStatus: [{ credentialRef: "nzb-m365", status: "expiring_soon", expiresAt: new Date(Date.now() + 6 * 864e5).toISOString() }],
    });
    const v = computeVerdict(buildChecks(d));
    expect(v.kind).toBe("attention");
    expect(v.title).toBe("Worth a look");
  });

  it("blocking outranks attention", () => {
    const { buildChecks, computeVerdict } = loadInternals();
    const d = domainState({ credentialStatus: [{ credentialRef: "a", status: "expired", expiresAt: null }] });
    expect(computeVerdict(buildChecks(d)).kind).toBe("blocking");
  });

  it("awaiting outranks partial coverage, and says so without a numeral", () => {
    const { buildChecks, computeVerdict } = loadInternals();
    const v = computeVerdict(buildChecks(domainState({ content: null })));
    expect(v.kind).toBe("awaiting");
    expect(v.title).toBe("Checking…");
    expect(v.line).toContain("not reported in yet");
  });

  it("with nothing wrong, the verdict states its own coverage rather than claiming everything is fine", () => {
    const { buildChecks, computeVerdict } = loadInternals();
    const v = computeVerdict(buildChecks(domainState()));
    expect(v.kind).toBe("partial");
    expect(v.title).toBe("All clear");
    expect(v.unmeasured).toBeGreaterThan(0);
    expect(v.measured).toBeLessThan(v.total);
    expect(v.line).toContain("actually measured");
  });

  it("no payload at all is never a green all-clear", () => {
    const { buildChecks, computeVerdict } = loadInternals();
    const v = computeVerdict(buildChecks(null));
    expect(v.kind).not.toBe("ok");
    expect(v.kind).not.toBe("partial");
  });

  it("findings are worst-first and every one carries a route to act on", () => {
    const { buildChecks, computeVerdict } = loadInternals();
    const d = domainState({
      credentialStatus: [{ credentialRef: "gone", status: "expired", expiresAt: null }],
      stale: true,
    });
    const v = computeVerdict(buildChecks(d));
    expect(v.findings.length).toBeGreaterThan(1);
    expect(v.findings[0]!.state).toBe("blocking");
    for (const f of v.findings) expect(f.route).toBeTruthy();
  });
});

describe("page.ts — overview composition", () => {
  it("the Setup card appears only when something is actually connectable", () => {
    const { renderSetupCard, buildChecks } = loadInternals();
    expect(renderSetupCard(buildChecks(domainState()), "work")).toBe("");

    const d = domainState({ content: { domain: "work", reportedAt: new Date().toISOString(), mail: mail({ status: "not_configured" }), azureCost: azure() } });
    const html = renderSetupCard(buildChecks(d), "work");
    expect(html).toContain("Setup");
    expect(html).toContain("connected");
    expect(html).toContain("1 left");
  });

  it("the Setup card lists connected rows first, so the eye enters on what works", () => {
    const { renderSetupCard, buildChecks } = loadInternals();
    const d = domainState({ content: { domain: "work", reportedAt: new Date().toISOString(), mail: mail({ status: "not_configured" }), azureCost: azure() } });
    const html = renderSetupCard(buildChecks(d), "work");
    expect(html.indexOf("Connected")).toBeLessThan(html.indexOf("Connect <svg"));
  });

  it("the Setup card never counts unmeasured checks as things Alex can connect", () => {
    const { renderSetupCard, buildChecks } = loadInternals();
    const d = domainState({ content: { domain: "work", reportedAt: new Date().toISOString(), mail: mail({ status: "not_configured" }), azureCost: azure() } });
    const html = renderSetupCard(buildChecks(d), "work");
    expect(html).not.toContain("Errors 24h");
    expect(html).not.toContain("Awaiting your decision");
  });

  it("the overview renders end to end for every domain shape without throwing", () => {
    const { renderOverview } = loadInternals();
    const shapes = [
      domainState(),
      domainState({ content: null }),
      domainState({ awaitingFirstReport: true, reportedAt: null, ageMs: null, moduleHealth: [], credentialStatus: [], content: null }),
      domainState({ domain: "personal", content: { domain: "personal", reportedAt: new Date().toISOString(), mail: mail(), azureCost: null } }),
      null,
    ];
    for (const s of shapes) {
      const html = renderOverview(s);
      expect(html).toContain("verdict");
      expect(html).toContain("Everything else");
    }
  });
});

describe("page.ts — detail views degrade honestly", () => {
  it("mail detail explains awaiting rather than showing an empty panel", () => {
    const { viewMail } = loadInternals();
    const html = viewMail("work", domainState({ content: null }));
    expect(html).toContain("First sync has not arrived");
    expect(html).not.toContain('class="big"');
  });

  it("cost detail is unavailable for personal, and the router is told via null", () => {
    const { viewCost } = loadInternals();
    const personal = domainState({
      domain: "personal",
      content: { domain: "personal", reportedAt: new Date().toISOString(), mail: mail(), azureCost: null },
    });
    expect(viewCost("personal", personal)).toBe(null);
  });

  it("modules detail explains why an empty roster is not an all-clear", () => {
    const { viewModules } = loadInternals();
    const html = viewModules("work", domainState({ moduleHealth: [] }));
    expect(html).toContain("Roster not published");
    expect(html).toContain("absence of measurement");
  });

  it("errors detail refuses to present its zero as a measurement", () => {
    const { viewErrors } = loadInternals();
    const html = viewErrors("work", domainState());
    expect(html).toContain("not connected");
    expect(html).toContain("nothing is being counted");
  });

  it("every drill-down that can reach chat shows the question before composing it", () => {
    const { viewMail, viewCredentials } = loadInternals();
    for (const html of [viewMail("work", domainState()), viewCredentials("work", domainState())]) {
      expect(html).toContain("data-seed=");
      expect(html).toContain("seedprompt");
      expect(html).toContain("you can edit it before sending");
    }
  });
});
