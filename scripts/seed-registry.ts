import { createJarvisPool } from "../src/domain/db.js";
import { hotmailManifest } from "../src/modules/hotmail/manifest.js";
import { nzbConnectorManifest } from "../src/modules/nzb-connector/manifest.js";

/**
 * Seeds the capabilities table with the two starter dynamic modules. Run
 * once against a fresh database (after db/schema.sql):
 *   npm run seed
 */
async function seed(): Promise<void> {
  const pool = createJarvisPool();
  try {
    await upsertCapability(pool, nzbConnectorManifest);
    await upsertCapability(pool, hotmailManifest);
    console.log("Seeded nzb-m365-connector and hotmail-outlook.");
  } finally {
    await pool.end();
  }
}

async function upsertCapability(pool: import("pg").Pool, manifest: Record<string, unknown>): Promise<void> {
  await pool.query(
    `insert into jarvis.capabilities
       (name, category, enabled, priority, schema_def, system_prompt, tool_config, model_override, credential_ref, module_path)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (name) do update set
       category = excluded.category,
       enabled = excluded.enabled,
       priority = excluded.priority,
       schema_def = excluded.schema_def,
       system_prompt = excluded.system_prompt,
       tool_config = excluded.tool_config,
       model_override = excluded.model_override,
       credential_ref = excluded.credential_ref,
       module_path = excluded.module_path,
       updated_at = now()`,
    [
      manifest.name,
      manifest.category,
      manifest.enabled,
      manifest.priority,
      JSON.stringify(manifest.schema_def),
      manifest.system_prompt,
      JSON.stringify(manifest.tool_config),
      manifest.model_override,
      manifest.credential_ref,
      manifest.module_path,
    ],
  );
}

seed().catch((err) => {
  console.error("seed failed", err);
  process.exit(1);
});
