# JARVIS v2 architecture

## The domain-isolation reversal

The original build (see git history) enforced hard isolation between a
"work" domain and a "personal" domain: separate Postgres schemas and
roles, separate credential namespaces, separate chat sessions, no shared
memory "under any circumstance." That was deliberately reversed after the
initial build proved the pattern worked but felt limiting in practice —
JARVIS now has **one unified memory store and one conversation** with
full context across work and personal life.

What this changed:
- `work`/`personal` Postgres schemas and roles → one `jarvis` schema,
  one `jarvis_app` role.
- Per-domain `CredentialStore` prefixes (`JARVIS_WORK_*` /
  `JARVIS_PERSONAL_*`) → one shared `JARVIS_CRED_<REF>` prefix.
- Two `DomainInstance`s → one `JarvisInstance`
  (`src/domain/JarvisInstance.ts`).
- Two `ChatService`s, two conversations → one `ChatService`, one
  conversation, all enabled capabilities visible as tools together.
- `capabilities.category` (freeform: "work", "personal", anything) —
  UI grouping only, never an access boundary.

What stayed separate: **credentials**. Each capability still resolves its
own `credential_ref` — the NZB M365 tenant and a personal Hotmail account
are different real-world accounts regardless of how the data layer is
organized, and nothing about unifying memory required unifying those.
Using one capability never touches another's credential — see
`src/domain/credentialStore.ts`.

The `assertOperationalMetadataShape` runtime check (in
`src/orchestrator/operationalMetadata.ts`) is kept even though it no
longer guards a domain boundary — it's still useful general hygiene so
the health/dashboard layer can never accidentally carry chat or memory
content, just not a security boundary anymore.

## Resolved: open decisions from the original spec

**Hosting.** The orchestrator process and Postgres both run on the Alfred
NUC via `docker-compose.yml` — no paid cloud service required.
`ANTHROPIC_API_KEY` is the one external dependency (Claude as the default
reasoning layer); embedding provider is left unconfigured until a
free-tier option is chosen.

**Single Postgres, one role.** `jarvis_app` **owns** its schema and
tables (not just DML-granted) specifically so `apply-migration` can run
real DDL without the running process ever holding superuser credentials.

**Conflict resolution when multiple enabled capabilities could both
handle a request.** Priority field first (`CapabilityRegistry.resolve`):
highest `priority` wins. A genuine tie is not broken arbitrarily — it's
surfaced as `{ kind: "ask_user" }`. In the chat path this mostly doesn't
come up: Claude disambiguates by naming one specific tool, so `resolve()`
is for a different, non-LLM-driven dispatch path if one is ever added.

**First modules.** `hotmail-outlook` (category `personal`, Microsoft
Graph) and `nzb-m365-connector` (category `work`, Microsoft Graph +
Dynamics BC). Both OAuth flows are stubbed — wiring live app
registrations is an operational step, not something to fake in code.

## Self-heal trust tiers

`src/core/trustTiers.ts` is the single source of truth. New action kinds
default to `requires_approval` unless explicitly added to the auto-fix
set — fail closed, per CLAUDE.md's "requires approval: anything touching
credentials, any structural/schema change, adding or removing a module."

Approval flow (`src/core/approvalGate.ts`) notifies via Pushover using
`JARVIS_PUSHOVER_TOKEN`/`JARVIS_PUSHOVER_USER`.

## Bounded script execution

JARVIS can run a small, fixed set of maintenance scripts on itself
(`src/core/scriptRegistry.ts`) rather than having general shell/exec
access. Deliberately not a database table like `capabilities`: adding a
script is a code change that goes through review, because a script can
touch infrastructure (schema, bulk DB operations) — a meaningfully bigger
blast radius than one capability module handling one request.

Each script declares its own trust tier and goes through the same
`SelfHeal` → `ApprovalGate` path as the built-in self-heal actions:
`vacuum-analyze` is `auto_fix` (routine, reversible); `apply-migration`
is `requires_approval` and only ever runs a `.sql` file that already
exists in `db/migrations/` — it never accepts or executes arbitrary SQL
text, and refuses a filename containing a path separator or `..`. Every
run — applied, pending, rejected, or failed — is recorded in
`jarvis.script_runs` regardless of outcome, so there's always an audit
trail of what JARVIS actually executed on its own.

