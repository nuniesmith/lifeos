-- Routines & their steps (MODEL-0??, Routines feature pack).
--
-- "Habits & Routines" in the source is two Notion databases, and LifeOS
-- already has the first half: habits (migration 0004). This is the second --
-- a Routine is a named sequence done at a time of day ("Morning"); its steps
-- are the interesting part, because each one is written three times, for
-- three energy levels (a high-energy day, an average one, and the "1% day"
-- version: the smallest thing that still counts). The routine itself never
-- has to change for someone to still do a version of it on a bad day.
--
-- Purely additive, and there is no importer for it: the source export is
-- read-only household data (see base.ts's header, rule against touching
-- `data/`), and the household is re-entering its own routines by hand rather
-- than this migration moving rows the way 0018 moved medications out of
-- health_vocabulary -- so there is no data migration step below, only the two
-- new tables and their log.

-- ─── routines ───────────────────────────────────────────────────────────────
-- A full domain record, copied from `habits` (migration 0004): household
-- scoping, an optional owner, visibility, provenance, and the audit columns.
create table routines (
    id               uuid primary key default gen_random_uuid(),
    household_id     uuid not null references households(id) on delete cascade,
    owner_user_id    uuid references users(id) on delete set null,
    visibility       visibility_kind not null default 'household',

    name             text not null check (length(trim(name)) between 1 and 200),
    -- Markdown, rendered with `renderMarkdown` the same way a recipe's method is.
    notes            text,
    time_of_day      text not null default 'anytime'
                          check (time_of_day in ('morning', 'afternoon', 'evening', 'anytime')),
    -- The order routines are listed in. No uniqueness of its own: ties are
    -- harmless (routines are also grouped by time_of_day before this applies),
    -- unlike `routine_steps.position` below, which a "do it now" view walks in
    -- order and so cannot tolerate a duplicate.
    sort_order       integer not null default 0,

    notion_page_id   uuid unique,
    source_record_id uuid references source_records(id) on delete set null,

    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    created_by       uuid references users(id) on delete set null,
    updated_by       uuid references users(id) on delete set null,
    archived_at      timestamptz
);

-- No updated_at trigger: only migration 0004's own tables have one (see
-- base.ts's header). Every UPDATE here sets updated_at itself.
create index routines_household on routines (household_id) where archived_at is null;

-- ─── routine steps ──────────────────────────────────────────────────────────
-- A routine's steps, scoped through it exactly the way `medication_doses` is
-- scoped through `medications` (migration 0018): no household_id, owner or
-- visibility of its own. A step is not a record anyone owns independently of
-- the routine it belongs to, so every read and write reaches it by joining
-- `routines`, where the real scope lives.
create table routine_steps (
    id               uuid primary key default gen_random_uuid(),
    routine_id       uuid not null references routines(id) on delete cascade,
    -- Live steps occupy a contiguous 1..N per routine -- the repository
    -- compacts this on archive and appends on add, so "position order" is
    -- always just `order by position`. An archived step keeps whatever
    -- position it had; the partial index below deliberately stops counting it,
    -- which is what lets a later live step reuse that same number without it
    -- being a collision.
    position         integer not null,

    title            text not null check (length(trim(title)) between 1 and 200),
    -- Three tellings of one step. Only the average version is required -- it
    -- is what the routine means when energy is not part of the question --
    -- and the repository falls the other two back to it when they are blank,
    -- the same way a household typing these in by hand will leave the extremes
    -- blank at first and fill them in later, if ever.
    high_version     text,
    average_version  text not null check (length(trim(average_version)) > 0),
    minimal_version  text,
    duration_minutes integer check (duration_minutes is null or duration_minutes > 0),

    -- Whether the viewer setting this may actually read the habit it names is
    -- checked in the same statement that writes it (repositories/routines.ts),
    -- not here -- a CHECK constraint has no access to a Viewer, and household
    -- isolation plus the other member's private habits are exactly the rule
    -- this column must not let someone route around.
    habit_id         uuid references habits(id) on delete set null,

    archived_at      timestamptz,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    created_by       uuid references users(id) on delete set null,
    updated_by       uuid references users(id) on delete set null
);

-- Unique among LIVE steps only. See the column comment above for why an
-- archived row is excluded rather than renumbered.
create unique index routine_steps_position_idx
    on routine_steps (routine_id, position) where archived_at is null;

-- ─── routine step completions ───────────────────────────────────────────────
-- Which version of a step someone did, and when -- per person, like
-- `habit_logs`: two people sharing a routine each build their own history of
-- it, not one shared tick.
create table routine_step_completions (
    id           uuid primary key default gen_random_uuid(),
    step_id      uuid not null references routine_steps(id) on delete cascade,
    user_id      uuid not null references users(id) on delete cascade,
    -- A date on the household's own clock (base.ts's `householdToday`), never
    -- the server's -- the same discipline `habit_logs.on_date` follows.
    completed_on date not null,
    version      text not null check (version in ('high', 'average', 'minimal')),
    -- The habit check-in THIS completion recorded, if any, so undoing it
    -- removes that one and nothing else. A check-in the person had already
    -- made that day (on /habits, perhaps with a note) is left exactly as it
    -- was, both when the step is completed and when it is undone. It holds
    -- the habit's id rather than a flag because the step can be relinked to
    -- another habit in between, and undo must still reach the one it logged.
    logged_habit_id uuid references habits(id) on delete set null,
    created_at   timestamptz not null default now(),

    unique (step_id, user_id, completed_on)
);

create index routine_step_completions_date
    on routine_step_completions (step_id, completed_on desc);
