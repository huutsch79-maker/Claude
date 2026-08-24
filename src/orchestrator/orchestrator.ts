import Anthropic from "@anthropic-ai/sdk";
import { JarvisInstance } from "../domain/JarvisInstance.js";
import { OperationalBus } from "./operationalBus.js";
import { Scheduler } from "./scheduler.js";
import type { ErrorLogCounts } from "../core/reviewer.js";

const REVIEWER_INTERVAL_MS = Number(process.env.JARVIS_REVIEWER_INTERVAL_MS ?? 30 * 60 * 1000); // 30 min default
const HEALTH_REPORT_INTERVAL_MS = Number(process.env.JARVIS_HEALTH_INTERVAL_MS ?? 5 * 60 * 1000); // 5 min default

/** Owns the single JarvisInstance and its scheduled reviewer/health cycles. */
export class Orchestrator {
  readonly bus = new OperationalBus();
  readonly jarvis: JarvisInstance;
  private readonly scheduler = new Scheduler();

  constructor() {
    const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : undefined;
    if (!anthropic) {
      console.warn("[chat] ANTHROPIC_API_KEY not set — chat is disabled until it's configured.");
    }
    this.jarvis = new JarvisInstance({ anthropic });
  }

  startScheduledCycles(getErrorLog: () => ErrorLogCounts = () => ({ transient24h: 0, fatal24h: 0 })): void {
    this.scheduler.every(
      REVIEWER_INTERVAL_MS,
      async () => {
        const proposals = await this.jarvis.reviewer.runCycle(getErrorLog());
        if (proposals.length > 0) {
          console.log(`reviewer produced ${proposals.length} proposal(s)`);
        }
      },
      (err) => console.error("reviewer cycle failed", err),
    );

    this.scheduler.every(
      HEALTH_REPORT_INTERVAL_MS,
      async () => {
        const metadata = await this.jarvis.reportHealth(getErrorLog());
        this.bus.publish(metadata);
      },
      (err) => console.error("health report failed", err),
    );
  }

  async shutdown(): Promise<void> {
    this.scheduler.stopAll();
    await this.jarvis.close();
  }
}
