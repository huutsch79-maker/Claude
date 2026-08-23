# JARVIS v2 architecture

This is the initial minimal build described in CLAUDE.md: reviewer +
self-heal (core, both domains) + one real dynamic module per domain
(Hotmail for personal, NZB M365/Dynamics connector for work), proving the
pattern before adding more modules.

## Domain isolation, concretely

- One `DomainInstance` (`src/domain/Domain.ts`) per domain, each owning its
  own `pg.Pool` authenticated as its own Postgres role (`jarvis_work` /
  `jarvis_personal`), its own `CredentialStore` (reads only env vars under
  its own prefix), `MemoryStore`, `RelationsStore`, and `CapabilityRegistry`.
- `DomainManager` (`src/orchestrator/domainManager.ts`) constructs both
  instances but never reaches into either one's stores — it only calls
  `reportHealth()`, which returns an `OperationalMetadata` object.
- `OperationalMetadata`'s shape is enforced twice: by the TypeScript type,
  and at runtime by `assertOperationalMetadataShape` (throws on any field
  not in the whitelist: module health, credential status, error counts).
  This is deliberate belt-and-braces — the type system alone can't stop a
  future refactor from smuggling a string field across the boundary, but
  the runtime assertion will.
- The database backs this up independently: `jarvis_work` has no grants on
  schema `personal`, and `jarvis_personal` has none on `work`. Even a bug
  that somehow got the wrong pool into the wrong hands would be refused by
  Postgres itself.

## Resolved: open decisions from CLAUDE.md

**Hosting split.** Both domains' orchestrator processes and the single
Postgres instance run on the Alfred NUC via `docker-compose.yml` — no paid
cloud service required for this initial build. `ANTHROPIC_API_KEY` is the
one external dependency (Claude as the default reasoning layer); embedding
provider is left unconfigured until a free-tier option is chosen.

**Supabase vs single Postgres.** Single Postgres instance, `work` and
`personal` schemas, one login role per schema with grants scoped to that
schema plus the two shared `core` tables (see `db/schema.sql`). This keeps
everything on one free/self-hosted database rather than juggling two
Supabase projects, while still getting hard, server-enforced isolation via
role grants — reversible later if a stronger boundary (separate Supabase
projects, or separate physical databases) turns out to be worth the extra
operational overhead.

**Conflict resolution when multiple enabled modules could handle a
request.** Priority field first (`CapabilityRegistry.resolve`): highest
`priority` wins. A genuine tie is not broken arbitrarily — it's surfaced
as `{ kind: "ask_user" }` rather than picked silently, since guessing
wrong on which module handles a request is exactly the kind of thing that
should stay visible rather than fail silently.

**First modules to build.** Reviewer + self-heal (core, both domains,
already present in every `DomainInstance`) plus one real dynamic module
per domain: `hotmail-outlook` (personal, Microsoft Graph) and
`nzb-m365-connector` (work, Microsoft Graph + Dynamics BC). Both OAuth
flows are stubbed — wiring live app registrations is an operational step,
not something to fake in code.

## Self-heal trust tiers

`src/core/trustTiers.ts` is the single source of truth. New action kinds
default to `requires_approval` unless explicitly added to the auto-fix
set — fail closed, per CLAUDE.md's "requires approval: anything touching
credentials, anything that could cross or weaken the domain boundary, any
structural/schema change, adding or removing a module."

Approval flow (`src/core/approvalGate.ts`) notifies via Pushover, using
each domain's own `JARVIS_<DOMAIN>_PUSHOVER_*` credentials — so even the
approval notification for a work-domain proposal never uses (or requires)
a personal Pushover key, and vice versa.

## What's explicitly out of scope here (matches CLAUDE.md v1 scope)

- No mid-conversation live relation computation — `RelationsStore` only
  exposes `writeBatch`, never a single live-write method.
- No auto-apply for anything structural or credential-related — enforced
  by `trustTiers.ts` defaulting new kinds to `requires_approval`.
- No shared memory or credentials between domains — enforced at the code,
  connection-pool, and database-role layers described above.

## Extending to a third domain

Add one entry to `src/config/domains.ts`, copy one of the `work` /
`personal` blocks in `db/schema.sql` with the new schema name, and add a
matching Postgres role + grants. Nothing in `src/orchestrator/` or
`src/core/` needs to change — they're already parameterized over
`DomainConfig`.
