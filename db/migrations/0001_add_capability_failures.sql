-- Adds jarvis.capability_failures (see db/schema.sql for the same DDL,
-- kept identical so a fresh install and an upgraded one end up the same).
create table if not exists jarvis.capability_failures (
  id           uuid primary key default gen_random_uuid(),
  capability   text not null,
  summary      text not null,
  occurred_at  timestamptz not null default now()
);
create index if not exists idx_jarvis_capability_failures_lookup
  on jarvis.capability_failures (capability, occurred_at desc);

alter table jarvis.capability_failures owner to jarvis_app;
