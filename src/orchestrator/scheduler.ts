/**
 * Minimal interval-based scheduler. Each domain gets its own independent
 * timer (see domainManager.ts) so scheduling one domain's cycle can never
 * block or interleave with another's.
 */
export class Scheduler {
  private readonly timers: NodeJS.Timeout[] = [];

  every(intervalMs: number, task: () => Promise<void>, onError: (err: unknown) => void): void {
    const timer = setInterval(() => {
      task().catch(onError);
    }, intervalMs);
    this.timers.push(timer);
  }

  stopAll(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
  }
}
