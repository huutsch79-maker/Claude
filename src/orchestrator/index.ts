import { DomainManager } from "./domainManager.js";

async function main(): Promise<void> {
  const manager = new DomainManager();

  manager.bus.onPublish((metadata) => {
    console.log(`[health] ${metadata.domain} @ ${metadata.reportedAt}: ` +
      `${metadata.moduleHealth.length} module(s) tracked, ` +
      `${metadata.errorCounts.fatal24h} fatal / ${metadata.errorCounts.transient24h} transient errors (24h)`);
  });

  manager.startScheduledCycles();
  console.log("JARVIS v2 orchestrator running (work + personal domains isolated).");

  const shutdown = async (signal: string) => {
    console.log(`received ${signal}, shutting down...`);
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
