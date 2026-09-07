-- People, wishlist, watchlist and bills (MODEL-002, feature pack 4).
--
-- Four small tables that belong together because they reference each other:
-- a wishlist item is FOR someone, and a subscription is a bill that is also a
-- streaming service the watchlist points at. Modelling them separately and
-- linking them afterwards would have meant four migrations and three
-- half-finished pages.
--
-- What is deliberately NOT here: Master Dashboards (29 rows), System Status
-- (1) and the rollup columns on Years and Months. Those are Notion's own page
-- furniture and derived formulas — navigation bars, widgets, "Dominant Mood",
-- "Habit Consistency" — not household data. They are replaced by real pages
-- and real queries rather than imported, so roughly 44 of the rows that looked
-- unmapped were never records at all.

-- ─── people, places and pets ───────────────────────────────────────────────

create table people (
    id               uuid primary key default gen_random_uuid(),
    household_id     uuid not null references households(id) on delete cascade,
    owner_user_id    uuid references users(id) on delete set null,
    visibility       visibility_kind not null default 'household',

    name             text not null check (length(trim(name)) between 1 and 200),
    -- The source's "What?" column: Me, Person, Place, Pet.
    kind             text not null default 'person'
                     check (kind in ('me', 'person', 'place', 'pet')),
    -- Family, Friends, Work. An array because someone is often both.
    groups           text[] not null default '{}',
    birthday         date,
    notes            text,

    notion_page_id   uuid unique,
    source_record_id uuid references source_records(id) on delete set null,

    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    created_by       uuid references users(id) on delete set null,
    updated_by       uuid references users(id) on delete set null,
    archived_at      timestamptz
);

create unique index people_name_idx on people (household_id, lower(trim(name)));
create index people_groups_idx on people using gin (groups);

-- ─── the wishlist ──────────────────────────────────────────────────────────

create table wishlist_items (
    id               uuid primary key default gen_random_uuid(),
    household_id     uuid not null references households(id) on delete cascade,
    owner_user_id    uuid references users(id) on delete set null,
    visibility       visibility_kind not null default 'household',

    name             text not null check (length(trim(name)) between 1 and 300),
    item_type        text,
    status           text not null default 'wanted'
                     check (status in ('wanted', 'bought', 'given', 'declined')),
    -- "$$$$$ - $500+" is a bracket, not a number: the source records a range
    -- because most of these have never been priced.
    price_range      text,
    purpose          text,
    shop_source      text,
    url              text,
    occasion         text,
    -- Who it is for. A gift with no recipient is a note to self, which is why
    -- this is nullable rather than required.
    for_person_id    uuid references people(id) on delete set null,
    is_favourite     boolean not null default false,
    buy_again        boolean not null default false,

    notion_page_id   uuid unique,
    source_record_id uuid references source_records(id) on delete set null,

    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    created_by       uuid references users(id) on delete set null,
    updated_by       uuid references users(id) on delete set null,
    archived_at      timestamptz
);

create index wishlist_person_idx on wishlist_items (for_person_id)
    where for_person_id is not null;

-- ─── the watchlist ─────────────────────────────────────────────────────────

create table media_items (
    id               uuid primary key default gen_random_uuid(),
    household_id     uuid not null references households(id) on delete cascade,
    owner_user_id    uuid references users(id) on delete set null,
    visibility       visibility_kind not null default 'household',

    name             text not null check (length(trim(name)) between 1 and 300),
    media_type       text not null default 'other'
                     check (media_type in ('movie', 'tv', 'other')),
    status           text not null default 'want_to_watch'
                     check (status in ('want_to_watch', 'watching', 'watched', 'paused', 'dropped')),
    -- The source stores this as "★★★★★"; stars are a count, so it is one here.
    rating           integer check (rating is null or rating between 1 and 5),
    genre            text,
    streaming_service text,
    release_year     integer check (release_year is null or release_year between 1850 and 2200),
    total_seasons    integer check (total_seasons is null or total_seasons >= 0),
    current_season   integer check (current_season is null or current_season >= 0),
    current_episode  integer check (current_episode is null or current_episode >= 0),
    times_watched    integer not null default 0 check (times_watched >= 0),
    why_saved        text,
    is_favourite     boolean not null default false,
    watch_again      boolean not null default false,
    started_on       date,
    finished_on      date,
    last_watched_at  timestamptz,

    notion_page_id   uuid unique,
    source_record_id uuid references source_records(id) on delete set null,

    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    created_by       uuid references users(id) on delete set null,
    updated_by       uuid references users(id) on delete set null,
    archived_at      timestamptz
);

create index media_items_status_idx on media_items (household_id, status)
    where archived_at is null;

-- ─── bills and subscriptions ───────────────────────────────────────────────

create table bills (
    id               uuid primary key default gen_random_uuid(),
    household_id     uuid not null references households(id) on delete cascade,
    owner_user_id    uuid references users(id) on delete set null,
    visibility       visibility_kind not null default 'household',

    name             text not null check (length(trim(name)) between 1 and 200),
    -- The source writes "CA$14.99": the amount and its currency are separate
    -- facts, and a household that ever pays for one thing in USD needs them
    -- apart rather than embedded in a string.
    amount           numeric(12, 2) check (amount is null or amount >= 0),
    currency         text not null default 'CAD' check (length(currency) = 3),
    frequency        text check (frequency is null or frequency in
                         ('weekly', 'biweekly', 'monthly', 'quarterly', 'annual', 'one_off')),
    next_due_on      date,
    category         text,
    account          text,
    autopay          boolean not null default false,
    status           text not null default 'active'
                     check (status in ('active', 'free_trial', 'paused', 'cancelled')),
    free_trial_ends_on date,
    notes            text,

    notion_page_id   uuid unique,
    source_record_id uuid references source_records(id) on delete set null,

    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    created_by       uuid references users(id) on delete set null,
    updated_by       uuid references users(id) on delete set null,
    archived_at      timestamptz
);

-- "What is due next" is the only question this table is asked.
create index bills_due_idx on bills (household_id, next_due_on)
    where archived_at is null and status in ('active', 'free_trial');
