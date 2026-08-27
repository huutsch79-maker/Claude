import type { DomainConfig } from "../config/domains.js";

export interface ApprovalRequest {
  domain: string;
  summary: string; // operational description only — no domain content
  kind: string;
  proposedAt: string; // ISO timestamp
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
  constructor(private readonly config: DomainConfig, private readonly env: NodeJS.ProcessEnv = process.env) {}

  async notify(request: ApprovalRequest): Promise<void> {
    const token = this.env[`${this.config.credentialEnvPrefix}PUSHOVER_TOKEN`];
    const user = this.env[`${this.config.credentialEnvPrefix}PUSHOVER_USER`];
    if (!token || !user) {
      console.log(`[${this.config.id}] (pushover not configured) approval needed: ${request.kind} — ${request.summary}`);
      return;
    }
    await fetch("https://api.pushover.net/1/messages.json", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token,
        user,
        title: `JARVIS approval needed: ${this.config.label}`,
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
 */
export class ApprovalGate {
  private readonly pending = new Map<string, ApprovalRequest>();

  constructor(private readonly notifier: ApprovalNotifier) {}

  async propose(id: string, request: Omit<ApprovalRequest, "proposedAt">): Promise<void> {
    const fullRequest: ApprovalRequest = { ...request, proposedAt: new Date().toISOString() };
    this.pending.set(id, fullRequest);
    await this.notifier.notify(fullRequest);
  }

  approve(id: string): ApprovalRequest | null {
    const request = this.pending.get(id);
    if (!request) return null;
    this.pending.delete(id);
    return request;
  }

  reject(id: string): void {
    this.pending.delete(id);
  }

  listPending(): ReadonlyMap<string, ApprovalRequest> {
    return this.pending;
  }
}
