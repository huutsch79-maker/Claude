-- Adds jarvis.oauth_credentials (see db/schema.sql for the same DDL).
create table if not exists jarvis.oauth_credentials (
  credential_ref  text primary key,
  access_token    text not null,
  refresh_token   text not null,
  expires_at      timestamptz not null,
  scope           text not null,
  updated_at      timestamptz not null default now()
);

alter table jarvis.oauth_credentials owner to jarvis_app;
