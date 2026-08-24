# JARVIS v2

Personal AI assistant with one unified memory and chat across work (NZB)
and personal life. See `CLAUDE.md` for the full spec and
`docs/architecture.md` for how it maps to code and the decisions made
along the way — including the domain-isolation reversal (memory/chat are
unified; credentials still stay separate per capability).

Core modules (reviewer, self-heal, security/access), a bounded set of
maintenance scripts JARVIS can run on itself
(`src/core/scriptRegistry.ts`), an ops dashboard, and a chat interface
backed by the Claude API that can show charts/lists/images inline and
accept file/image attachments.

## Run locally (Alfred NUC / any Docker host)

```bash
cp .env.example .env
# fill in JARVIS_DB_SUPERUSER_PASSWORD, JARVIS_APP_DB_PASSWORD,
# ANTHROPIC_API_KEY, and JARVIS_DASHBOARD_TOKEN at minimum (the dashboard
# runs unauthenticated, with a startup warning, if you skip the token —
# fine for a quick local look, not for leaving it running reachable on
# your LAN)

docker compose up -d db
# wait for db to be healthy, then set the app role's password to match
# .env (db/schema.sql creates the role with a placeholder password):
docker compose exec db psql -U postgres -d jarvis -c \
  "alter role jarvis_app with password '<matches JARVIS_APP_DB_PASSWORD>';"

npm install
npm run seed        # registers hotmail-outlook and nzb-m365-connector

docker compose up -d orchestrator
docker compose logs -f orchestrator
```

Then open `http://<nuc-address>:4570` for the dashboard — chat as the
main panel (talks to Claude, which can call any enabled capability as a
tool, show a chart/list/image inline, run one of its own bounded
maintenance scripts via the `run_script` tool, and accept a file/image
attachment via the paperclip button), plus a sidebar with health, pending
reviewer proposals (acknowledge/dismiss), the script registry (run
auto-fix scripts directly; scripts requiring approval — whether proposed
from the dashboard or from chat — show up here for approve/reject), script
run history, and the capability registry (enable/disable, grouped by
category). Enter the dashboard token you set
in `.env` when prompted — it's stored in the browser's `localStorage`,
not sent anywhere else. Chat needs `ANTHROPIC_API_KEY` set — without it,
every send returns a clear "not configured" error rather than failing
silently.

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
npm test        # unit tests (no database required)
npm run typecheck
```

## Adding a dynamic module

1. Create `src/modules/<name>/{index.ts,manifest.ts}` following
   `src/modules/hotmail/` as a template — implement `CapabilityModule`
   (`canHandle` / `handle`), and give the manifest a `category` label
   (freeform — "work", "personal", anything; UI grouping only).
2. Insert (or extend `scripts/seed-registry.ts` to insert) a row into the
   `jarvis.capabilities` table pointing `module_path` at the module's
   logical id (its directory name under `src/modules/`).
3. No orchestrator or core-module code changes needed.

Disabling a module: `update jarvis.capabilities set enabled = false where
name = '...'` (or the dashboard's Enable/Disable button). Removing one:
delete its row — memory entries are not owned per-module and stay intact.

## Adding a maintenance script

Scripts (`src/core/scriptRegistry.ts`) are deliberately *not* a database
table — unlike capabilities, adding one is a code change, since scripts
can run real DDL/bulk operations rather than handling one request. Add an
entry to the `SCRIPTS` object with its own `trustTier`; anything other
than the existing `auto_fix` set defaults to `requires_approval`. See
`db/migrations/README.md` for how schema migrations flow through
`apply-migration`.
