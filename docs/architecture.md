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

## Dashboard

`src/dashboard/**` is an in-process `node:http` server (no framework, no
build step — the whole page is one exported HTML template literal in
`page.ts`) started from `src/orchestrator/index.ts` alongside the
orchestrator itself. It was deliberately built in-process rather than as a
separate service: a separate process would need its own channel to reach
`DomainManager`'s state, and any such channel is a new place the isolation
boundary could leak. In-process, the dashboard reads the exact same
in-memory objects the orchestrator already holds, through one narrow
adapter (`src/orchestrator/dashboardSource.ts`) — the only file allowed to
import both `DomainManager` and the dashboard's own types.

**The same belt-and-braces pattern as `OperationalMetadata` (above)
extends to everything the dashboard shows.** `src/dashboard/**` is
structurally forbidden from importing any domain-internal store —
`Domain.js`, `memoryStore.js`, `relationsStore.js`, `credentialStore.js`,
`capabilityRegistry.js`, `db.js`, or `pg` directly — enforced by a
static-analysis test (`test/dashboard.test.ts`) that scans every file under
`src/dashboard/` for those import strings. Every JSON response is
whitelist-validated (keys *and* value types/enums, not just key names) by
`assertDashboardPayloadShape` before it ever reaches the socket.

**`DomainContentSummary`** (`src/orchestrator/domainContentSummary.ts`) is
a second channel built the same way `OperationalMetadata` was: a real,
per-domain mail summary (`MailSummary` — unread/total counts, top 5
senders, capped and length-truncated) and, work-domain only, an Azure cost
slice (`AzureCostSummary` — month-to-date spend, top 5 services).
`azureCost` is hardcoded `null` for the personal domain — not
data-driven — so there's no code path where a personal-domain request
could ever produce Azure data. Fetched real-Graph-API/real-ARM-API by
`src/modules/personal/hotmail/summary.ts`,
`src/modules/work/nzb-connector/summary.ts`, and
`src/modules/work/nzb-connector/azureCost.ts`, on a coarser cadence
(`JARVIS_CONTENT_INTERVAL_MS`, default 15 min) than health, published to a
`ContentBus` mirroring `OperationalBus`. A connector that can't authenticate
(missing env vars) reports `status: "not_configured"` rather than
attempting a call — the dashboard renders that as a distinct, honest empty
state (no numeral at all, not a zero) rather than a fake value or an error.

**The Azure Cost Management credential is a deliberate exception to
`CredentialStore`'s pattern.** It's a 4-part ARM client-credentials
app registration (tenant/client/secret/subscription), which doesn't fit
`CredentialStore.get(ref)`'s single-token-plus-expiry shape. Rather than
force it into a JSON blob, `azureCost.ts` reads four raw env vars directly
under the `JARVIS_WORK_AZURE_*` prefix — still domain-isolated by naming
convention and by `azureCost` being hardcoded `null` on personal, just not
by construction the way `CredentialStore` normally guarantees. One
consequence: this credential has no `credential_ref`, so
`SecurityAccess.auditCredentials()` never surfaces its expiry on the health
panel — a failure shows up as `status: "error"` on next use, not as an
advance warning.

**Chat** (`src/dashboard/chat.ts`) is strictly one domain per conversation
— never both at once. That's enforced structurally, not just by
convention: `POST /api/chat/:domain` and `GET /api/chat/:domain/history`
each resolve one `DomainId` and never touch the other domain's
`ChatHistoryStore` instance. It talks to the Anthropic Messages API
directly (`ANTHROPIC_API_KEY`), not through `Reviewer`/`CapabilityRegistry`
— a deliberate scope boundary, not an oversight: routing chat through the
real capability system so it could take actions (send mail, look up a
Dynamics record) would need its own trust-tier classification and
approval-gate integration for whatever it's allowed to do, which is a
follow-up-sized feature in its own right. This pass ships a conversational
assistant that can see that domain's own `DomainContentSummary` as context,
not one that can act on your behalf.

Chat history persists per-domain in Postgres —
`{work,personal}.chat_history` (`db/schema.sql`), same
schema-per-domain-role pattern as `memory`/`relations`/`capabilities` — via
`src/domain/chatHistoryStore.ts`. Attachment *metadata* (filename, media
type, size) is persisted; attachment *bytes* never are, so an image or PDF
is only usable by the model in the turn it was sent — a reload shows that a
file was attached, not its content. Storage trims to the most recent 500
rows per domain on every write; separately, only the last 20 messages of
the *current* conversation (a 24-hour gap starts a new one) are replayed to
the model as context — a stricter, conversation-scoped read
(`ChatHistoryStore.recentForContext`) than the domain-wide read used to
render the visible transcript (`recentForDisplay`), so an old conversation
can never leak into a new one's context even though both remain visible in
history.

## Extending to a third domain

Add one entry to `src/config/domains.ts`, copy one of the `work` /
`personal` blocks in `db/schema.sql` with the new schema name, and add a
matching Postgres role + grants. Nothing in `src/orchestrator/` or
`src/core/` needs to change — they're already parameterized over
`DomainConfig`.
