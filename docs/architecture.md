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
Dynamics BC) — both real delegated OAuth. See "Delegated OAuth" below.

**Tried and abandoned: IMAP/SMTP with an app password for Hotmail.** To
avoid needing any Entra app registration for a personal mailbox at all,
`hotmail-outlook` briefly authenticated via an account app password over
IMAP (search) and SMTP (send) instead of Graph OAuth. It doesn't work:
Microsoft rejects the login outright ("Login is disabled") — Basic
Authentication is being phased out across consumer accounts too, not
just organizational tenants as originally assumed, and the account's own
"let apps use IMAP" setting being on doesn't matter once the server
itself refuses password-based login. Reverted back to Graph OAuth, same
mechanism `nzb-m365-connector` already used. The home tenant an app
registration lives in doesn't restrict which accounts can sign into it —
Microsoft explicitly supports a personal account consenting to an app
registered under an org tenant — so hosting `hotmail-outlook`'s app
registration in NZB's tenant (just the metadata: client ID, redirect
URI, requested scopes — never the actual mail content or tokens) turned
out to be the pragmatic answer, not something worth avoiding at real cost.

## Delegated OAuth

`hotmail-outlook` and `nzb-m365-connector` both need genuine delegated
consent — reading a real mailbox is not something an app-only
client-credentials grant can do (unlike the two read-only tenant-insight
capabilities below, which use exactly that). This can't be automated
away: only the mailbox's actual owner can click through Microsoft's
consent screen. What *can* be automated is everything else — token
exchange, storage, and refresh — via `src/domain/oauthCredentialStore.ts`:

1. Dashboard shows a **Connect** button next to any capability whose
   credential_ref has a `JARVIS_OAUTH_APP_<REF>` app config set
   (`GET /api/capabilities` exposes `oauthConfigured`).
2. Clicking it calls `GET /api/oauth/:ref/authorize-url` (behind the
   normal bearer-token auth, since it's a same-origin fetch) to get a
   real `login.microsoftonline.com` URL with a server-issued, single-use
   `state` token, then navigates the browser there directly.
3. The human completes Microsoft's actual consent screen.
4. Microsoft redirects the browser back to `GET /api/oauth/callback` — a
   route that can't sit behind bearer auth (a top-level browser
   navigation carries no Authorization header). Its security comes from
   `state` instead: unguessable, tied to one specific credential_ref,
   expires in 10 minutes, consumed exactly once
   (`OAuthCredentialStore.completeAuthorization`).
5. The authorization code is exchanged for an access + refresh token pair
   and persisted in `jarvis.oauth_credentials` — no redeploy, no `.env`
   edit, usable immediately.

At use time, `ChatService.resolveCredential()` tries
`OAuthCredentialStore.getValidToken()` first (refreshing automatically if
the stored token is near expiry) and only falls through to the static
`CredentialStore` (env-var) lookup if there's no connected row — so this
is purely additive: the two app-only tenant-insight capabilities never
have a row here at all, so `getValidToken()` returns null immediately and
they behave exactly as if this feature didn't exist (that lookup is also
fail-soft — a DB error, e.g. the migration not yet applied, is treated
the same as "not connected" rather than breaking the capability). If a
refresh fails (e.g. the human revoked consent in Microsoft), the
capability just reports "no credential configured" again, same as if it
had never been connected — no special-cased failure state.

## Tenant insights: read-only by design

`nzb-m365-usage-report` (`src/modules/nzb-usage-report/`) and
`nzb-azure-cost-insights` (`src/modules/nzb-azure-insights/`) answer
"what's this costing/who's using what/what looks unused" — M365
license/mailbox usage via Graph's Reports API, and Azure spend/orphaned
resources (unattached disks, unassociated public IPs) via the Cost
Management and Resource Graph APIs.

The design constraint that shaped these: **Azure PIM does not gate
standing application permissions on a service principal.** PIM makes a
*human's* directory-role or Azure-RBAC-role assignment just-in-time —
activate, use, expire. It has no equivalent for an app registration's
admin-consented API permissions or RBAC grants: the moment those are
consented, they're live, with no activation step, forever (or until
revoked). So a service principal credential that's broader than
"strictly read-only reporting" would quietly bypass the exact
just-in-time discipline PIM exists to enforce.

Given that, each of these two capabilities gets its **own** narrow,
read-only credential — never Contributor, never a directory-write scope,
never bundled onto a broader-privilege app registration:
- `nzb-m365-usage-report` needs only Graph's `Reports.Read.All`
  application permission.
