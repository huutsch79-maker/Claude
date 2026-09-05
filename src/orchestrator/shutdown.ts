export interface ShutdownDeps {
  closeDashboard?: () => Promise<void>;
  shutdownManager: () => Promise<void>;
  exit: (code: number) => void;
  log?: (message: string) => void;
  logError?: (message: string, err: unknown) => void;
}

/**
 * Builds a shutdown(signal) function that is safe to call directly from a
 * process signal handler with no `.catch` at the call site: it never
 * rejects. Errors from closeDashboard()/shutdownManager() are caught here
 * and turned into exit(1), rather than becoming an unhandled rejection
 * that would crash the process before cleanup runs (that crash was exactly
 * how a duplicate/racing signal used to bypass manager.shutdown()).
 *
 * A second call while a shutdown is already in flight (e.g. SIGINT
 * followed by SIGTERM, or the same signal delivered twice by a process
 * manager) is a no-op rather than a second concurrent shutdown attempt.
 */
export function createShutdown(deps: ShutdownDeps): (signal: string) => Promise<void> {
  let shuttingDown = false;
  return async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
      deps.log?.(`received ${signal} during shutdown, ignoring`);
      return;
    }
    shuttingDown = true;
    deps.log?.(`received ${signal}, shutting down...`);
    try {
      if (deps.closeDashboard) await deps.closeDashboard();
      await deps.shutdownManager();
      deps.exit(0);
    } catch (err) {
      deps.logError?.("shutdown failed", err);
      deps.exit(1);
    }
  };
}

export function registerShutdownSignals(shutdown: (signal: string) => Promise<void>): void {
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
