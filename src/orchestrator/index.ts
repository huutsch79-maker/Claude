import { DomainManager } from "./domainManager.js";
import { createDashboardSource } from "./dashboardSource.js";
import { createDashboardServer, closeServer } from "../dashboard/server.js";
import { createShutdown, registerShutdownSignals } from "./shutdown.js";

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

  const shutdown = createShutdown({
    closeDashboard: dashboardServer ? () => closeServer(dashboardServer!) : undefined,
    shutdownManager: () => manager.shutdown(),
    exit: (code) => process.exit(code),
    log: (msg) => console.log(msg),
    logError: (msg, err) => console.error(msg, err),
  });
  registerShutdownSignals(shutdown);
}

main().catch((err) => {
  console.error("orchestrator failed to start", err);
  process.exit(1);
});
