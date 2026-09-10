import pg from "pg";
import type { DomainConfig } from "../config/domains.js";

const { Pool } = pg;

/**
 * One connection pool per domain, authenticated as that domain's own
 * Postgres role (jarvis_work / jarvis_personal — see db/schema.sql) so
 * cross-domain access is refused by the database itself, not just by
 * application code discipline.
 */
export function createDomainPool(config: DomainConfig): pg.Pool {
  const userEnv = `${config.credentialEnvPrefix}DB_USER`;
  const passEnv = `${config.credentialEnvPrefix}DB_PASSWORD`;
  return new Pool({
    host: process.env.JARVIS_DB_HOST ?? "localhost",
    port: Number(process.env.JARVIS_DB_PORT ?? 5432),
    database: process.env.JARVIS_DB_NAME ?? "jarvis",
    user: process.env[userEnv] ?? `jarvis_${config.id}`,
    password: process.env[passEnv],
    // pg's default is 0 (wait forever) for a connection attempt — against an
    // unreachable database that means pool.end() during shutdown never
    // resolves and the process waits for a supervisor's SIGKILL. Bound it.
    connectionTimeoutMillis: Number(process.env.JARVIS_DB_CONNECTION_TIMEOUT_MS ?? 10_000),
    // schema-qualify every query instead of relying on search_path, so a
    // misconfigured connection can't silently resolve to the wrong schema
  });
}
