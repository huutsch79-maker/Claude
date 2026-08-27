import { describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/preact";
import { App } from "../src/App";
import { ToastProvider } from "../src/toast";

// Proves the whole pipeline works end to end (Preact + JSX + jsdom +
// testing-library, all wired through vitest) before any real coverage is
// written on top of it. `api()` is mocked so the test never hits a real
// network call — App itself, plus the Sidebar's useSidebarData/useInsights
// hooks it renders once connected, all call the same api() on mount, so
// the mock has to return the right shape per path rather than one fixed
// value, or a downstream .map() on a wrong-shaped response would throw.
vi.mock("../src/api", () => ({
  api: vi.fn(async (path: string) => {
    if (path === "/api/health") return { reportedAt: new Date().toISOString(), credentialStatus: [] };
    if (path.startsWith("/api/proposals")) return [];
    if (path === "/api/scripts") return [];
    if (path === "/api/script-runs") return [];
    if (path === "/api/capabilities") return [];
    if (path === "/api/insights") {
      const notConnected = { status: "not_connected" };
      return {
        personalUnread: notConnected,
        workUnread: notConnected,
        azureCost: notConnected,
        credentialHealth: notConnected,
        scriptRunHistory: notConnected,
        usageWaste: notConnected,
      };
    }
    return {};
  }),
  getToken: () => "test-token",
  setToken: () => {},
  ApiError: class ApiError extends Error {},
}));

describe("App", () => {
  it("renders without throwing", async () => {
    const { container } = render(
      <ToastProvider>
        <App />
      </ToastProvider>,
    );
    // App resolves /api/health asynchronously on mount before it decides
    // which screen to show — wait for that to settle rather than asserting
    // on the very first (pre-connect) render.
    await waitFor(() => expect(container.querySelector("#app")).not.toBeNull());
  });
});
