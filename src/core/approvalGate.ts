export interface ApprovalRequest {
  summary: string; // operational description only
  kind: string;
  /** Present only for kind === "run_script" — what to actually execute once approved. */
  scriptName?: string;
  scriptArgs?: Readonly<Record<string, string>>;
}

/**
 * Propose-then-approve flow for anything in the REQUIRES_APPROVAL trust
 * tier. Pushover is the notification channel named in CLAUDE.md; this is a
 * thin stub that no-ops (just logs) when JARVIS_PUSHOVER_* isn't
 * configured, so the system runs without it during initial build.
 */
export interface ApprovalNotifier {
  notify(request: ApprovalRequest): Promise<void>;
}

export class PushoverApprovalNotifier implements ApprovalNotifier {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async notify(request: ApprovalRequest): Promise<void> {
    const token = this.env.JARVIS_PUSHOVER_TOKEN;
    const user = this.env.JARVIS_PUSHOVER_USER;
    if (!token || !user) {
      console.log(`(pushover not configured) approval needed: ${request.kind} — ${request.summary}`);
      return;
    }
    await fetch("https://api.pushover.net/1/messages.json", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token,
        user,
        title: "JARVIS approval needed",
        message: `${request.kind}: ${request.summary}`,
      }),
    });
  }
}

/**
 * Records that a proposal is pending approval. The actual apply step lives
 * with the caller (SelfHeal) — this gate only tracks state and notifies;
 * it never applies anything itself, so "requires approval" can never be
 * silently bypassed by a bug in the gate.
 *
 * Known v1 limitation: pending approvals live only in this process's
 * memory, not in the database. An orchestrator restart loses the ability
 * to approve anything proposed before the restart (jarvis.script_runs
 * still shows it as "pending_approval" for visibility, but re-approving
 * it would need re-proposing). Acceptable for a single self-hosted
 * instance; would need a durable queue before this ever runs as more than
 * one process.
 */
export class ApprovalGate {
  private readonly pending = new Map<string, ApprovalRequest>();

  constructor(private readonly notifier: ApprovalNotifier) {}

  async propose(id: string, request: ApprovalRequest): Promise<void> {
    this.pending.set(id, request);
    await this.notifier.notify(request);
  }

  approve(id: string): ApprovalRequest | null {
    const request = this.pending.get(id);
    if (!request) return null;
    this.pending.delete(id);
    return request;
  }

  reject(id: string): boolean {
    return this.pending.delete(id);
  }

  listPending(): ReadonlyMap<string, ApprovalRequest> {
    return this.pending;
  }
}
