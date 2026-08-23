import type pg from "pg";
import type { DomainConfig } from "../config/domains.js";
import { CredentialStore } from "./credentialStore.js";
import { MemoryStore } from "./memoryStore.js";
import { RelationsStore } from "./relationsStore.js";
import { CapabilityRegistry } from "./capabilityRegistry.js";
import { createDomainPool } from "./db.js";
import { NotConfiguredEmbeddingProvider, type EmbeddingProvider } from "./embeddingProvider.js";
import { Reviewer, type ErrorLogCounts } from "../core/reviewer.js";
import { SelfHeal, type SelfHealHandlers } from "../core/selfHeal.js";
import { SecurityAccess } from "../core/security.js";
import { ApprovalGate, PushoverApprovalNotifier } from "../core/approvalGate.js";
import type { OperationalMetadata } from "../orchestrator/operationalMetadata.js";

/**
 * One fully isolated domain instance: its own credential store, memory,
 * relations, capability registry, Postgres pool/role, and its own
 * instances of the three core modules. Two DomainInstances never share
 * object references — the orchestrator only ever sees what
 * `reportHealth()` returns.
 */
export class DomainInstance {
  readonly credentials: CredentialStore;
  readonly memory: MemoryStore;
  readonly relations: RelationsStore;
  readonly registry: CapabilityRegistry;
  readonly reviewer: Reviewer;
  readonly selfHeal: SelfHeal;
  readonly security: SecurityAccess;

  private readonly pool: pg.Pool;
  private moduleRestartCounts = new Map<string, number>();
  private lastRestartAt = new Map<string, string>();

  constructor(
    readonly config: DomainConfig,
    opts: { embeddingProvider?: EmbeddingProvider; selfHealHandlers?: Partial<SelfHealHandlers> } = {},
  ) {
    this.pool = createDomainPool(config);
    this.credentials = new CredentialStore(config);
    this.memory = new MemoryStore(config, this.pool, opts.embeddingProvider ?? new NotConfiguredEmbeddingProvider());
    this.relations = new RelationsStore(config, this.pool);
    this.registry = new CapabilityRegistry(config, this.pool);
    this.security = new SecurityAccess(config, this.credentials, this.registry);
    this.reviewer = new Reviewer(config, this.pool, this.registry, this.memory, this.security);

    const notifier = new PushoverApprovalNotifier(config);
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
    this.selfHeal = new SelfHeal(config, approvalGate, handlers);
  }

  /** The ONLY thing this domain instance ever hands to the shared orchestrator layer. */
  async reportHealth(errorLog: ErrorLogCounts): Promise<OperationalMetadata> {
    const { statuses } = await this.security.auditCredentials();
    return {
      domain: this.config.id,
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
