import { describe, expect, it, vi } from "vitest";
import { ApprovalGate, type ApprovalNotifier, type ApprovalRequest } from "../src/core/approvalGate.js";

function fakeNotifier(): ApprovalNotifier & { calls: ApprovalRequest[] } {
  const calls: ApprovalRequest[] = [];
  return {
    calls,
    notify: vi.fn(async (r: ApprovalRequest) => {
      calls.push(r);
    }),
  };
}

describe("ApprovalGate", () => {
  it("reject reports whether a pending proposal actually existed", async () => {
    const gate = new ApprovalGate(fakeNotifier());
    await gate.propose("id-1", { summary: "test", kind: "run_script" });

    expect(gate.reject("id-1")).toBe(true); // regression: used to always return false
    expect(gate.reject("id-1")).toBe(false); // already gone, second reject is a no-op
    expect(gate.reject("never-existed")).toBe(false);
  });

  it("approve returns the request once, then null on re-approval", async () => {
    const gate = new ApprovalGate(fakeNotifier());
    await gate.propose("id-2", { summary: "test", kind: "run_script" });

    expect(gate.approve("id-2")?.kind).toBe("run_script");
    expect(gate.approve("id-2")).toBeNull();
  });

  it("propose notifies exactly once per proposal", async () => {
    const notifier = fakeNotifier();
    const gate = new ApprovalGate(notifier);
    await gate.propose("id-3", { summary: "test", kind: "run_script" });
    expect(notifier.calls).toHaveLength(1);
  });
});
