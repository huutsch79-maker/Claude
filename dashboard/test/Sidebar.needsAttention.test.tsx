import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { NeedsAttentionSection } from "../src/components/Sidebar";
import { ToastProvider } from "../src/toast";
import type { Proposal, ScriptRun } from "../src/types";

// This is the highest-blast-radius logic in Sidebar.tsx: it merges pending
// reviewer proposals and pending script runs into one list, then dispatches
// Approve/Reject clicks to the proposals API or the scripts API depending
// on item.kind. A future edit that swaps which id/kind goes to which
// handler would silently approve/reject the wrong thing — these tests
// exist to catch exactly that.

const apiMock = vi.fn(async (..._args: unknown[]) => ({ ok: true }));

vi.mock("../src/api", () => ({
  api: (...args: unknown[]) => apiMock(...args),
  getToken: () => "test-token",
  setToken: () => {},
  ApiError: class ApiError extends Error {},
}));

function fakeSidebarData(proposals: Proposal[], scriptRuns: ScriptRun[]) {
  return {
    health: null,
    proposals,
    scripts: [],
    scriptRuns,
    capabilities: [],
    refresh: vi.fn(),
  };
}

beforeEach(() => {
  apiMock.mockClear();
});

const PROPOSAL: Proposal = { id: "prop-1", summary: "Clean up dupes", category: "memory", status: "pending" };
const SCRIPT_RUN: ScriptRun = { id: "run-1", scriptName: "vacuum-analyze", detail: "awaiting approval", status: "pending_approval" };

describe("NeedsAttentionSection", () => {
  it("renders nothing when there is nothing pending", () => {
    const { container } = render(
      <ToastProvider>
        <NeedsAttentionSection data={fakeSidebarData([], [])} refresh={vi.fn()} />
      </ToastProvider>,
    );
    expect(container.querySelector(".section")).toBeNull();
  });

  it("a proposal item's Ack button calls the proposals API with the proposal's id, not the script's", async () => {
    render(
      <ToastProvider>
        <NeedsAttentionSection data={fakeSidebarData([PROPOSAL], [SCRIPT_RUN])} refresh={vi.fn()} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("Ack"));
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    expect(apiMock).toHaveBeenCalledWith("/api/proposals/prop-1/approve", { method: "POST" });
  });

  it("a proposal item's Dismiss button calls the proposals API's reject route with the proposal's id", async () => {
    render(
      <ToastProvider>
        <NeedsAttentionSection data={fakeSidebarData([PROPOSAL], [SCRIPT_RUN])} refresh={vi.fn()} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("Dismiss"));
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    expect(apiMock).toHaveBeenCalledWith("/api/proposals/prop-1/reject", { method: "POST" });
  });

  it("a script item's Approve button calls the scripts API with the script run's id, not the proposal's", async () => {
    render(
      <ToastProvider>
        <NeedsAttentionSection data={fakeSidebarData([PROPOSAL], [SCRIPT_RUN])} refresh={vi.fn()} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("Approve"));
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    expect(apiMock).toHaveBeenCalledWith("/api/scripts/run-1/approve", { method: "POST" });
  });

  it("a script item's Reject button calls the scripts API's reject route with the script run's id", async () => {
    render(
      <ToastProvider>
        <NeedsAttentionSection data={fakeSidebarData([PROPOSAL], [SCRIPT_RUN])} refresh={vi.fn()} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("Reject"));
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    expect(apiMock).toHaveBeenCalledWith("/api/scripts/run-1/reject", { method: "POST" });
  });

  it("calls refresh() after a successful action", async () => {
    const refresh = vi.fn();
    render(
      <ToastProvider>
        <NeedsAttentionSection data={fakeSidebarData([PROPOSAL], [])} refresh={refresh} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("Ack"));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("only pending_approval script runs are included, not applied/failed/rejected ones", () => {
    const otherRun: ScriptRun = { id: "run-2", scriptName: "apply-migration", status: "applied" };
    render(
      <ToastProvider>
        <NeedsAttentionSection data={fakeSidebarData([], [otherRun])} refresh={vi.fn()} />
      </ToastProvider>,
    );
    expect(screen.queryByText("apply-migration")).toBeNull();
  });
});
