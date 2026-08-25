-- JARVIS v2 schema — unified model.
--
-- Earlier revisions of this schema enforced hard domain isolation (separate
-- `work`/`personal` Postgres schemas and roles, no shared memory or chat).
-- That was deliberately reversed: memory and chat are now unified — one
-- assistant with full context across both work and personal life. What
-- stays genuinely separate is credentials: each capability (NZB connector,
-- Hotmail, whatever comes next) still points at its own credential_ref,
-- because those are different real-world accounts regardless of how the
-- data layer is organized. See docs/architecture.md.
--
-- `category` on capabilities is a freeform label ('work', 'personal',
-- anything) for UI grouping only — never an access-control boundary.
-- Adding a new capability, employer, or life area later is just a new row
-- with whatever category string makes sense; nothing here needs to change.

create extension if not exists vector;
create extension if not exists pgcrypto; -- gen_random_uuid()

create schema if not exists jarvis;

create table if not exists jarvis.capabilities (
  id             uuid primary key default gen_random_uuid(),
  name           text not null unique,          -- e.g. 'nzb-m365-connector'
  category       text,                           -- freeform UI label: 'work', 'personal', ... — not a security boundary
  enabled        boolean not null default true,
  priority       integer not null default 100,  -- higher wins on conflict; see docs/architecture.md
  schema_def     jsonb not null default '{}',   -- capability's own input/output schema
  system_prompt  text,
  tool_config    jsonb not null default '{}',
  model_override text,                          -- per-capability model routing override; null = default
  credential_ref text,                          -- pointer into CredentialStore, never the secret
  module_path    text not null,                 -- logical module id, resolved at load time
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists jarvis.memory (
  id          uuid primary key default gen_random_uuid(),
  content     text not null,
  embedding   vector(1536),
  source      text,                              -- e.g. capability name that wrote this
  metadata    jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index if not exists idx_jarvis_memory_embedding
  on jarvis.memory using ivfflat (embedding vector_cosine_ops) with (lists = 100);

create table if not exists jarvis.relations (
  id            uuid primary key default gen_random_uuid(),
  from_memory   uuid not null references jarvis.memory (id) on delete cascade,
  to_memory     uuid not null references jarvis.memory (id) on delete cascade,
  relation_type text not null,                    -- 'references' | 'supersedes' | ...
  confidence    text not null check (confidence in ('EXTRACTED', 'INFERRED', 'AMBIGUOUS')),
  written_at    timestamptz not null default now(),
  written_by    text not null default 'scheduled_pass' -- batch job identifier, never "live"
);
create index if not exists idx_jarvis_relations_from on jarvis.relations (from_memory);
create index if not exists idx_jarvis_relations_to on jarvis.relations (to_memory);

-- =========================================================================
-- Operational tables: reviewer proposals, script run audit log, migration
-- tracking, health snapshots. These previously lived in a shared `core`
-- schema specifically because domain-scoped roles needed narrow grants
-- onto them. With one role for the whole system that separation no longer
-- buys anything, so they live in the same `jarvis` schema now.
-- =========================================================================

create table if not exists jarvis.domain_health_snapshots (
  id                bigint generated always as identity primary key,
  reported_at       timestamptz not null default now(),
  module_health     jsonb not null,                 -- ModuleHealthSummary[]
  credential_status jsonb not null,                 -- CredentialStatusSummary[] (refs/status only, never secrets)
  error_counts      jsonb not null                   -- ErrorCountSummary
);
create index if not exists idx_jarvis_health_time
  on jarvis.domain_health_snapshots (reported_at desc);

create table if not exists jarvis.reviewer_proposals (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  category     text not null,      -- 'registry_health' | 'memory_quality' | 'error_log'
  summary      text not null,      -- operational description of the proposal, not domain content
  trust_tier   text not null check (trust_tier in ('auto_fix', 'requires_approval')),
  status       text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'applied')),
  resolved_at  timestamptz
);
create index if not exists idx_jarvis_proposals_status
  on jarvis.reviewer_proposals (status);

-- Audit log for the bounded script registry (src/core/scriptRegistry.ts).
-- Every run is recorded here, success or failure — this is the one place
-- an operator can see "what did JARVIS actually execute on its own."
create table if not exists jarvis.script_runs (
  id           uuid primary key default gen_random_uuid(),
  script_name  text not null,          -- must match a name in the in-code registry
  args         jsonb not null default '{}',
  trust_tier   text not null check (trust_tier in ('auto_fix', 'requires_approval')),
  status       text not null check (status in ('applied', 'pending_approval', 'rejected', 'failed')),
  detail       text,                    -- short operational outcome, never raw stdout/content
  started_at   timestamptz not null default now(),
  finished_at  timestamptz
);
create index if not exists idx_jarvis_script_runs_time
  on jarvis.script_runs (started_at desc);

-- Tracks which migrations (db/migrations/*.sql) have already been applied,
-- so apply-migration refuses to run the same file twice.
create table if not exists jarvis.applied_migrations (
  filename     text primary key,
  applied_at   timestamptz not null default now()
);

-- Every failed capability dispatch from a chat turn (ChatService), so the
-- Reviewer can notice a capability failing repeatedly rather than only
-- ever seeing one failure at a time in a chat transcript. Deliberately
-- lightweight — an operational count/summary trail, not a full log.
create table if not exists jarvis.capability_failures (
  id           uuid primary key default gen_random_uuid(),
  capability   text not null,
  summary      text not null,      -- operational error summary, never raw content
  occurred_at  timestamptz not null default now()
);
create index if not exists idx_jarvis_capability_failures_lookup
  on jarvis.capability_failures (capability, occurred_at desc);

-- =========================================================================
-- Role: one login role for the whole system, owning its own schema/tables
-- so the apply-migration script can run real DDL without the running
-- process ever holding superuser credentials. Password set out-of-band
-- (see docker-compose.yml / .env), never hardcoded here.
-- =========================================================================
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'jarvis_app') then
    create role jarvis_app login password 'change_me_app';
  end if;
end
$$;

alter schema jarvis owner to jarvis_app;
alter table jarvis.capabilities owner to jarvis_app;
alter table jarvis.memory owner to jarvis_app;
alter table jarvis.relations owner to jarvis_app;
alter table jarvis.domain_health_snapshots owner to jarvis_app;
alter table jarvis.reviewer_proposals owner to jarvis_app;
alter table jarvis.script_runs owner to jarvis_app;
alter table jarvis.applied_migrations owner to jarvis_app;
alter table jarvis.capability_failures owner to jarvis_app;

-- =========================================================================
-- Migrating from the earlier two-domain build: if `work`/`personal` schemas
-- exist from before, they are no longer used by the application. Nothing
-- here drops them automatically (no destructive DDL runs unattended) — if
-- you're moving an existing installation forward and confirmed there's no
-- real memory data worth keeping in them (a fresh build typically has
-- none), drop them yourself once you've confirmed that:
--   drop schema if exists work cascade;
--   drop schema if exists personal cascade;
--   drop role if exists jarvis_work;
--   drop role if exists jarvis_personal;
-- =========================================================================
