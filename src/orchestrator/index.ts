import { Orchestrator } from "./orchestrator.js";
import { createDashboardServer } from "./dashboard.js";

const DASHBOARD_PORT = Number(process.env.JARVIS_DASHBOARD_PORT ?? 4570);
// 0.0.0.0 by default so the container-published port actually works (see
// docker-compose.yml) — binding to 127.0.0.1 inside a container makes it
// unreachable even from the host's own loopback via Docker's port mapping.
// Set JARVIS_DASHBOARD_HOST=127.0.0.1 to restrict to same-machine access
// when running outside Docker. Either way, set JARVIS_DASHBOARD_TOKEN —
// this default is about connectivity, not about skipping auth.
const DASHBOARD_HOST = process.env.JARVIS_DASHBOARD_HOST ?? "0.0.0.0";

async function main(): Promise<void> {
  const orchestrator = new Orchestrator();

  orchestrator.bus.onPublish((metadata) => {
    console.log(`[health] @ ${metadata.reportedAt}: ` +
      `${metadata.moduleHealth.length} module(s) tracked, ` +
      `${metadata.errorCounts.fatal24h} fatal / ${metadata.errorCounts.transient24h} transient errors (24h)`);
  });

  orchestrator.startScheduledCycles();

  const dashboard = createDashboardServer(orchestrator);
  dashboard.listen(DASHBOARD_PORT, DASHBOARD_HOST, () => {
    console.log(`[dashboard] listening on http://${DASHBOARD_HOST}:${DASHBOARD_PORT}`);
  });

  console.log("JARVIS v2 orchestrator running.");

  const shutdown = async (signal: string) => {
    console.log(`received ${signal}, shutting down...`);
    dashboard.close();
    await orchestrator.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("orchestrator failed to start", err);
  process.exit(1);
});
