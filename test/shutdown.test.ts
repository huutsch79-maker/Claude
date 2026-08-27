import { describe, expect, it, vi } from "vitest";
import { createShutdown } from "../src/orchestrator/shutdown.js";

describe("createShutdown", () => {
  it("runs closeDashboard then shutdownManager then exit(0) on a clean signal", async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const shutdown = createShutdown({
      closeDashboard: async () => {
        order.push("closeDashboard");
      },
      shutdownManager: async () => {
        order.push("shutdownManager");
      },
      exit: (code) => {
        order.push(`exit(${code})`);
        exit(code);
      },
    });

    await shutdown("SIGTERM");

    expect(order).toEqual(["closeDashboard", "shutdownManager", "exit(0)"]);
  });

  it("ignores a second signal received while a shutdown is already in flight (Tester MEDIUM-HIGH #4 repro)", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const shutdownManager = vi.fn(async () => {
      await gate;
    });
    const exit = vi.fn();
    const log = vi.fn();
    const shutdown = createShutdown({ shutdownManager, exit, log });

    const first = shutdown("SIGINT");
    await Promise.resolve(); // let the first call reach the shuttingDown guard
    await shutdown("SIGTERM"); // second signal while first is still in flight

    releaseFirst();
    await first;

    expect(shutdownManager).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("received SIGTERM during shutdown, ignoring"));
  });

  it("never rejects when closeDashboard throws — calls exit(1) instead of crashing the process (Tester MEDIUM-HIGH #4 repro)", async () => {
    const exit = vi.fn();
    const logError = vi.fn();
    const shutdownManager = vi.fn(async () => {
      /* must not be reached before exit(1), but also must not throw if it were */
    });
    const shutdown = createShutdown({
      closeDashboard: async () => {
        throw new Error("ERR_SERVER_NOT_RUNNING");
      },
      shutdownManager,
      exit,
      logError,
    });

    await expect(shutdown("SIGTERM")).resolves.toBeUndefined();
    expect(exit).toHaveBeenCalledWith(1);
    expect(logError).toHaveBeenCalledWith("shutdown failed", expect.any(Error));
  });

  it("never rejects when shutdownManager throws — calls exit(1) instead of crashing the process", async () => {
    const exit = vi.fn();
    const shutdown = createShutdown({
      shutdownManager: async () => {
        throw new Error("pool.end() failed");
      },
      exit,
    });

    await expect(shutdown("SIGINT")).resolves.toBeUndefined();
    expect(exit).toHaveBeenCalledWith(1);
  });
});
