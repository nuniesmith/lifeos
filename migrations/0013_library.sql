-- The Library (MODEL-002, feature pack 3).
--
-- One table behind three pages. The source keeps a single Library database of
-- 42 entries — books, articles, podcasts, videos and loose notes — and the
-- workspace navigation shows it three times under different questions:
-- Library ("everything"), Reading ("the books I mean to get to") and the
-- Knowledge Hub ("what have I actually kept"). Splitting the storage to match
-- the navigation would mean deciding, on save, which page a thing belongs to,
-- and a podcast episode that turns into a reference does not want moving
-- between tables.
--
-- The entry carries its own tags through `entity_tags`, the same mechanism
-- tasks and projects already use, so a topic spans work and reading rather
-- than being two separate vocabularies that drift.

create table library_items (
    id               uuid primary key default gen_random_uuid(),
    household_id     uuid not null references households(id) on delete cascade,
    owner_user_id    uuid references users(id) on delete set null,
    visibility       visibility_kind not null default 'household',

    title            text not null check (length(trim(title)) between 1 and 500),
    -- The source keeps a short title and the publisher's full one separately;
    -- the long form is often unreadable in a list but worth keeping.
    full_title       text,
    author           text,
    url              text,
    summary          text,
    notes            text,

    entry_type       text not null default 'reference'
                     check (entry_type in ('book', 'note', 'reference')),
    -- Articles, Podcasts, Videos, Websites, Forms. Free text rather than a
    -- check: this is the household's own shelving, and a new medium should
    -- not need a migration.
    format           text,
    status           text not null default 'inbox'
                     check (status in ('inbox', 'reading_list', 'live', 'archived_read')),

    -- Readwise-style: how many passages were kept out of this.
    highlight_count  integer not null default 0 check (highlight_count >= 0),
    last_interaction_at timestamptz,
    is_favourite     boolean not null default false,

    notion_page_id   uuid unique,
    source_record_id uuid references source_records(id) on delete set null,

    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    created_by       uuid references users(id) on delete set null,
    updated_by       uuid references users(id) on delete set null,
    archived_at      timestamptz
);

create index library_items_status_idx on library_items (household_id, status)
    where archived_at is null;

create index library_items_type_idx on library_items (household_id, entry_type)
    where archived_at is null;

-- "What have I not looked at in a while" is the Knowledge Hub's whole
-- question, and the source computes a "Rediscover Age" for exactly it.
create index library_items_stale_idx on library_items (household_id, last_interaction_at)
    where archived_at is null;

-- Full-text search over the library, matching the expression indexes that
-- migration 0007 created for the other searchable tables.
create index library_items_search_idx on library_items
    using gin (to_tsvector('english',
        coalesce(title, '') || ' ' || coalesce(author, '') || ' ' || coalesce(summary, '')));
