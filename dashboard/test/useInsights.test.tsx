import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/preact";
import { useInsights } from "../src/useInsights";
import type { Insights } from "../src/types";

const apiMock = vi.fn();

vi.mock("../src/api", () => ({
  api: (...args: unknown[]) => apiMock(...args),
  getToken: () => "test-token",
  setToken: () => {},
  ApiError: class ApiError extends Error {},
}));

function Harness() {
  const { insights, refresh } = useInsights();
  return (
    <div>
      <div data-testid="out">{insights ? JSON.stringify(insights) : "null"}</div>
      <button onClick={() => refresh()}>manual-refresh</button>
    </div>
  );
}

beforeEach(() => {
  apiMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useInsights", () => {
  it("populates insights from a successful GET /api/insights", async () => {
    apiMock.mockResolvedValue({
      personalUnread: { status: "ok", data: { unreadCount: 3, totalCount: 9 } },
    } as unknown as Insights);

    render(<Harness />);

    await waitFor(() => expect(screen.getByTestId("out").textContent).not.toBe("null"));
    expect(screen.getByTestId("out").textContent).toContain('"unreadCount":3');
  });

  // useInsights makes exactly one request (GET /api/insights) — the
  // per-source degrading (a bad Azure call vs. a bad mail call) already
  // happened server-side, each folded into its own {status:"error"} tile
  // inside one JSON body. This hook's own .catch(() => null) just has to
  // not blow away already-rendered data when that single request fails —
  // e.g. a transient network blip on a later poll shouldn't wipe the
  // sidebar back to nothing.
  it("keeps the last-good insights instead of nulling them out when a later refresh rejects", async () => {
    apiMock.mockResolvedValueOnce({
      personalUnread: { status: "ok", data: { unreadCount: 3, totalCount: 9 } },
    } as unknown as Insights);

    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("out").textContent).not.toBe("null"));

    apiMock.mockRejectedValueOnce(new Error("network blip"));
    screen.getByText("manual-refresh").click();

    // Give the rejected refresh a tick to settle, then confirm nothing
    // changed (no throw surfaced, no reset to "null").
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByTestId("out").textContent).toContain('"unreadCount":3');
  });

  it("clears its polling interval on unmount", () => {
    apiMock.mockResolvedValue({} as unknown as Insights);
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");

    const { unmount } = render(<Harness />);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    const intervalId = setIntervalSpy.mock.results[0]!.value;

    unmount();
    expect(clearIntervalSpy).toHaveBeenCalledWith(intervalId);
  });
});
