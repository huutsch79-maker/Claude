-- JARVIS v2 schema.
--
-- Domain isolation is enforced at the schema level: `work` and `personal`
-- own their own memory/relations/capabilities tables, and nothing in
-- `core` may ever hold domain content — only operational metadata
-- (module health, credential expiry, error counts). See
-- docs/architecture.md for the reasoning.
--
-- Adding a third domain later = copy one of the two domain blocks below
-- with a new schema name. Nothing in `core` needs to change.

create extension if not exists vector;
create extension if not exists pgcrypto; -- gen_random_uuid()

-- =========================================================================
-- core: shared layer. Operational metadata ONLY. No request context, no
-- memory content, no credentials. Enforced in code too (see
-- src/orchestrator/operationalMetadata.ts) but the schema stays this thin
-- on purpose so a stray migration can't quietly widen it.
-- =========================================================================
create schema if not exists core;

create table if not exists core.domain_health_snapshots (
  id                bigint generated always as identity primary key,
  domain            text not null,                 -- 'work' | 'personal' | future domains
  reported_at       timestamptz not null default now(),
  module_health     jsonb not null,                 -- ModuleHealthSummary[]
  credential_status jsonb not null,                 -- CredentialStatusSummary[] (refs/status only, never secrets)
  error_counts      jsonb not null                   -- ErrorCountSummary
);
create index if not exists idx_core_health_domain_time
  on core.domain_health_snapshots (domain, reported_at desc);

create table if not exists core.reviewer_proposals (
  id           uuid primary key default gen_random_uuid(),
  domain       text not null,
  created_at   timestamptz not null default now(),
  category     text not null,      -- 'registry_health' | 'memory_quality' | 'error_log'
  summary      text not null,      -- operational description of the proposal, not domain content
  trust_tier   text not null check (trust_tier in ('auto_fix', 'requires_approval')),
  status       text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'applied')),
  resolved_at  timestamptz
);
create index if not exists idx_core_proposals_domain_status
  on core.reviewer_proposals (domain, status);

-- Audit log for the bounded script registry (src/core/scriptRegistry.ts).
-- Every run is recorded here, success or failure — this is the one place
-- an operator can see "what did JARVIS actually execute on its own."
create table if not exists core.script_runs (
  id           uuid primary key default gen_random_uuid(),
  domain       text not null,
  script_name  text not null,          -- must match a name in the in-code registry
  args         jsonb not null default '{}',
  trust_tier   text not null check (trust_tier in ('auto_fix', 'requires_approval')),
  status       text not null check (status in ('applied', 'pending_approval', 'rejected', 'failed')),
  detail       text,                    -- short operational outcome, never raw stdout/domain content
  started_at   timestamptz not null default now(),
  finished_at  timestamptz
);
create index if not exists idx_core_script_runs_domain_time
  on core.script_runs (domain, started_at desc);

