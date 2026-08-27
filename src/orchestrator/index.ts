import { DomainManager } from "./domainManager.js";
import { createDashboardSource } from "./dashboardSource.js";
import { createDashboardServer } from "../dashboard/server.js";

const HEALTH_REPORT_INTERVAL_MS = Number(process.env.JARVIS_HEALTH_INTERVAL_MS ?? 5 * 60 * 1000); // 5 min default, matches domainManager.ts
const DASHBOARD_HOST = process.env.JARVIS_DASHBOARD_HOST ?? "127.0.0.1";
const DASHBOARD_PORT = Number(process.env.JARVIS_DASHBOARD_PORT ?? 7317);
const DASHBOARD_ENABLED = process.env.JARVIS_DASHBOARD_ENABLED !== "false";

async function main(): Promise<void> {
  const manager = new DomainManager();

  manager.bus.onPublish((metadata) => {
    console.log(`[health] ${metadata.domain} @ ${metadata.reportedAt}: ` +
      `${metadata.moduleHealth.length} module(s) tracked, ` +
      `${metadata.errorCounts.fatal24h} fatal / ${metadata.errorCounts.transient24h} transient errors (24h)`);
  });

  manager.startScheduledCycles();
  console.log("JARVIS v2 orchestrator running (work + personal domains isolated).");

  let dashboardServer: ReturnType<typeof createDashboardServer> | null = null;
  if (DASHBOARD_ENABLED) {
    const dashboardSource = createDashboardSource(manager);
    dashboardServer = createDashboardServer(dashboardSource, { healthIntervalMs: HEALTH_REPORT_INTERVAL_MS });
    await new Promise<void>((resolve) => dashboardServer!.listen(DASHBOARD_PORT, DASHBOARD_HOST, resolve));
    console.log(`JARVIS dashboard listening on http://${DASHBOARD_HOST}:${DASHBOARD_PORT}`);
  }

  // http.Server.close()'s callback does not fire while any connection is
  // still open (idle-keepalive or mid-request) — a single stalled client
  // (flaky network, slow client, slowloris) would otherwise block shutdown
  // forever. Bound it: give in-flight requests a grace period, then force-close
  // any sockets still open so close() can resolve.
  const SHUTDOWN_GRACE_MS = 2000;
  const closeDashboardServer = (server: NonNullable<typeof dashboardServer>): Promise<void> =>
    new Promise((resolve, reject) => {
      const forceTimer = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS);
      server.close((err) => {
        clearTimeout(forceTimer);
        if (err) reject(err);
        else resolve();
      });
    });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    // A second signal (SIGINT then SIGTERM, or the same signal delivered
    // twice by a process manager) must be a no-op, not a second concurrent
    // shutdown — dashboardServer.close() on an already-closed server rejects
    // with ERR_SERVER_NOT_RUNNING, and an unhandled rejection here would
    // crash the process before manager.shutdown() runs.
    if (shuttingDown) {
      console.log(`received ${signal} during shutdown, ignoring`);
      return;
    }
    shuttingDown = true;
    console.log(`received ${signal}, shutting down...`);
    if (dashboardServer) {
      await closeDashboardServer(dashboardServer);
    }
    await manager.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("orchestrator failed to start", err);
  process.exit(1);
});
