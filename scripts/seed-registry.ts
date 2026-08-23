import { DOMAINS } from "../src/config/domains.js";
import { createDomainPool } from "../src/domain/db.js";
import { hotmailManifest } from "../src/modules/personal/hotmail/manifest.js";
import { nzbConnectorManifest } from "../src/modules/work/nzb-connector/manifest.js";

/**
 * Seeds each domain's capabilities table with its one starter dynamic
 * module. Run once against a fresh database (after db/schema.sql):
 *   npm run seed
 */
async function seed(): Promise<void> {
  const workPool = createDomainPool(DOMAINS.work);
  const personalPool = createDomainPool(DOMAINS.personal);

  try {
    await upsertCapability(workPool, "work", nzbConnectorManifest);
    await upsertCapability(personalPool, "personal", hotmailManifest);
    console.log("Seeded work.nzb-m365-connector and personal.hotmail-outlook.");
  } finally {
    await workPool.end();
    await personalPool.end();
  }
}

async function upsertCapability(
  pool: import("pg").Pool,
  schema: "work" | "personal",
  manifest: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `insert into ${schema}.capabilities
       (name, enabled, priority, schema_def, system_prompt, tool_config, model_override, credential_ref, module_path)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (name) do update set
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
