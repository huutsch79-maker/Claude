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
  constructor(
    private readonly config: DomainConfig,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async notify(request: ApprovalRequest): Promise<void> {
    const token = this.env[`${this.config.credentialEnvPrefix}PUSHOVER_TOKEN`];
    const user = this.env[`${this.config.credentialEnvPrefix}PUSHOVER_USER`];
    if (!token || !user) {
      console.log(`[${this.config.id}] (pushover not configured) approval needed: ${request.kind} — ${request.summary}`);
      return;
    }
    const response = await this.fetchImpl("https://api.pushover.net/1/messages.json", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token,
        user,
        title: `JARVIS approval needed: ${this.config.label}`,
        message: `${request.kind}: ${request.summary}`,
      }),
    });

    // fetch does not reject on 4xx/5xx. Without this check a rotated token
    // returns 401 on every approval forever while notify() resolves
    // normally, so the system goes on asserting that a human was paged.
    if (!response.ok) {
      const body = await response.text().catch(() => "<unreadable body>");
      throw new Error(
        `[${this.config.id}] pushover notification failed (${response.status}): ${body.slice(0, 200)}`,
      );
    }
  }
}

/** Why an approval could not be consumed — never collapsed into a bare false. */
export type ApprovalFailure = "unknown_id" | "wrong_domain" | "wrong_kind";

/**
 * Records that a proposal is pending approval. The actual apply step lives
 * with the caller (SelfHeal) — this gate only tracks state and notifies;
 * it never applies anything itself, so "requires approval" can never be
 * silently bypassed by a bug in the gate.
 *
 * NOTE: `pending` is in-memory only, so it does not survive a restart. The
 * schema has `core.reviewer_proposals.status` for exactly this and both
 * domain roles are granted `update` on it; wiring the gate to that column
 * is outstanding work, not a deliberate design choice.
 */
export class ApprovalGate {
  private readonly pending = new Map<string, ApprovalRequest>();

  constructor(private readonly notifier: ApprovalNotifier) {}

  async propose(id: string, request: Omit<ApprovalRequest, "proposedAt">): Promise<void> {
    const fullRequest: ApprovalRequest = { ...request, proposedAt: new Date().toISOString() };
    this.pending.set(id, fullRequest);
    await this.notifier.notify(fullRequest);
  }

  /** Read a pending request without consuming it, so a caller can validate before committing to apply. */
  peek(id: string): ApprovalRequest | null {
    return this.pending.get(id) ?? null;
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