- `nzb-azure-cost-insights` needs only Azure RBAC `Reader` + `Cost
  Management Reader` on the subscription.

They're separate capabilities (not one combined module) partly for that
credential-per-capability discipline and partly for a technical reason:
Graph and Azure Resource Manager are different token audiences
(`graph.microsoft.com` vs `management.azure.com`), so one bearer token
can't serve both anyway.

Both modules use fixed allowlists rather than accepting a caller-supplied
report name or KQL query (`ALLOWED_REPORTS` in nzb-usage-report,
`RESOURCE_GRAPH_PRESETS` in nzb-azure-insights) — defense in depth so
this can't become an arbitrary-Graph-endpoint or arbitrary-KQL-query
capability even if a prompt tried to steer it there. Neither module can
delete, resize, or modify anything; each manifest's `system_prompt` says
so explicitly, so the model never implies a cleanup it found was already
acted on — an actual deletion needs a human with PIM-activated
Contributor access, same as today.

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

The script registry is chat-callable too (`run_script` tool in
`src/chat/chatService.ts`) — JARVIS can propose running one of these
scripts mid-conversation, and it goes through the exact same
`SelfHeal.runScript()` → `ApprovalGate` path as the dashboard's "Run"
button: `vacuum-analyze` executes immediately, `apply-migration` is only
ever queued, never self-approved. The tool result text explicitly tells
the model a queued script "has NOT run yet," so a reply can't misreport a
pending change as already applied; the queued run then shows up in the
dashboard's existing pending-scripts list for a human to approve or
reject, same as one proposed from the dashboard itself.

Explicitly not built yet, and flagged rather than silently added: scripts
that would need host-level privilege (restarting the orchestrator
container, `git pull` + rebuild). Giving the orchestrator container
direct Docker-socket access to do that is effectively host-root-equivalent
— worth a deliberate decision (e.g. a narrow host-side helper process
instead) rather than something to wire up as a side effect of other work.
JARVIS editing/deploying its own source code is the bigger version of
"JARVIS proposes, human approves" and needs its own scoping conversation
before any of it is built.

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
dispatches at all, and a fourth always-available **`run_script`** tool
that lets JARVIS run one of the bounded scripts from
`src/core/scriptRegistry.ts` on itself (see "Bounded script execution"
above for the approval semantics — chat proposes, it never self-approves). When Claude calls one, `ChatService` captures the
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

## Autonomous fix loop

JARVIS can detect a capability failing repeatedly and get a human-reviewed
fix shipped for it — task #22's "JARVIS-initiated changes, approved by a
human" — but JARVIS itself never writes or deploys code. It only ever
detects and reports; a separate, scheduled Claude Code session does the
actual diagnosis, fix, and PR.

**Detection (`ChatService` → `jarvis.capability_failures`).** Every failed
capability dispatch from a chat turn is recorded (`CoreOpsStore.
recordCapabilityFailure`) — capability name and operational summary only,
best-effort, never allowed to fail the chat turn itself.

**Escalation (`Reviewer.reviewCapabilityFailures`).** Each reviewer cycle,
any capability with 3+ failures in the last 24h becomes a
`capability_failure` proposal (visible in the dashboard, same as any other
proposal) **and** gets reported via `src/core/githubIssueReporter.ts` —
which files a GitHub issue titled `[jarvis-capability-failure] <name>`,
labeled `jarvis-auto-detected`, with the failure count and latest error.
Deduplicated against already-open issues so a repeatedly-failing
capability doesn't spam new issues every cycle.

**Why GitHub, not a live API poll:** a scheduled Claude Code session has
no network path back into the NUC (verified directly — the sandbox's
egress proxy blocks it), but the NUC has ordinary outbound internet
access to GitHub. Filing an issue is the one direction this can actually
flow, and it doubles as a reviewable paper trail.

