import { DOMAINS, type DomainId } from "../config/domains.js";
import { DomainInstance } from "../domain/Domain.js";
import { OperationalBus } from "./operationalBus.js";
import { Scheduler } from "./scheduler.js";
import type { ErrorLogCounts } from "../core/reviewer.js";

const REVIEWER_INTERVAL_MS = Number(process.env.JARVIS_REVIEWER_INTERVAL_MS ?? 30 * 60 * 1000); // 30 min default
const HEALTH_REPORT_INTERVAL_MS = Number(process.env.JARVIS_HEALTH_INTERVAL_MS ?? 5 * 60 * 1000); // 5 min default

/**
 * Owns one DomainInstance per configured domain and the single shared
 * OperationalBus. This is the only place both domains are reachable from
 * the same scope — and even here, all it does is construct them and read
 * their `reportHealth()` output. Nothing here ever reads `.memory` or
 * `.credentials` across domains.
 */
export class DomainManager {
  readonly bus = new OperationalBus();
  private readonly domains = new Map<DomainId, DomainInstance>();
  private readonly scheduler = new Scheduler();

  constructor() {
    for (const config of Object.values(DOMAINS)) {
      this.domains.set(config.id, new DomainInstance(config));
    }
  }

  get(domainId: DomainId): DomainInstance {
    const domain = this.domains.get(domainId);
    if (!domain) throw new Error(`unknown domain "${domainId}"`);
    return domain;
  }

  startScheduledCycles(getErrorLog: (domainId: DomainId) => ErrorLogCounts = () => ({ transient24h: 0, fatal24h: 0 })): void {
    for (const domain of this.domains.values()) {
      this.scheduler.every(
        REVIEWER_INTERVAL_MS,
        async () => {
          const proposals = await domain.reviewer.runCycle(getErrorLog(domain.config.id));
          if (proposals.length > 0) {
            console.log(`[${domain.config.id}] reviewer produced ${proposals.length} proposal(s)`);
          }
        },
        (err) => console.error(`[${domain.config.id}] reviewer cycle failed`, err),
      );

      this.scheduler.every(
        HEALTH_REPORT_INTERVAL_MS,
        async () => {
          const metadata = await domain.reportHealth(getErrorLog(domain.config.id));
          this.bus.publish(metadata);
        },
        (err) => console.error(`[${domain.config.id}] health report failed`, err),
        { immediate: true },
      );
    }
  }

  async shutdown(): Promise<void> {
    this.scheduler.stopAll();
    await Promise.all(Array.from(this.domains.values()).map((d) => d.close()));
  }
}
