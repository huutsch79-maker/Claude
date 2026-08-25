import type pg from "pg";
import { CredentialStore } from "./credentialStore.js";
import { MemoryStore } from "./memoryStore.js";
import { RelationsStore } from "./relationsStore.js";
import { CapabilityRegistry } from "./capabilityRegistry.js";
import { createJarvisPool } from "./db.js";
import { NotConfiguredEmbeddingProvider, type EmbeddingProvider } from "./embeddingProvider.js";
import { Reviewer, type ErrorLogCounts } from "../core/reviewer.js";
import { SelfHeal, type SelfHealHandlers } from "../core/selfHeal.js";
import { SecurityAccess } from "../core/security.js";
import { ApprovalGate, PushoverApprovalNotifier } from "../core/approvalGate.js";
import { CoreOpsStore } from "../core/coreOpsStore.js";
import { createGithubIssueReporter } from "../core/githubIssueReporter.js";
import { OAuthCredentialStore } from "./oauthCredentialStore.js";
import { ChatService, type AnthropicMessagesClient } from "../chat/chatService.js";
import type { OperationalMetadata } from "../orchestrator/operationalMetadata.js";

const DEFAULT_CHAT_MODEL = "claude-opus-5";

/**
 * The single JARVIS instance: credential store, memory, relations,
 * capability registry, Postgres pool/role, and the three core modules,
 * all operating over one unified system. Memory and chat are shared
 * across everything — see docs/architecture.md for why domain isolation
 * was deliberately reversed. What still stays genuinely separate is
 * credentials: each capability resolves its own credential_ref, so using
 * one connector never touches another's secret.
 */
export class JarvisInstance {
  readonly credentials: CredentialStore;
  readonly memory: MemoryStore;
  readonly relations: RelationsStore;
  readonly registry: CapabilityRegistry;
  readonly reviewer: Reviewer;
  readonly selfHeal: SelfHeal;
  readonly security: SecurityAccess;
  readonly ops: CoreOpsStore;
  /** Real interactive OAuth (Hotmail, NZB mail) — see oauthCredentialStore.ts. Exists independent of chat since the dashboard's Connect/callback routes need it whether or not ANTHROPIC_API_KEY is set. */
  readonly oauthCredentials: OAuthCredentialStore;
  /** Null when no Anthropic client was configured (e.g. ANTHROPIC_API_KEY unset) — chat is opt-in, not required to run the rest of JARVIS. */
  readonly chat: ChatService | null;

  private readonly pool: pg.Pool;
  private moduleRestartCounts = new Map<string, number>();
  private lastRestartAt = new Map<string, string>();

  constructor(
    opts: {
      embeddingProvider?: EmbeddingProvider;
      selfHealHandlers?: Partial<SelfHealHandlers>;
      anthropic?: AnthropicMessagesClient;
      chatModel?: string;
    } = {},
  ) {
    this.pool = createJarvisPool();
    this.credentials = new CredentialStore();
    this.memory = new MemoryStore(this.pool, opts.embeddingProvider ?? new NotConfiguredEmbeddingProvider());
    this.relations = new RelationsStore(this.pool);
    this.registry = new CapabilityRegistry(this.pool);
    this.security = new SecurityAccess(this.credentials, this.registry);
    this.ops = new CoreOpsStore(this.pool);
    const githubReporter = createGithubIssueReporter(
      this.credentials.get("github-issues")?.value ?? null,
      process.env.JARVIS_GITHUB_REPO ?? null,
    );
    this.reviewer = new Reviewer(this.pool, this.registry, this.memory, this.security, this.ops, githubReporter);
    this.oauthCredentials = new OAuthCredentialStore(this.pool, process.env.JARVIS_DASHBOARD_PUBLIC_URL ?? "");

    const notifier = new PushoverApprovalNotifier();
    const approvalGate = new ApprovalGate(notifier);
    const handlers: SelfHealHandlers = {
      restartModule: async (moduleName) => {
        this.moduleRestartCounts.set(moduleName, (this.moduleRestartCounts.get(moduleName) ?? 0) + 1);
        this.lastRestartAt.set(moduleName, new Date().toISOString());
        await opts.selfHealHandlers?.restartModule?.(moduleName);
      },
      clearCache: async (scope) => {
        await opts.selfHealHandlers?.clearCache?.(scope);
      },
      cleanupDuplicateMemory: async () => (await opts.selfHealHandlers?.cleanupDuplicateMemory?.()) ?? 0,
    };
    this.selfHeal = new SelfHeal(approvalGate, handlers, this.pool);

    this.chat = opts.anthropic
      ? new ChatService(
          opts.anthropic,
          this.registry,
          this.credentials,
          this.memory,
          this.relations,
          this.selfHeal,
          this.ops,
          this.oauthCredentials,
          // `||`, not `??`: .env.example ships JARVIS_CHAT_MODEL as an empty
          // line, and dotenv turns that into "" (defined, not nullish), so
          // `??` would silently send Claude an empty model string instead
          // of falling through to the default.
          opts.chatModel || process.env.JARVIS_CHAT_MODEL || DEFAULT_CHAT_MODEL,
        )
      : null;
  }

  /** The only thing this instance hands to the orchestrator's health bus. */
  async reportHealth(errorLog: ErrorLogCounts): Promise<OperationalMetadata> {
    const { statuses } = await this.security.auditCredentials();
    return {
      reportedAt: new Date().toISOString(),
      moduleHealth: Array.from(this.moduleRestartCounts.entries()).map(([moduleId, restartCount24h]) => ({
        moduleId,
        status: "healthy",
        lastRestartAt: this.lastRestartAt.get(moduleId) ?? null,
        restartCount24h,
      })),
      credentialStatus: statuses,
      errorCounts: errorLog,
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