**The fix loop itself** is a Claude Code Routine (`JARVIS capability-
failure auto-fix loop`, cron every 6h, `create_new_session_on_fire`) — a
fresh session each firing that: searches for open `jarvis-auto-detected`
issues, reads the actual failing code (not just the error message) to
find the real root cause, and — only if confident — implements the
smallest correct fix, verifies it (`typecheck`, `test`, `build` all must
pass), pushes a branch, and opens a PR against the dev branch referencing
the issue. It **never merges its own PR** — that's the human review gate,
matching every other "requires_approval" boundary in this system (see
CLAUDE.md's self-heal trust tiers). If it can't confidently diagnose or
fix something (needs a live credential, needs live API testing, genuinely
ambiguous root cause), it comments on the issue explaining why instead of
shipping a guess.

**Opt-in, and inert without configuration.** `JARVIS_CRED_GITHUB_ISSUES`
(a fine-grained PAT scoped to Issues:write on this one repo only) and
`JARVIS_GITHUB_REPO` are both unset by default — `createGithubIssueReporter`
returns a no-op reporter until both are set, so this integration costs
nothing and changes no behavior for anyone who hasn't opted in.

This mirrors the pattern actually used by every real open-source project
doing AI-driven auto-remediation ([Self-Healing-SRE-Agent](
https://github.com/jalpatel11/Self-Healing-SRE-Agent), [Kubernaut](
https://github.com/jordigilh/kubernaut)) — diagnose and propose
autonomously, but never apply without a human in the loop. A genuinely
zero-review "JARVIS edits and deploys itself with nothing to stop it"
mode was considered and explicitly rejected — see the "Bounded script
execution" section above on why host-level deploy privilege stays a
separate, deliberate decision.

## Public exposure (Cloudflare Tunnel)

`jarvis.waikatohighlands.com` reaches the orchestrator's dashboard from
outside the home network through a Cloudflare Tunnel already configured
on the Cloudflare account that owns `waikatohighlands.com` — DNS for the
whole domain lives there. This was set up directly in the Cloudflare
dashboard, not through this repo, so it's written down here now that
it's been confirmed once, rather than relying on memory across sessions.

Adding another public hostname on the same tunnel (e.g. for the website
below) is a Cloudflare dashboard action, not a code change: Zero Trust →
Networks → Tunnels → the existing tunnel → **Public Hostname** → Add a
public hostname → hostname `waikatohighlands.com` (leave the subdomain
field blank for the root domain) → service `HTTP` → URL `localhost:8080`
(or `website:8080` if cloudflared itself runs as a container on this
same docker-compose network rather than directly on the NUC — see the
`website` service's port comment in `docker-compose.yml`). No new DNS
registration or port-forwarding needed; the tunnel already owns ingress
for the whole domain.

## Website module

A dynamic module (`farm-website`, category `farm`) that lets chat edit
waikatohighlands.com directly — "swap this photo," "update the About
text" — with changes going live immediately, no separate approval step.
It follows the same two-tier pattern as every other dynamic module
(`src/modules/hotmail/` is the template), but is the first one that also
needs its own long-running service to actually serve something, rather
than just calling an external API.

**Why the content lives in a separate repo.** `waikatohighlands-website`
(GitHub) holds the Astro site, its content, and the Sveltia CMS admin —
deliberately not a directory in this repo. Two reasons: blast radius (a
credential scoped to that repo can never touch JARVIS's own source, and
vice versa — same reasoning every other `credential_ref` already stays
separate), and audience (a family member editing a photo through the CMS
admin has no reason to see or touch JARVIS's code, and shouldn't need
access to this repo to do it).

**How an edit gets from chat to the live site.**
1. Chat calls `farm-website` with one of `website.updateSection`,
   `website.addPage`, `website.replacePhoto`, `website.listContent`
   (`src/modules/website/index.ts`).
2. The module commits the change directly to the content repo via
   GitHub's Contents API — the exact same API the Sveltia CMS admin
   uses, so a chat-driven edit and a human editing through the CMS UI
   are just two contributors to the same git history, never in conflict.
3. `website.replacePhoto` is the one intent that can't work purely from
   the model's tool-call JSON: Claude sees an attached image as vision
   input, and can't reliably re-emit its raw base64 bytes as a tool
   argument. So `CapabilityContext` now also carries the current turn's
   raw `attachments` (`src/domain/capabilityRegistry.ts`), threaded
   through from `ChatService.converse()` — a small, generic extension
   any future capability needing an uploaded file can reuse, not
   something specific to photos.
4. After a successful commit, the module POSTs to the `website-server`
   container's internal rebuild endpoint (`JARVIS_WEBSITE_REBUILD_URL`)
   so the live site updates right away instead of waiting for a
   scheduled rebuild. This is a best-effort side effect, not gated by
   ApprovalGate/trust tiers the way self-heal actions are — publishing
   an edit the user just asked for in chat carries none of the risk
   those tiers exist for (no credential or schema is touched), so
   there's no separate approval step to wait for.

**`website-server/`** (its own Dockerfile and `package.json`, not part
of the orchestrator's build) is what actually serves the site: on start,
and on every `/internal/rebuild` call, it pulls the content repo into a
volume, runs the Astro build, and serves the static output.
`/internal/rebuild` listens on a second port (8081) that is never
published to the host and never given a Cloudflare Tunnel hostname — the
docker-compose network boundary is its actual security, the same
reasoning `db`'s `127.0.0.1`-only bind relies on, not an auth check on
the route itself.

**Stack choices, and why.** Astro (content collections read straight
from the repo's files, built-in image optimization, supports real
interactive components without giving up static-site speed) plus
Sveltia CMS (an actively-maintained, git-based headless CMS that runs
entirely client-side with no server of its own — the modern successor
to Netlify/Decap CMS). Both are established open source projects rather
than something built from scratch here.

**Follow-up, not yet done:** Sveltia CMS's GitHub login needs a small
OAuth proxy (it can't complete GitHub's OAuth handshake purely
client-side) — noted in `waikatohighlands-website/README.md` as a next
step, not wired up yet. Until then the CMS admin UI isn't usable for a
human login; chat-driven edits through `farm-website` don't need it at
all, since those authenticate with the static PAT directly, no OAuth
handshake involved.

## Website structural changes and self-deploy

`farm-website`'s content/CSS intents (`updateSection`, `addPage`,
`replacePhoto`, `updateStyle`) publish instantly, on the reasoning that
they can only ever break one page at worst and never touch credentials
or schema (see "Website module" above). Two things sit outside that
reasoning, and both go through the existing bounded-script /
`ApprovalGate` / Pushover / dashboard-approve flow instead — the same
mechanism `apply-migration` already uses, reused rather than duplicated:

- **`apply-website-file`** (`src/core/scriptRegistry.ts`) — creates or
  overwrites any file in the website repo: `.astro` markup/logic,
  `astro.config.mjs`, `src/content.config.ts`, `admin/config.yml`,
  `package.json`, a brand new component. `requires_approval` because a
  bad file here can break the whole site's build, not just one page's
  content. Refuses any path under `.github/` outright — writing there
  would mean granting CI code-execution capability, a different and
  larger risk than "the website might look wrong," not something a
  human approving "update this file" would necessarily be weighing.
  `website.updateStyle` stays a separate, narrower, instant-publish path
  specifically because it's mechanically confined to text inside a
  `<style>...</style>` block (or a whole `.css` file) — it can change
  colors, spacing, image cropping, but never markup, logic, or config,
  which is what makes the no-approval-needed reasoning still hold for it
  specifically, even though it's editing the same files
  `apply-website-file` can also touch.

- **`redeploy-jarvis`** — pulls latest JARVIS code and rebuilds/restarts
  the orchestrator itself. `requires_approval` for an obvious reason:
  this restarts the very process handling the chat that requested it,
  and a bad pull/build takes JARVIS offline with no way to fix itself —
  recovering needs direct NUC access (SSH), the same as any other broken
  deploy. This was flagged as an open, deliberately-undecided question
  earlier in this doc ("host-level privilege... needs its own decision
  on how much access to grant") — the decision made was: give it, but
  only through a narrowly-scoped sidecar, never directly to orchestrator.

**`deploy-agent`** (`deploy-agent/`) is that sidecar, and the *only*
service in `docker-compose.yml` with Docker-socket access anywhere in
this stack — deliberately never added to `orchestrator`, since raw
socket access is root-equivalent on the host and orchestrator is exactly
the process reachable through chat. `deploy-agent` exposes exactly two
fixed, parameterless operations over a Docker-network-only HTTP endpoint
(never a host port, never a Cloudflare Tunnel hostname, same pattern as
`website-server`'s rebuild endpoint): `git pull`, then `docker compose
build && up -d` for `orchestrator` specifically. No request body is ever
read, so there is no way to make it run anything other than exactly
that sequence — the safety here is "there is nothing else this service
can be asked to do," not an auth check. `JARVIS_HOST_REPO_PATH` is
bind-mounted at the *same* path inside the container as on the host: the
commands `deploy-agent` sends over the Docker socket execute against the
host daemon, which resolves file paths against the host filesystem, not
the container's — mirroring the path is what makes `docker compose -f
$JARVIS_HOST_REPO_PATH/docker-compose.yml` resolve correctly from both
sides of that socket (the standard "Docker-outside-of-Docker" pattern).

Because step 3 of a redeploy restarts the very container that (via the
approved `redeploy-jarvis` script) asked for it, `deploy-agent` responds
`202 Accepted` immediately and runs the actual sequence in the
background — the caller's process may not survive to receive a
synchronous result. `GET /internal/last-redeploy` on `deploy-agent`
holds the outcome of the most recent attempt for whoever (human or a
later chat turn) wants to check afterward.

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