Explicitly not built yet, and flagged rather than silently added: scripts
that would need host-level privilege (restarting the orchestrator
container, `git pull` + rebuild). Giving the orchestrator container
direct Docker-socket access to do that is effectively host-root-equivalent
— worth a deliberate decision (e.g. a narrow host-side helper process
instead) rather than something to wire up as a side effect of other work.
Tracked as an open item: exposing the script registry as chat-callable
tools (so "run X" in chat flows through the same approval gate as the
dashboard) is a natural, small next step; JARVIS editing/deploying its
own source code is the bigger version of this and needs its own scoping
conversation first.

## Chat interface

`src/chat/chatService.ts` — one `ChatService`, constructed with the
single `CapabilityRegistry`, `CredentialStore`, `MemoryStore`, and
`RelationsStore`. Conversation history lives in memory only, keyed by
session id (a v1 limitation shared with `ApprovalGate` — lost on
restart, fine for a single self-hosted instance).

Each turn: enabled capabilities become tools (a uniform `{intent,
payload}` schema, since that's what both starter connectors already
implement), plus three always-available **render tools** —
`render_chart`, `render_list`, `render_image` — that aren't capability
dispatches at all. When Claude calls one, `ChatService` captures the
payload into a `widgets` array on the result instead of routing it
through `CapabilityRegistry.loadModule()`; the dashboard renders each
widget type inline (an SVG-free CSS bar/line chart, a styled list, or an
image). This is how "what's this VM's performance" becomes a chart and
"my last emails" becomes a list, without a capability needing to know
anything about rendering.

File/image attachments: the dashboard's chat input accepts an image or
PDF, base64-encodes it client-side, and `ChatService.converse()` turns it
into a real `image`/`document` content block (per the Anthropic API) —
not just a text description of "the user attached a file." Only
image/png/jpeg/gif/webp and application/pdf are accepted; anything else
is rejected with a clear error before the request ever reaches Claude.

A `MemoryStore.search()` call retrieves related context if an embedding
provider is configured (skipped silently if not — chat still works, just
without recall). Claude runs a manual tool-use loop (capped at 8
iterations). After the turn, the interaction is written to memory and any
retrieved memories get an `INFERRED` batch relation to it — one write,
after the interaction, never mid-conversation, per the spec's explicit
v1 scope.

**Not yet wired:** a capability's `model_override` field exists in the
registry row but isn't read by the chat loop — every turn uses the one
top-level model (`claude-opus-5` by default, overridable via
`JARVIS_CHAT_MODEL`). True per-capability model routing (e.g. a cheap
classifier picking the capability, then that capability's own model
taking over) is a bigger dispatch redesign than this v1 needs — noted
rather than half-implemented.

**Capability module resolution:** `CapabilityRow.modulePath` is a
logical id (`"hotmail"`), not a filesystem path — a fixed path computed
once at manifest-authoring time couldn't be simultaneously correct in dev
(`tsx` running `src/**/*.ts`) and the built container (`node` running
`dist/src/**/*.js`). `CapabilityRegistry.loadModule()` resolves the id
against whichever tree it finds itself running in (detected via its own
`import.meta.url`), the same class of fix applied to
`scriptRegistry.ts`'s migrations path. Verified against a live database
in both dev and compiled form.

## Ops dashboard

`public/index.html` (served by `src/orchestrator/dashboard.ts`) is a
single-page view: a sidebar (health, pending proposals, scripts + run
history, capabilities grouped by their freeform category) and a chat
panel as the main surface, since talking to JARVIS is the primary way of
using it now — not two separate work/personal columns. Bearer-token
gated (`JARVIS_DASHBOARD_TOKEN`); binds `0.0.0.0` by default since
`127.0.0.1` inside a container is unreachable via Docker's port mapping
even from the host's own loopback.

## What's explicitly out of scope here

- No mid-conversation live relation computation — `RelationsStore` only
  exposes `writeBatch`, never a single live-write method.
- No auto-apply for anything structural or credential-related — enforced
  by `trustTiers.ts` defaulting new kinds to `requires_approval`.
- JARVIS editing or deploying its own source code — needs a host-level
  privilege decision first (see "Bounded script execution" above).

## Extending with a new capability, employer, or life area

Add a `src/modules/<name>/{index.ts,manifest.ts}` pair (see
`src/modules/hotmail/` as a template) and a row in `jarvis.capabilities`
with whatever `category` label makes sense. No orchestrator, chat, or
dashboard code needs to change — the whole point of the category being
freeform is that a third, fourth, or tenth capability is just another row.
