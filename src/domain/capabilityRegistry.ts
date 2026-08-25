import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

export interface CapabilityRow {
  id: string;
  name: string;
  /** Freeform UI label ('work', 'personal', anything) — grouping only, never an access boundary. */
  category: string | null;
  enabled: boolean;
  priority: number;
  schemaDef: Record<string, unknown>;
  systemPrompt: string | null;
  toolConfig: Record<string, unknown>;
  modelOverride: string | null;
  credentialRef: string | null;
  /**
   * A logical id under src/modules/, e.g. "hotmail" — NOT a filesystem
   * path. Resolved to an actual import path at load time (see loadModule
   * below) because a fixed path can't be correct in both dev (tsx running
   * src/**\/*.ts directly) and the built container (node running
   * dist/src/**\/*.js) — same class of bug fixed in scriptRegistry.ts's
   * migrations path.
   */
  modulePath: string;
}

/** Structurally identical to chat/chatService.ts's ChatAttachment — defined here too, not imported, so this lower-level domain file never depends on the chat layer above it. */
export interface CapabilityAttachment {
  mediaType: string;
  base64Data: string;
  filename?: string;
}

export interface CapabilityContext {
  /** The credential this capability's registry row points to, resolved just-in-time. */
  credential: { ref: string; value: string; expiresAt: string | null } | null;
  /**
   * Whatever files the user attached to the current chat turn — always
   * populated, empty when there were none. Exists so a capability can
   * store an uploaded photo/PDF directly (e.g. the website module writing
   * a replaced photo to its content repo) without the model having to
   * re-emit the raw base64 bytes inside a tool-call argument, which it
   * cannot reliably do for image content it only ever receives as vision
   * input.
   */
  attachments: CapabilityAttachment[];
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
 * Registry of dynamic modules. Adding/removing a module is a row
 * insert/delete here, never a code change — see CLAUDE.md's two-tier
 * architecture. Removing a row does not touch memory, since memory is not
 * owned per-module.
 */
export class CapabilityRegistry {
  private readonly table = "jarvis.capabilities";

  constructor(private readonly pool: pg.Pool) {}

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
    const importPath = resolveModuleImportPath(row.modulePath);
    const mod = (await import(importPath)) as { default?: CapabilityModule } & Partial<CapabilityModule>;
    const impl = mod.default ?? mod;
    if (!impl || typeof impl.handle !== "function" || typeof impl.canHandle !== "function") {
      throw new Error(`module "${row.modulePath}" (${importPath}) does not implement CapabilityModule`);
    }
    return impl as CapabilityModule;
  }
}

// Whether *this* file is itself running compiled (dist/src/domain/...) or
// straight from source (src/domain/... under tsx) tells us which sibling
// tree the capability modules live in right now, in this same process.
const runningCompiled = fileURLToPath(import.meta.url).split(path.sep).includes("dist");

function resolveModuleImportPath(logicalId: string): string {
  if (logicalId.includes("..") || path.isAbsolute(logicalId)) {
    throw new Error(`capability module id "${logicalId}" must be a relative name, not a path`);
  }
  const root = runningCompiled
    ? path.join(process.cwd(), "dist/src/modules")
    : path.join(process.cwd(), "src/modules");
  const ext = runningCompiled ? "js" : "ts";
  return path.join(root, logicalId, `index.${ext}`);
}

function rowToCapability(row: Record<string, unknown>): CapabilityRow {
  return {
    id: row.id as string,
    name: row.name as string,
    category: (row.category as string | null) ?? null,
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
