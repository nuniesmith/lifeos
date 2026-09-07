-- Health (MODEL-002, feature pack 1).
--
-- The source workspace does not model health as its own records. The Daily Log
-- is the hub: it carries scalar readings as columns, and relates out to small
-- vocabularies — Symptoms, Mood/Feelings, Vitamins, Energy Level, Activity,
-- Exercise — each of which is a list of named things that get logged against a
-- day. Seven Notion databases, 88 rows, and not one of them is a record about
-- a day; they are the words used to describe days.
--
-- So this is two tables rather than seven: a vocabulary, and the link that
-- says a word applied to a day. Adding a new kind of thing to track then costs
-- a row, not a migration.
--
-- Privacy falls out of the shape. The link hangs off `daily_logs`, which is
-- owner-scoped and private by default, so what a person logged is theirs
-- automatically — the same treatment search already gives journal entries. The
-- vocabulary itself defaults to household: a shared list of words is useful,
-- and knowing the word "Nausea" exists discloses nothing about who felt it.

create table health_vocabulary (
    id               uuid primary key default gen_random_uuid(),
    household_id     uuid not null references households(id) on delete cascade,
    owner_user_id    uuid references users(id) on delete set null,
    visibility       visibility_kind not null default 'household',

    -- Which list this word belongs to. Extended by adding a value here, which
    -- is deliberately a check rather than an enum: an enum needs a migration
    -- and a lock to extend, and these are the household's own categories.
    kind             text not null check (kind in (
                         'symptom', 'mood', 'vitamin', 'energy', 'activity', 'exercise'
                     )),
    name             text not null check (length(trim(name)) between 1 and 200),
    notes            text,
    -- Per-kind extras that do not deserve a column each: the Energy Level rows
    -- carry an approach, a mantra and what to watch for; Mood carries a type
    -- and what helps. Six columns used by two kinds is worse than this.
    attributes       jsonb not null default '{}'::jsonb,

    notion_page_id   uuid unique,
    source_record_id uuid references source_records(id) on delete set null,

    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    created_by       uuid references users(id) on delete set null,
    updated_by       uuid references users(id) on delete set null,
    archived_at      timestamptz
);

-- One "Nausea" per household per list. Case-insensitive, because a second
-- "nausea" is a duplicate a person would never intend and would then have to
-- reconcile by hand across every day already logged.
create unique index health_vocabulary_name_idx
    on health_vocabulary (household_id, kind, lower(trim(name)));

create index health_vocabulary_kind_idx
    on health_vocabulary (household_id, kind) where archived_at is null;

-- What was logged on a day.
create table daily_log_health (
    daily_log_id  uuid not null references daily_logs(id) on delete cascade,
    vocabulary_id uuid not null references health_vocabulary(id) on delete cascade,
    -- Free text for the one that needs it: "back pain — worse sitting".
    detail        text,
    created_at    timestamptz not null default now(),

    primary key (daily_log_id, vocabulary_id)
);

create index daily_log_health_vocabulary_idx on daily_log_health (vocabulary_id);

-- The scalar readings the Daily Log carries directly. All nullable: a day with
-- no blood pressure taken is the normal case, not missing data.
alter table daily_logs
    add column blood_glucose          numeric(4, 1) check (blood_glucose is null or blood_glucose > 0),
    add column systolic_bp            integer check (systolic_bp is null or systolic_bp between 40 and 300),
    add column diastolic_bp           integer check (diastolic_bp is null or diastolic_bp between 20 and 200),
    add column heart_rate             integer check (heart_rate is null or heart_rate between 20 and 250),
    add column heart_rate_variability integer check (heart_rate_variability is null or heart_rate_variability >= 0),
    add column sleep_score            integer check (sleep_score is null or sleep_score between 0 and 100),
    -- Ounces, matching what the source recorded.
    add column water                  integer check (water is null or water >= 0),
    add column caffeine               boolean,
    add column carbonation            boolean,
    add column intimacy               boolean,
    -- Both are 1-5 self-reports, like the energy_level already here.
    add column activation             integer check (activation is null or activation between 1 and 5),
    add column effectiveness          integer check (effectiveness is null or effectiveness between 1 and 5),
    add column head_space             text;
