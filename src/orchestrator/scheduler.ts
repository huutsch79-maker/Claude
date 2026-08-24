/** Minimal interval-based scheduler used by the orchestrator's reviewer/health cycles. */
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
