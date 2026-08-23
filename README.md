# JARVIS v2

Personal AI assistant orchestrator with hard domain isolation between work
(NZB) and personal life. See `CLAUDE.md` for the full spec and
`docs/architecture.md` for how it maps to code and the decisions made on
the spec's open questions.

This is the initial minimal build: core modules (reviewer, self-heal,
security/access) running per-domain, plus one real dynamic module per
domain (Hotmail for personal, an NZB M365/Dynamics connector for work).

## Run locally (Alfred NUC / any Docker host)

```bash
cp .env.example .env
# fill in JARVIS_DB_SUPERUSER_PASSWORD, JARVIS_WORK_DB_PASSWORD,
# JARVIS_PERSONAL_DB_PASSWORD, and ANTHROPIC_API_KEY at minimum

docker compose up -d db
# wait for db to be healthy, then create the per-domain roles' passwords
# to match .env (db/schema.sql creates the roles with placeholder
# passwords — update them, e.g.):
docker compose exec db psql -U postgres -d jarvis -c \
  "alter role jarvis_work with password '<matches JARVIS_WORK_DB_PASSWORD>';"
docker compose exec db psql -U postgres -d jarvis -c \
  "alter role jarvis_personal with password '<matches JARVIS_PERSONAL_DB_PASSWORD>';"

npm install
npm run seed        # registers hotmail-outlook and nzb-m365-connector

docker compose up -d orchestrator
docker compose logs -f orchestrator
```

## Develop without Docker

```bash
npm install
# requires a local Postgres with the pgvector extension available;
# psql -f db/schema.sql against it, then:
npm run seed
npm run dev
```

## Test

```bash
npm test        # domain-isolation unit tests (no database required)
npm run typecheck
```

## Adding a dynamic module

1. Create `src/modules/<domain>/<name>/{index.ts,manifest.ts}` following
   `src/modules/personal/hotmail/` as a template — implement
   `CapabilityModule` (`canHandle` / `handle`).
2. Insert (or extend `scripts/seed-registry.ts` to insert) a row into that
   domain's `capabilities` table pointing `module_path` at the compiled
   module.
3. No orchestrator or core-module code changes needed.

Disabling a module: `update <schema>.capabilities set enabled = false where
name = '...'`. Removing one: delete its row — memory entries are not
owned per-module and stay intact.
