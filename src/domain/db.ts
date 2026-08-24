import pg from "pg";

const { Pool } = pg;

/** Single connection pool for the whole system, authenticated as jarvis_app (see db/schema.sql). */
export function createJarvisPool(): pg.Pool {
  return new Pool({
    host: process.env.JARVIS_DB_HOST ?? "localhost",
    port: Number(process.env.JARVIS_DB_PORT ?? 5432),
    database: process.env.JARVIS_DB_NAME ?? "jarvis",
    user: process.env.JARVIS_APP_DB_USER ?? "jarvis_app",
    password: process.env.JARVIS_APP_DB_PASSWORD,
  });
}
