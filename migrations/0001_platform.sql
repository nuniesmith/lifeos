-- Platform tables: households, users, sessions, invites, audit, settings.
--
-- Conventions (plan §6): application-generated UUID primary keys, household
-- scoping, provenance columns on domain tables, recoverable deletion via
-- archived_at, and updated_at for optimistic concurrency.

create extension if not exists pgcrypto;
-- Usernames and emails compare case-insensitively; citext keeps that in the
-- database rather than depending on every query remembering to lower().
create extension if not exists citext;

-- ─── shared trigger ────────────────────────────────────────────────────────
-- updated_at is maintained by the database so a repository that forgets it
-- cannot silently break optimistic concurrency.
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

-- ─── households ────────────────────────────────────────────────────────────
create table households (
    id           uuid primary key default gen_random_uuid(),
    name         text        not null check (length(trim(name)) between 1 and 120),
    timezone     text        not null default 'America/Toronto',
    currency     char(3)     not null default 'CAD',
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

create trigger households_updated_at before update on households
    for each row execute function set_updated_at();

-- ─── users ─────────────────────────────────────────────────────────────────
create table users (
    id                    uuid primary key default gen_random_uuid(),
    username              citext,
    email                 citext,
    display_name          text        not null check (length(trim(display_name)) between 1 and 120),
    role                  text        not null check (role in ('admin', 'member')),

    password_hash         text        not null,
    -- Parameters travel with the hash so they can be raised later without
    -- invalidating existing credentials.
    password_algo         text        not null default 'scrypt',
    password_updated_at   timestamptz not null default now(),

    -- The bootstrap account must change its credentials before it can do
    -- anything else. This is the flag the guard reads.
    must_change_credentials boolean   not null default false,
    is_bootstrap          boolean     not null default false,

    disabled_at           timestamptz,
    failed_login_count    integer     not null default 0,
    locked_until          timestamptz,
    last_login_at         timestamptz,

    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now()
);

-- Username is optional only until the bootstrap account picks one; it must be
-- unique whenever present.
create unique index users_username_key on users (username) where username is not null;
create unique index users_email_key    on users (email)    where email    is not null;

-- At most one bootstrap account may exist at a time.
create unique index users_single_bootstrap on users ((true)) where is_bootstrap;

create trigger users_updated_at before update on users
    for each row execute function set_updated_at();

-- ─── household membership ──────────────────────────────────────────────────
create table household_members (
    household_id uuid        not null references households(id) on delete cascade,
    user_id      uuid        not null references users(id)      on delete cascade,
    joined_at    timestamptz not null default now(),
    primary key (household_id, user_id)
);

create index household_members_user on household_members (user_id);

-- ─── sessions ──────────────────────────────────────────────────────────────
-- Only a SHA-256 hash of the opaque token is stored, so a database disclosure
-- does not hand over usable sessions.
create table sessions (
    id             uuid        primary key default gen_random_uuid(),
    user_id        uuid        not null references users(id) on delete cascade,
    token_hash     bytea       not null unique,
    created_at     timestamptz not null default now(),
    last_seen_at   timestamptz not null default now(),
    idle_expires_at     timestamptz not null,
    absolute_expires_at timestamptz not null,
    revoked_at     timestamptz,
    revoked_reason text,
    user_agent     text,
    client_ip      inet
);

create index sessions_user   on sessions (user_id);
-- Supports the expiry sweep without scanning revoked rows.
create index sessions_expiry on sessions (absolute_expires_at) where revoked_at is null;

-- ─── invites ───────────────────────────────────────────────────────────────
create table invites (
    id          uuid        primary key default gen_random_uuid(),
    token_hash  bytea       not null unique,
    role        text        not null check (role in ('admin', 'member')),
    household_id uuid       not null references households(id) on delete cascade,
    created_by  uuid        references users(id) on delete set null,
    created_at  timestamptz not null default now(),
    expires_at  timestamptz not null,
    accepted_at timestamptz,
    accepted_by uuid        references users(id) on delete set null,
    revoked_at  timestamptz
);

create index invites_open on invites (expires_at)
    where accepted_at is null and revoked_at is null;

-- ─── auth audit ────────────────────────────────────────────────────────────
-- Append-only by convention; the runtime role has no delete grant (see 0003).
create table auth_audit (
    id         bigserial   primary key,
    at         timestamptz not null default now(),
    event      text        not null,
    user_id    uuid        references users(id) on delete set null,
    actor_id   uuid        references users(id) on delete set null,
    client_ip  inet,
    user_agent text,
    -- Never place credentials, tokens, or personal record content here.
    detail     jsonb       not null default '{}'::jsonb
);

create index auth_audit_at   on auth_audit (at desc);
create index auth_audit_user on auth_audit (user_id, at desc);

-- ─── change log ────────────────────────────────────────────────────────────
-- Destructive and administrative operations, separate from auth events.
create table change_log (
    id           bigserial   primary key,
    at           timestamptz not null default now(),
    household_id uuid        references households(id) on delete set null,
    actor_id     uuid        references users(id) on delete set null,
    action       text        not null,
    entity_type  text,
    entity_id    uuid,
    detail       jsonb       not null default '{}'::jsonb
);

create index change_log_at     on change_log (at desc);
create index change_log_entity on change_log (entity_type, entity_id);

-- ─── application settings ──────────────────────────────────────────────────
create table app_settings (
    key        text        primary key,
    value      jsonb       not null,
    updated_at timestamptz not null default now(),
    updated_by uuid        references users(id) on delete set null
);

create trigger app_settings_updated_at before update on app_settings
    for each row execute function set_updated_at();
