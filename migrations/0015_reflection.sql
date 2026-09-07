-- Perspectives and the year in review (MODEL-002, feature pack 5).
--
-- Two small tables, and a deliberate omission.
--
-- The source's Years and Months databases are almost entirely rollups —
-- "Dominant Mood", "Habit Consistency", "Total Days Logged", "Average
-- Activation". Those are questions about daily_logs and habit_logs, which this
-- database already holds, so importing them would create a second copy of an
-- answer that goes stale the moment a day is edited. The yearly review
-- computes them instead. What Years and Months genuinely carry — a start date
-- and a number — is derivable from the year itself.
--
-- What is left is the two things the source records rather than derives: a
-- periodic self-rating of each life area, and the events worth remembering.

-- ─── the wheel of life ─────────────────────────────────────────────────────

create table life_assessments (
    id               uuid primary key default gen_random_uuid(),
    household_id     uuid not null references households(id) on delete cascade,
    owner_user_id    uuid references users(id) on delete set null,
    -- A self-rating is a personal judgement, so it defaults to private even
    -- though the area it is about is shared.
    visibility       visibility_kind not null default 'private',

    -- What the person named, which is not always the area's own name: the area
    -- is "Finances" and the focus that year was "Financial Stability".
    focus            text not null check (length(trim(focus)) between 1 and 200),
    area_id          uuid references areas(id) on delete set null,
    rating           integer not null check (rating between 1 and 10),
    -- "Start of Year", "Mid Year". Free text: it is the household's own
    -- cadence, and a new one should not need a migration.
    period           text,
    year             integer check (year is null or year between 1900 and 2200),
    is_priority      boolean not null default false,
    notes            text,

    notion_page_id   uuid unique,
    source_record_id uuid references source_records(id) on delete set null,

    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    created_by       uuid references users(id) on delete set null,
    updated_by       uuid references users(id) on delete set null,
    archived_at      timestamptz
);

create index life_assessments_period_idx
    on life_assessments (household_id, year desc, period)
    where archived_at is null;

-- ─── significant events ────────────────────────────────────────────────────
--
-- Not folded into `important_dates`, which is prospective — birthdays and
-- anniversaries that recur and need reminding about. These are retrospective:
-- things that happened once and are worth remembering, which is a different
-- question and a different page.

create table significant_events (
    id               uuid primary key default gen_random_uuid(),
    household_id     uuid not null references households(id) on delete cascade,
    owner_user_id    uuid references users(id) on delete set null,
    visibility       visibility_kind not null default 'household',

    title            text not null check (length(trim(title)) between 1 and 300),
    on_date          date not null,
    area_id          uuid references areas(id) on delete set null,
    is_favourite     boolean not null default false,
    notes            text,

    notion_page_id   uuid unique,
    source_record_id uuid references source_records(id) on delete set null,

    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    created_by       uuid references users(id) on delete set null,
    updated_by       uuid references users(id) on delete set null,
    archived_at      timestamptz
);

create index significant_events_date_idx on significant_events (household_id, on_date desc)
    where archived_at is null;
