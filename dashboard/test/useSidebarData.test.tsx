import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/preact";
import { useSidebarData } from "../src/useSidebarData";
import type { Capability, HealthReport, ScriptDef, ScriptRun } from "../src/types";

const HEALTH: HealthReport = { reportedAt: "2026-08-26T00:00:00Z", credentialStatus: [] };
const SCRIPTS: ScriptDef[] = [{ name: "vacuum-analyze", description: "d", trustTier: "auto_fix" }];
const RUNS: ScriptRun[] = [{ id: "r1", scriptName: "vacuum-analyze", status: "applied" }];
const CAPS: Capability[] = [
  { name: "hotmail-outlook", category: "personal", enabled: true, priority: 1, credentialRef: null, modelOverride: null, oauthConfigured: false, oauthConnected: false },
];

function apiForPath(path: string): unknown {
  if (path === "/api/health") return HEALTH;
  if (path.startsWith("/api/proposals")) throw new Error("db unreachable");
  if (path === "/api/scripts") return SCRIPTS;
  if (path === "/api/script-runs") return RUNS;
  if (path === "/api/capabilities") return CAPS;
  throw new Error(`unexpected path in test: ${path}`);
}

const apiMock = vi.fn(async (path: string) => apiForPath(path));

vi.mock("../src/api", () => ({
  api: (...args: unknown[]) => apiMock(...(args as [string])),
  getToken: () => "test-token",
  setToken: () => {},
  ApiError: class ApiError extends Error {},
}));

function Harness() {
  const data = useSidebarData();
  return (
    <div>
      <div data-testid="health">{data.health ? "loaded" : "null"}</div>
      <div data-testid="scripts-count">{data.scripts.length}</div>
      <div data-testid="runs-count">{data.scriptRuns.length}</div>
      <div data-testid="caps-count">{data.capabilities.length}</div>
      <div data-testid="proposals-count">{data.proposals.length}</div>
    </div>
  );
}

beforeEach(() => {
  apiMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useSidebarData", () => {
  // /api/proposals is wired to reject in apiForPath above, while the other
  // four sources resolve normally — each of useSidebarData's five api()
  // calls has its own .catch(() => <default>), so one source failing must
  // degrade only that field (proposals falls back to []) without leaving
  // health/scripts/scriptRuns/capabilities unset or throwing out of the hook.
  it("degrades only the failed source (proposals) and still populates the other four", async () => {
    render(<Harness />);

    await waitFor(() => expect(screen.getByTestId("health").textContent).toBe("loaded"));
    expect(screen.getByTestId("scripts-count").textContent).toBe("1");
    expect(screen.getByTestId("runs-count").textContent).toBe("1");
    expect(screen.getByTestId("caps-count").textContent).toBe("1");
    // Failed source degrades to its default (empty array), not left undefined.
    expect(screen.getByTestId("proposals-count").textContent).toBe("0");
  });

  it("clears its polling interval on unmount", async () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");

    const { unmount } = render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("health").textContent).toBe("loaded"));

    // testing-library's own waitFor polls internally via setInterval too,
    // so isolate the hook's REFRESH_MS (30s) interval by its delay rather
    // than assuming it's the only (or the first) call recorded.
    const ownCall = setIntervalSpy.mock.calls.findIndex(([, delay]) => delay === 30000);
    expect(ownCall).toBeGreaterThanOrEqual(0);
    const intervalId = setIntervalSpy.mock.results[ownCall]!.value;

    unmount();
    expect(clearIntervalSpy).toHaveBeenCalledWith(intervalId);
  });
});
