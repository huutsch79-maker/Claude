import { DOMAINS, type DomainId } from "../config/domains.js";
import { DomainManager } from "./domainManager.js";
import { createDashboardSource } from "./dashboardSource.js";
import { createDashboardServer, closeServer } from "../dashboard/server.js";
import { AnthropicChatBackend, NotConfiguredChatBackend, type ChatBackend } from "../dashboard/chat.js";
import { createShutdown, registerShutdownSignals } from "./shutdown.js";

const HEALTH_REPORT_INTERVAL_MS = Number(process.env.JARVIS_HEALTH_INTERVAL_MS ?? 5 * 60 * 1000); // 5 min default, matches domainManager.ts
const CONTENT_REPORT_INTERVAL_MS = Number(process.env.JARVIS_CONTENT_INTERVAL_MS ?? 15 * 60 * 1000); // 15 min default, matches domainManager.ts
const DASHBOARD_HOST = process.env.JARVIS_DASHBOARD_HOST ?? "127.0.0.1";
const DASHBOARD_PORT = Number(process.env.JARVIS_DASHBOARD_PORT ?? 7317);
const DASHBOARD_ENABLED = process.env.JARVIS_DASHBOARD_ENABLED !== "false";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";

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
    const domainLabels: Record<DomainId, string> = Object.fromEntries(
      Object.values(DOMAINS).map((c) => [c.id, c.label]),
    ) as Record<DomainId, string>;
    const chatBackend: ChatBackend = ANTHROPIC_API_KEY
      ? new AnthropicChatBackend(
          ANTHROPIC_API_KEY,
          (domainId) => dashboardSource.contentSnapshot().get(domainId) ?? null,
          (domainId) => domainLabels[domainId],
        )
      : new NotConfiguredChatBackend();
    dashboardServer = createDashboardServer(dashboardSource, {
      healthIntervalMs: HEALTH_REPORT_INTERVAL_MS,
      contentIntervalMs: CONTENT_REPORT_INTERVAL_MS,
      chatBackend,
    });
    await new Promise<void>((resolve) => dashboardServer!.listen(DASHBOARD_PORT, DASHBOARD_HOST, resolve));
    console.log(`JARVIS dashboard listening on http://${DASHBOARD_HOST}:${DASHBOARD_PORT}`);
    if (!ANTHROPIC_API_KEY) {
      console.log("[chat] ANTHROPIC_API_KEY not set — chat requests will fail until it is configured.");
    }
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
