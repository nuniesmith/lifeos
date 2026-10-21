-- Calendar sync with Google and CalDAV (iCloud) (migration 0041).
--
-- Kayla keeps her own calendars in BOTH Google and iCloud; the operator uses
-- none (decided 2026-10-06). LifeOS reads her calendars, so their events show
-- on its calendar, and writes LifeOS's own dated items -- tasks, medical
-- visits, bills and important dates -- to one "LifeOS" calendar in her Google
-- account, which her phone shows beside the rest. This first version reads
-- external events and never edits them; LifeOS items flow one way, LifeOS to
-- Google.
--
--  * calendar_connections: one person's account at one provider. Google needs
--    no per-person secret: a service account, configured on the server, that
--    the person shares calendars with. CalDAV (iCloud, or any CalDAV server)
--    needs a password -- for iCloud an app-specific one -- stored encrypted
--    with the server's LIFEOS_SECRET_KEY, never in the clear.
--  * calendar_sources: a calendar inside a connection, what LifeOS does with
--    it (reads it, writes to it), and the provider's sync token.
--  * calendar_events: the provider's events as the provider has them --
--    recurring series, their moved or cancelled instances, and one-offs --
--    expanded into occurrences only when a page asks for a range of days, so
--    an endless series costs one row, not one per occurrence.
--  * calendar_pushes: which LifeOS item became which event in the target
--    calendar, and a hash of what was sent, so pushing is idempotent and an
--    unchanged item costs no request.
--
-- No archived_at anywhere: everything here is a copy of something that lives
-- elsewhere, so a removed connection is deleted outright, with its calendars,
-- events and pushes.

create table calendar_connections (
    id               uuid primary key default gen_random_uuid(),
    household_id     uuid not null references households(id) on delete cascade,
    owner_user_id    uuid not null references users(id) on delete cascade,
    provider         text not null check (provider in ('google', 'caldav')),
    -- CalDAV: the account's user name (an Apple ID for iCloud). Google: the
    -- service account's address, since that is the identity LifeOS reads as.
    account          text not null check (length(trim(account)) between 1 and 320),
    server_url       text check (server_url is null or server_url ~ '^https?://'),
    -- version byte, 12-byte IV, 16-byte tag, ciphertext (secret-box.ts)
    secret           bytea,
    last_synced_at   timestamptz,
    last_error       text,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    unique (owner_user_id, provider, account),
    check ((provider = 'caldav') = (secret is not null and server_url is not null))
);

create table calendar_sources (
    id               uuid primary key default gen_random_uuid(),
    connection_id    uuid not null references calendar_connections(id) on delete cascade,
    -- Google: the calendar's id. CalDAV: the calendar collection's URL.
    external_id      text not null check (length(external_id) between 1 and 2000),
    name             text not null check (length(trim(name)) between 1 and 300),
    color            text check (color is null or color ~ '^#[0-9a-fA-F]{6}$'),
    time_zone        text,
    -- Who sees this calendar's events in LifeOS: 'private' is its owner only.
    visibility       visibility_kind not null default 'private',
    import_enabled   boolean not null default true,
    -- LifeOS's own items are written here (Google calendars only, one per
    -- household: the repository enforces both).
    is_push_target   boolean not null default false,
    sync_token       text,
    last_synced_at   timestamptz,
    last_error       text,
    created_at       timestamptz not null default now(),
    unique (connection_id, external_id)
);

create table calendar_events (
    id               uuid primary key default gen_random_uuid(),
    source_id        uuid not null references calendar_sources(id) on delete cascade,
    -- Google: the event's id. CalDAV: the object's URL, which a series shares
    -- with its moved instances; recurrence_id tells those apart.
    external_id      text not null,
    -- The original start of the instance this row replaces, in the same
    -- form as start_local; '' for a series or a one-off, so the key below
    -- holds (a null would make every series row distinct).
    recurrence_id    text not null default '',
    uid              text not null,
    etag             text,
    status           text not null default 'confirmed'
                          check (status in ('confirmed', 'tentative', 'cancelled')),
    summary          text not null default '',
    location         text,
    all_day          boolean not null,
    -- Wall-clock 'YYYY-MM-DDTHH:MM:SS' in time_zone for a timed event, or
    -- 'YYYY-MM-DD' for an all-day one, whose end is exclusive. A series
    -- recurs in wall-clock time, so its 9 am stays 9 am across a DST change;
    -- storing instants would move it by an hour twice a year.
    start_local      text not null,
    end_local        text not null,
    -- An IANA zone, 'UTC', or null for a floating time (read in the
    -- household's zone).
    time_zone        text,
    rrule            text,
    exdates          text[] not null default '{}',
    rdates           text[] not null default '{}',
    -- Set on the events LifeOS pushed itself, so reading the target calendar
    -- back doesn't show every LifeOS item twice.
    lifeos_key       text,
    remote_updated_at timestamptz,
    synced_at        timestamptz not null default now(),
    unique (source_id, external_id, recurrence_id)
);

create table calendar_pushes (
    source_id        uuid not null references calendar_sources(id) on delete cascade,
    lifeos_key       text not null,
    external_id      text not null,
    content_hash     text not null,
    pushed_at        timestamptz not null default now(),
    primary key (source_id, lifeos_key)
);
