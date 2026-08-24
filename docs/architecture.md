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

## Bounded script execution

JARVIS can run a small, fixed set of maintenance scripts on its own
(`src/core/scriptRegistry.ts`) rather than having general shell/exec
access. Deliberately not a database table like `capabilities`: adding a
script is a code change that goes through review, because a script can
touch infrastructure (schema, bulk DB operations) — a meaningfully bigger
blast radius than one capability module handling one request.

Each script declares its own trust tier and goes through the same
`SelfHeal` → `ApprovalGate` path as the built-in self-heal actions:
`vacuum-analyze` is `auto_fix` (routine, reversible, single-domain);
`apply-migration` is `requires_approval` (CLAUDE.md: "any structural/schema
change," no exceptions) and only ever runs a `.sql` file that already
exists in that domain's `db/migrations/<domain>/` folder — it never
accepts or executes arbitrary SQL text, and refuses a filename containing
a path separator or `..`. Every run — applied, pending, rejected, or
failed — is recorded in `core.script_runs` regardless of outcome, so
there's always an audit trail of what JARVIS actually executed on its own.

Each domain's Postgres role (`jarvis_work` / `jarvis_personal`) **owns**
its own schema and tables (not just DML-granted) specifically so
`apply-migration` can run real DDL without the running process ever
holding superuser credentials. This doesn't weaken isolation — a domain
role still has zero grants anywhere in the other domain's schema; the
approval gate, not the role's privilege level, is what actually controls
schema changes.

Explicitly not built yet, and flagged rather than silently added: scripts
that would need host-level privilege (restarting the orchestrator
container, `git pull` + rebuild). Giving the orchestrator container direct
Docker-socket access to do that is effectively host-root-equivalent —
worth a deliberate decision (e.g. a narrow host-side helper process
instead) rather than something to wire up as a side effect of this work.

## Chat interface

`src/chat/chatService.ts` — one `ChatService` per domain, same pattern as
Reviewer/SelfHeal/SecurityAccess: constructed with that domain's own
`CapabilityRegistry`, `CredentialStore`, `MemoryStore`, and
`RelationsStore`. The Anthropic client itself is the one thing shared
across both domains' `ChatService` instances — it's a stateless reasoning
layer (the API holds no state between calls), so sharing it costs nothing
in isolation terms, matching CLAUDE.md's "Claude is the default/primary
reasoning layer for both domains." Everything that actually carries
content — conversation history, retrieved memory, which capabilities are
even visible as tools — stays domain-scoped per instance and never
crosses. The system prompt itself also states the domain boundary
explicitly (defense in depth on top of the architectural separation, not
a substitute for it).

Each turn: enabled capabilities become tools (a uniform `{intent,
payload}` schema, since that's what both `hotmail-outlook` and
`nzb-m365-connector` already implement); a `MemoryStore.search()` call
retrieves related context if an embedding provider is configured (skipped
silently if not — chat still works, just without recall); Claude runs a
manual tool-use loop (capped at 8 iterations) dispatching each `tool_use`
to `CapabilityRegistry.loadModule()` for the exact capability Claude named
— no priority/conflict resolution needed here, since Claude disambiguates
by naming one specific tool (unlike the priority-based resolution in
`CapabilityRegistry.resolve()`, which is for a different, non-LLM-driven
dispatch path). After the turn, the interaction is written to memory and
any retrieved memories get an `INFERRED` batch relation to it — one write,
after the interaction, never mid-conversation, per CLAUDE.md's explicit
v1 scope.

**Not yet wired:** a capability's `model_override` field exists in the
registry row but isn't read by the chat loop — every turn uses the
domain's single top-level model (`claude-opus-5` by default, overridable
per domain via `JARVIS_<DOMAIN>_CHAT_MODEL`). True per-capability model
routing (e.g. a cheap classifier picking the capability, then that
capability's own model taking over) is a bigger dispatch redesign than
this v1 needs — noted rather than half-implemented.

**Capability module resolution fix:** `CapabilityRow.modulePath` is a
logical id (`"personal/hotmail"`), not a filesystem path — a fixed path
computed once at manifest-authoring time couldn't be simultaneously
correct in dev (`tsx` running `src/**/*.ts`) and the built container
(`node` running `dist/src/**/*.js`). `CapabilityRegistry.loadModule()`
resolves the id against whichever tree it finds itself running in
(detected via its own `import.meta.url`), the same class of fix already
applied to `scriptRegistry.ts`'s migrations path. Verified against a live
database in both dev and compiled form before calling this done.

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
