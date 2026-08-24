import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type pg from "pg";
import type { TrustTier } from "./trustTiers.js";

// Resolved from the process's working directory rather than this file's own
// location: tsc's outDir nests compiled files under dist/src/core/, one
// level deeper than the dev (tsx) layout at src/core/, so __dirname-based
// relative paths point to different places in dev vs. the built container.
// process.cwd() is stable in both — npm scripts and the Dockerfile's
// WORKDIR both run from the repo root. Overridable for anything unusual.
const MIGRATIONS_ROOT = process.env.JARVIS_MIGRATIONS_ROOT ?? path.join(process.cwd(), "db/migrations");

export interface ScriptRunResult {
  detail: string; // short operational summary, never raw content
}

export interface ScriptContext {
  pool: pg.Pool;
  args: Readonly<Record<string, string>>;
}

export interface ScriptDefinition {
  name: string;
  description: string;
  trustTier: TrustTier;
  run: (ctx: ScriptContext) => Promise<ScriptRunResult>;
}

/**
 * The complete, fixed set of scripts JARVIS is allowed to run on its own.
 * This is deliberately NOT a database table — adding a script here is a
 * code change that goes through review, unlike adding a dynamic capability
 * module. Scripts get to touch infrastructure (schema, bulk DB
 * maintenance); that's a meaningfully higher blast radius than a
 * capability module handling one request, so it stays out of the
 * runtime-editable registry on purpose.
 */
export const SCRIPTS: Readonly<Record<string, ScriptDefinition>> = {
  "vacuum-analyze": {
    name: "vacuum-analyze",
    description: "VACUUM ANALYZE the memory, relations, and capabilities tables.",
    trustTier: "auto_fix", // reversible, routine DB maintenance
    run: async (ctx) => {
      for (const table of ["memory", "relations", "capabilities"]) {
        await ctx.pool.query(`vacuum analyze jarvis.${table}`);
      }
      return { detail: "vacuumed memory, relations, capabilities" };
    },
  },

  "apply-migration": {
    name: "apply-migration",
    description:
      "Apply one .sql file from db/migrations/ that hasn't been applied yet. Rejects any filename not already present on disk.",
    trustTier: "requires_approval", // structural/schema change — CLAUDE.md requires approval, no exceptions
    run: async (ctx) => {
      const filename = ctx.args.file;
      if (!filename) throw new Error("apply-migration requires an args.file");
      if (filename.includes("/") || filename.includes("..")) {
        throw new Error(`apply-migration: rejected unsafe filename "${filename}"`);
      }

      const available = new Set(readdirSync(MIGRATIONS_ROOT).filter((f) => f.endsWith(".sql")));
      if (!available.has(filename)) {
        throw new Error(`apply-migration: "${filename}" is not a known migration`);
      }

      const already = await ctx.pool.query(`select 1 from jarvis.applied_migrations where filename = $1`, [filename]);
      if ((already.rowCount ?? 0) > 0) {
        return { detail: `${filename} already applied, skipped` };
      }

      const sql = readFileSync(path.join(MIGRATIONS_ROOT, filename), "utf8");
      const client = await ctx.pool.connect();
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query(`insert into jarvis.applied_migrations (filename) values ($1)`, [filename]);
        await client.query("commit");
      } catch (err) {
        await client.query("rollback");
        throw err;
      } finally {
        client.release();
      }
      return { detail: `applied ${filename}` };
    },
  },
};

export function getScript(name: string): ScriptDefinition | null {
  return Object.prototype.hasOwnProperty.call(SCRIPTS, name) ? SCRIPTS[name]! : null;
}

export function listScripts(): ScriptDefinition[] {
  return Object.values(SCRIPTS);
}