-- Tracks which migrations (db/migrations/<domain>/*.sql) have already been
-- applied, so apply-migration refuses to run the same file twice.
create table if not exists core.applied_migrations (
  domain       text not null,
  filename     text not null,
  applied_at   timestamptz not null default now(),
  primary key (domain, filename)
);

-- =========================================================================
-- Per-domain schema template (duplicated for `work` and `personal` below,
-- deliberately not parameterized/looped — explicit beats clever here so a
-- diff on one domain's DDL is never accidentally shared with the other).
-- =========================================================================

-- ---------------------------------------------------------------- work --
create schema if not exists work;

create table if not exists work.capabilities (
  id             uuid primary key default gen_random_uuid(),
  name           text not null unique,          -- e.g. 'nzb-m365-connector'
  enabled        boolean not null default true,
  priority       integer not null default 100,  -- higher wins on conflict; see docs/architecture.md
  schema_def     jsonb not null default '{}',   -- capability's own input/output schema
  system_prompt  text,
  tool_config    jsonb not null default '{}',
  model_override text,                          -- per-capability model routing override; null = domain default
  credential_ref text,                          -- pointer into CredentialStore, never the secret
  module_path    text not null,                 -- path to the capability implementation module
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists work.memory (
  id          uuid primary key default gen_random_uuid(),
  content     text not null,
  embedding   vector(1536),
  source      text,                              -- e.g. capability name that wrote this
  metadata    jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index if not exists idx_work_memory_embedding
  on work.memory using ivfflat (embedding vector_cosine_ops) with (lists = 100);

create table if not exists work.relations (
  id            uuid primary key default gen_random_uuid(),
  from_memory   uuid not null references work.memory (id) on delete cascade,
  to_memory     uuid not null references work.memory (id) on delete cascade,
  relation_type text not null,                    -- 'references' | 'supersedes' | ...
  confidence    text not null check (confidence in ('EXTRACTED', 'INFERRED', 'AMBIGUOUS')),
  written_at    timestamptz not null default now(),
  written_by    text not null default 'scheduled_pass' -- batch job identifier, never "live"
);
create index if not exists idx_work_relations_from on work.relations (from_memory);
create index if not exists idx_work_relations_to on work.relations (to_memory);

-- ------------------------------------------------------------ personal --
create schema if not exists personal;

create table if not exists personal.capabilities (
  id             uuid primary key default gen_random_uuid(),
  name           text not null unique,          -- e.g. 'hotmail-outlook'
  enabled        boolean not null default true,
  priority       integer not null default 100,
  schema_def     jsonb not null default '{}',
  system_prompt  text,
  tool_config    jsonb not null default '{}',
  model_override text,
  credential_ref text,
  module_path    text not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists personal.memory (
  id          uuid primary key default gen_random_uuid(),
  content     text not null,
  embedding   vector(1536),
  source      text,
  metadata    jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index if not exists idx_personal_memory_embedding
  on personal.memory using ivfflat (embedding vector_cosine_ops) with (lists = 100);

create table if not exists personal.relations (
  id            uuid primary key default gen_random_uuid(),
  from_memory   uuid not null references personal.memory (id) on delete cascade,
  to_memory     uuid not null references personal.memory (id) on delete cascade,
  relation_type text not null,
  confidence    text not null check (confidence in ('EXTRACTED', 'INFERRED', 'AMBIGUOUS')),
  written_at    timestamptz not null default now(),
  written_by    text not null default 'scheduled_pass'
);
create index if not exists idx_personal_relations_from on personal.relations (from_memory);
create index if not exists idx_personal_relations_to on personal.relations (to_memory);

-- =========================================================================
-- Roles: one login role per domain, each grantable ONLY on its own schema
-- plus read/write on `core.domain_health_snapshots` /
-- `core.reviewer_proposals` (operational metadata, safe to share). This is
-- the resolved answer to the "Supabase project-per-domain vs single
-- Postgres with separated schemas/roles" open question — see
-- docs/architecture.md. Passwords are set out-of-band (see
-- docker-compose.yml / .env), never hardcoded here.
-- =========================================================================
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'jarvis_work') then
    create role jarvis_work login password 'change_me_work';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'jarvis_personal') then
    create role jarvis_personal login password 'change_me_personal';
  end if;
end
$$;

-- Each domain role OWNS its own schema and tables (not just DML-granted) —
-- needed so the apply-migration script (src/core/scriptRegistry.ts) can run
-- real DDL (ALTER TABLE, etc.) as that domain's own role, without ever
-- needing superuser credentials in the running process. This does not
-- weaken isolation: jarvis_work still has zero grants anywhere in schema
-- `personal`, and vice versa — ownership is scoped exactly like everything
-- else. The actual control on schema changes is the approval gate
-- (apply-migration is requires_approval tier), not the role's privilege
-- level. Safe to re-run: ALTER ... OWNER TO is idempotent, and this also
-- fixes ownership on a database that was provisioned before this change
-- (tables created by the `postgres` superuser during initial setup).
alter schema work owner to jarvis_work;
alter table work.capabilities owner to jarvis_work;
alter table work.memory owner to jarvis_work;
alter table work.relations owner to jarvis_work;

alter schema personal owner to jarvis_personal;
alter table personal.capabilities owner to jarvis_personal;
alter table personal.memory owner to jarvis_personal;
alter table personal.relations owner to jarvis_personal;

-- `core` stays owned by the superuser — domain roles get DML only, never
-- DDL, on the shared operational-metadata tables (they never need schema
-- changes there; migrations are domain-scoped only, per db/migrations/).
grant usage on schema core to jarvis_work, jarvis_personal;
grant select, insert on core.domain_health_snapshots, core.reviewer_proposals, core.script_runs, core.applied_migrations
  to jarvis_work, jarvis_personal;
grant update on core.reviewer_proposals, core.script_runs to jarvis_work, jarvis_personal;

-- jarvis_work has no grants on schema personal, and vice versa: the
-- database itself refuses cross-domain reads even if application code has
-- a bug, which is the point.
