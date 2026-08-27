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

  const shutdown = async (signal: string) => {
    console.log(`received ${signal}, shutting down...`);
    if (dashboardServer) {
      await new Promise<void>((resolve, reject) => {
        dashboardServer!.close((err) => (err ? reject(err) : resolve()));
      });
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
