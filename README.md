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

## Dashboard

An in-process web UI, served by the orchestrator itself at
`http://127.0.0.1:7317` by default (`JARVIS_DASHBOARD_HOST`/`_PORT`, or set
`JARVIS_DASHBOARD_ENABLED=false` to turn it off). One domain on screen at a
time — a mode switch at the top, never a mixed view — showing:

- **Health**: module status, credential expiry, error counts, pending
  self-heal approvals (read-only).
- **Mail**: unread/total counts and top senders for Hotmail (personal) or
  the NZB mailbox (work), refreshed every `JARVIS_CONTENT_INTERVAL_MS`
  (default 15 min).
- **Azure cost** (work domain only): month-to-date spend and top services.
  Requires all four `JARVIS_WORK_AZURE_*` vars in `.env.example` — an app
  registration with Reader + Cost Management Reader on the subscription you
  want to see. Without it, the panel shows an honest "Not configured" state
  naming the missing vars, not a fake zero.
- **Chat**: ask JARVIS about the current domain's mail/cost data, with
  image or PDF/text attachments (paste, drag-drop, or file picker). Needs
  `ANTHROPIC_API_KEY`. One conversation per domain, persisted in that
  domain's own Postgres schema (`{work,personal}.chat_history`) — switching
  domains never carries context across. This chat can *discuss* your data
  but can't yet *act* on it (no sending mail, no Dynamics lookups) — see
  `docs/architecture.md` for why that's a deliberate scope boundary, not a
  bug.

See `docs/architecture.md`'s "Dashboard" section for how each of these
respects the domain-isolation invariant.

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
