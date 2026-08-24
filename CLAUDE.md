## JARVIS v2

Personal AI assistant helping with work (NZB, and any future employer) and
private life (farm, house, family) — one assistant, one conversation, one
memory across all of it.

### Core principle: unified memory and chat

Earlier revisions of this spec required hard isolation between a "work"
domain and a "personal" domain — separate schemas, separate roles,
separate chat sessions, no shared memory "under any circumstance." That
was deliberately reversed: JARVIS now has one memory store and one
conversation with full context across work and personal life, because
splitting them made the assistant less useful without buying real safety
(nothing about the actual risk — credential leakage — required splitting
memory to prevent it).

What stays genuinely separate: **credentials**. Each capability points at
its own credential reference (`JARVIS_CRED_<REF>`), because the actual
accounts behind them are different regardless of how the data layer is
organized — NZB's M365 tenant and a personal Hotmail account are never
the same secret, and using one capability never touches another's
credential.

Capabilities carry an optional freeform `category` label ("work",
"personal", or anything else) purely for UI grouping — it is never an
access-control boundary. Adding a future capability, employer, or life
area is just a new row with whatever category makes sense; nothing in the
orchestrator, chat, or dashboard needs to change.

### Two-tier module architecture

Core modules — hardcoded into the orchestrator, not toggleable:

* **Reviewer** — runs on a schedule, inspects registry health, memory
  quality, and error logs; produces proposals, never applies changes
  automatically except within the "safe to auto-fix" tier below.
* **Self-heal** — restarts crashed modules, clears stale cache/session
  state, retries transient failures, and runs the bounded script registry
  (below).
* **Security/access** — audits credential validity and access patterns.

Dynamic modules — rows in the `jarvis.capabilities` registry table,
addable/removable without code changes (e.g. the NZB M365/Dynamics
connector, Hotmail/Outlook, Home Assistant, farm-specific tools).
Disabling a module = flip `enabled` to false. Removing a module = delete
its registry row; memory entries are not owned per-module and stay
intact.

### Self-heal trust tiers

* **Auto-fix, no approval needed**: reversible, single-system issues —
  module crash/restart, stale cache, high-confidence duplicate memory
  cleanup, transient API retry, routine DB maintenance (`vacuum-analyze`).
* **Requires approval** (Pushover, propose-then-approve): anything
  touching credentials, any structural/schema change (`apply-migration`),
  adding or removing a module.

New self-heal action kinds and new bounded scripts default to
`requires_approval` unless explicitly classified otherwise — fail closed.

### Bounded script execution

JARVIS can run a small, fixed set of maintenance scripts on itself
(`src/core/scriptRegistry.ts`) — not a database table like capabilities,
since scripts can touch infrastructure (schema, bulk DB operations), a
bigger blast radius than one capability handling one request. Adding a
script is a code change that goes through review.

Not yet built, and deliberately flagged rather than silently added:
scripts needing host-level privilege (restarting the orchestrator
container, `git pull` + rebuild). That needs its own decision on how much
access to grant (e.g. Docker socket access is effectively root on the
host) before it's wired up.

### Chat interface

One conversation, backed by Claude, with every enabled capability
available as a tool. Two things aren't ordinary capability calls:

* **Render tools** (`render_chart`, `render_list`, `render_image`) — always
  available, let JARVIS show a chart, a structured list, or an image
  inline in the chat instead of only prose (e.g. "what's this VM's
  performance" → a chart; "my last emails" → a list).
* **File/image attachments** — the user can attach an image or PDF to a
  chat message; it's passed through to Claude as a real content block,
  not just described in text.

Relations between memory items are written after an interaction (or on a
scheduled pass) as a batch, tagged EXTRACTED/INFERRED/AMBIGUOUS — never
computed live mid-conversation.

### Model routing

Claude is the default/primary reasoning layer (`claude-opus-5` unless
overridden). Other models can be configured per-capability in the
registry row (`model_override`) — a per-capability config field, not
(yet) wired into the chat dispatch loop; see docs/architecture.md for
what that would take.

### Ops dashboard

A single-page view (`public/index.html`, served by
`src/orchestrator/dashboard.ts`) covering chat, health, pending reviewer
proposals, the script registry (run/approve/reject), script run history,
and the capability registry (enable/disable, grouped by category).
Bearer-token gated (`JARVIS_DASHBOARD_TOKEN`).

### Explicitly out of scope for v1

* No mid-conversation live relation computation (batch/scheduled only).
* No auto-apply for anything structural or credential-related, regardless
  of confidence.
* JARVIS editing or deploying its own source code (host-level privilege)
  — needs its own scoping decision first.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
