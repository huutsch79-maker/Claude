import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type pg from "pg";
import type { TrustTier } from "./trustTiers.js";
import { getFile, putFile, websiteRepoRef } from "../domain/githubContentsApi.js";

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

  "apply-website-file": {
    name: "apply-website-file",
    description:
      "Create or overwrite one file in the website content repo — for anything beyond page content or CSS " +
      "(Astro templates/markup, astro.config.mjs, content.config.ts, admin/config.yml, package.json). Publishes " +
      "instantly, same as a content edit — the user explicitly chose speed over a review step here, accepting " +
      "that a bad file can break the whole site's build (unlike a content edit, which can only ever go wrong on " +
      "one page). The hardcoded .github/ refusal below is not part of that tradeoff and stays regardless.",
    trustTier: "auto_fix", // per explicit user decision — see docs/architecture.md's "Website structural changes" section
    run: async (ctx) => {
      const filePath = ctx.args.path;
      const contentBase64 = ctx.args.contentBase64;
      if (!filePath) throw new Error("apply-website-file requires args.path");
      if (!contentBase64) throw new Error("apply-website-file requires args.contentBase64");
      if (filePath.startsWith("/") || filePath.includes("..")) {
        throw new Error(`apply-website-file: rejected unsafe path "${filePath}"`);
      }
      if (filePath.startsWith(".github/")) {
        throw new Error(
          `apply-website-file: refusing to write to .github/ — that can grant CI code execution, out of scope for this script.`,
        );
      }

      const token = process.env.JARVIS_CRED_WEBSITE_GITHUB;
      if (!token) throw new Error("apply-website-file: JARVIS_CRED_WEBSITE_GITHUB is not set");

      const ref = websiteRepoRef();
      const existing = await getFile(ref, filePath, token);
      await putFile(ref, filePath, contentBase64, `website: apply ${filePath} via JARVIS chat`, existing?.sha, token);

      let rebuildDetail = "rebuild not configured (JARVIS_WEBSITE_REBUILD_URL unset)";
      const rebuildUrl = process.env.JARVIS_WEBSITE_REBUILD_URL;
      if (rebuildUrl) {
        try {
          const response = await fetch(rebuildUrl, { method: "POST" });
          rebuildDetail = response.ok ? "rebuild triggered" : `rebuild trigger failed (${response.status})`;
        } catch (err) {
          rebuildDetail = `rebuild trigger failed (${err instanceof Error ? err.message : String(err)})`;
        }
      }

      return { detail: `wrote ${filePath} to the website repo; ${rebuildDetail}` };
    },
  },

  "redeploy-jarvis": {
    name: "redeploy-jarvis",
    description:
      "Pull the latest JARVIS code and rebuild+restart the orchestrator itself, via the deploy-agent sidecar " +
      "(the only service with Docker-socket access). Requires approval: this restarts the very process handling " +
      "chat, and a bad pull/build takes JARVIS offline with no way to fix itself — recovering needs direct NUC " +
      "access (SSH) the same as any other broken deploy, JARVIS included.",
    trustTier: "requires_approval", // restarts JARVIS itself — same reasoning as apply-migration, higher stakes
    run: async () => {
      const url = process.env.JARVIS_DEPLOY_AGENT_URL;
      if (!url) throw new Error("redeploy-jarvis: JARVIS_DEPLOY_AGENT_URL is not set");
      const response = await fetch(url, { method: "POST" });
      if (!response.ok) throw new Error(`redeploy-jarvis: deploy-agent rejected the request (${response.status})`);
      return {
        detail:
          "redeploy started on deploy-agent — this may restart the orchestrator mid-response, so success isn't " +
          "confirmed yet; check again shortly (deploy-agent's GET /internal/last-redeploy, or just whether this " +
          "chat is responding on the new code).",
      };
    },
  },
};

export function getScript(name: string): ScriptDefinition | null {
  return Object.prototype.hasOwnProperty.call(SCRIPTS, name) ? SCRIPTS[name]! : null;
}

export function listScripts(): ScriptDefinition[] {
  return Object.values(SCRIPTS);
}
