import type pg from "pg";
import type { DomainConfig } from "../config/domains.js";

export interface CapabilityRow {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  schemaDef: Record<string, unknown>;
  systemPrompt: string | null;
  toolConfig: Record<string, unknown>;
  modelOverride: string | null;
  credentialRef: string | null;
  modulePath: string;
}

export interface CapabilityContext {
  /** The credential this capability's registry row points to, resolved just-in-time. Never a raw domain object. */
  credential: { ref: string; value: string; expiresAt: string | null } | null;
}

export interface CapabilityModule {
  /** Whether this capability can handle the request; used for conflict resolution. */
  canHandle(request: unknown): boolean | Promise<boolean>;
  handle(request: unknown, ctx: CapabilityContext): unknown | Promise<unknown>;
}

export type ConflictResolution =
  | { kind: "resolved"; capability: CapabilityRow }
  | { kind: "ask_user"; tied: CapabilityRow[] };

/**
 * Per-domain registry of dynamic modules. Adding/removing a module is a row
 * insert/delete here, never a code change — see CLAUDE.md's two-tier
 * architecture. Removing a row does not touch that domain's memory, since
 * memory is not owned per-module.
 */
export class CapabilityRegistry {
  private readonly table: string;

  constructor(private readonly config: DomainConfig, private readonly pool: pg.Pool) {
    this.table = `${this.config.schema}.capabilities`;
  }

  async list(opts: { enabledOnly?: boolean } = {}): Promise<CapabilityRow[]> {
    const where = opts.enabledOnly ? "where enabled = true" : "";
    const result = await this.pool.query(`select * from ${this.table} ${where} order by priority desc`);
    return result.rows.map(rowToCapability);
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    await this.pool.query(`update ${this.table} set enabled = $2, updated_at = now() where name = $1`, [name, enabled]);
  }

  /**
   * Conflict resolution when multiple enabled capabilities could both
   * handle a request: highest `priority` wins. A tie is NOT broken
   * arbitrarily — it's surfaced as `ask_user`, per the resolved answer to
   * the spec's open "conflict resolution rule" question (see
   * docs/architecture.md).
   */
  resolve(candidates: CapabilityRow[]): ConflictResolution | null {
    if (candidates.length === 0) return null;
    const maxPriority = Math.max(...candidates.map((c) => c.priority));
    const top = candidates.filter((c) => c.priority === maxPriority);
    if (top.length === 1) return { kind: "resolved", capability: top[0]! };
    return { kind: "ask_user", tied: top };
  }

  async loadModule(row: CapabilityRow): Promise<CapabilityModule> {
    const mod = (await import(row.modulePath)) as { default?: CapabilityModule } & Partial<CapabilityModule>;
    const impl = mod.default ?? mod;
    if (!impl || typeof impl.handle !== "function" || typeof impl.canHandle !== "function") {
      throw new Error(`[${this.config.id}] module ${row.modulePath} does not implement CapabilityModule`);
    }
    return impl as CapabilityModule;
  }
}

function rowToCapability(row: Record<string, unknown>): CapabilityRow {
  return {
    id: row.id as string,
    name: row.name as string,
    enabled: row.enabled as boolean,
    priority: row.priority as number,
    schemaDef: (row.schema_def as Record<string, unknown>) ?? {},
    systemPrompt: (row.system_prompt as string | null) ?? null,
    toolConfig: (row.tool_config as Record<string, unknown>) ?? {},
    modelOverride: (row.model_override as string | null) ?? null,
    credentialRef: (row.credential_ref as string | null) ?? null,
    modulePath: row.module_path as string,
  };
}
