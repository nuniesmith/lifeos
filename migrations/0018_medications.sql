-- Medications & supplements (MODEL-002, feature pack 3).
--
-- The source calls this "Vitamins & Medications" and models it as one
-- database: 23 rows, each a prescription, supplement, electrolyte or OTC
-- item, carrying its own dose, brand, and when it is taken. That is a real
-- record in its own right -- unlike Symptoms or Mood, a medication has a
-- dose, a brand, a start and end date, and a running-low flag someone acts
-- on at the pharmacy -- so it gets its own table rather than folding into
-- `health_vocabulary` as a seventh vocabulary kind.
--
-- `Log Today` in the source is a button, and five derived columns are
-- computed by Notion formulas rather than stored: `Due Today?`, `Last
-- Taken`, `Next Due`, `Times Logged`, `Medication Display`. `Dates Logged`
-- looks like data but is not either -- it is a rollup of the very relation
-- this migration promotes into rows (see `medication_doses` below), so it is
-- redundant with the rows themselves and reading it as a second input would
-- risk double-counting a day the relation already carries. None of the six
-- are stored; every one of them is recomputed from `medication_doses` at
-- read time, the same discipline `recipes.total_minutes` and
-- `daily_log_health`'s frequency queries already follow.

create table medications (
    id               uuid primary key default gen_random_uuid(),
    household_id     uuid not null references households(id) on delete cascade,
    owner_user_id    uuid references users(id) on delete set null,
    visibility       visibility_kind not null default 'household',

    name             text not null check (length(trim(name)) between 1 and 200),
    -- The source's own five options. A check rather than an enum for the same
    -- reason as `health_vocabulary.kind`: the household's own categories,
    -- extended by adding a value rather than a migration and a lock.
    type             text not null check (type in
                         ('prescription', 'supplement', 'vitamin', 'electrolyte', 'otc')),
    dose             text,
    unit             text,
    brand            text,

    -- When it is taken. `daily_am` / `daily_pm` mirror the source's "Daily -
    -- AM" / "Daily - PM" Routine values exactly, because the Today view groups
    -- by this column the same way the source page does.
    schedule_kind      text not null default 'as_needed' check (schedule_kind in
                           ('daily_am', 'daily_pm', 'scheduled', 'as_needed')),
    -- "a scheduled weekday OR every N days" -- the source's own Routine +
    -- Frequency + Scheduled Weekday columns never combine the two (a weekly
    -- item names its weekday; a monthly one names a cadence word instead, via
    -- Frequency, which the importer reads with the same word -> day-count
    -- table `parseReviewCadence` already uses for review cadences), so this
    -- is modelled as alternatives rather than a pair that both apply.
    -- Meaningless outside `scheduled`, and left nullable even then: this
    -- migration's own data move (below) cannot recover either one, because
    -- the pre-existing rows it reads from never stored Frequency at all.
    scheduled_weekday  integer check (scheduled_weekday is null or scheduled_weekday between 0 and 6),
    interval_days      integer check (interval_days is null or interval_days > 0),
    check (schedule_kind = 'scheduled' or (scheduled_weekday is null and interval_days is null)),
    check (scheduled_weekday is null or interval_days is null),

    start_date       date,
    end_date         date,
    -- Separate from `archived_at`: a paused prescription is still on the
    -- list (it can resume), where archiving is the "this is not coming back"
    -- shelf every other domain table already has.
    status           text not null default 'taking' check (status in ('taking', 'paused')),
    running_low      boolean not null default false,
    notes            text,
    -- Per-type extras that do not deserve a column each: the source's
    -- Electrolyte rows carry Sodium and Essential Calcium content and nothing
    -- else does. Same trade-off as `health_vocabulary.attributes` (migration
    -- 0011) -- one jsonb column beats two columns only two of five types use.
    attributes       jsonb not null default '{}'::jsonb,

    notion_page_id   uuid unique,
    source_record_id uuid references source_records(id) on delete set null,

    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    created_by       uuid references users(id) on delete set null,
    updated_by       uuid references users(id) on delete set null,
    archived_at      timestamptz
);

-- Not unique: migration 0016 already learned this lesson for ingredients,
-- people and the health vocabulary -- Notion tolerates two rows with the same
-- title, a unique index aborts the whole import on the first one, and the
-- name is a label to look up by, not a key. Duplicate refusal on a
-- hand-typed name belongs to `createMedication` instead.
create index medications_name_idx
    on medications (household_id, lower(trim(name)));

-- The Today view's whole query: everything due this slot, grouped the way
-- the source page groups it.
create index medications_schedule_idx
    on medications (household_id, schedule_kind) where archived_at is null;

-- A dose taken or logged. Deliberately not scoped to a `daily_logs` row the
-- way `daily_log_health` is: a household member taking their morning pills
-- should not first require a journal entry for the day, and the source
-- itself has no such dependency -- `Log Today` works whether or not that
-- day's Daily Log page exists yet.
--
-- No household/owner/visibility/notion_page_id/source_record_id/audit block:
-- a dose is a fact about a medication and a day, not an owned document, and
-- it inherits its household scope from `medications` by join -- the same
-- shape `daily_log_health` already uses for the same reason.
create table medication_doses (
    id            uuid primary key default gen_random_uuid(),
    medication_id uuid not null references medications(id) on delete cascade,
    on_date       date not null,
    -- Three, not four: "Scheduled" and "As Needed" items have no AM/PM
    -- distinction in the source, so both log as `adhoc`. Stored rather than
    -- read off `medications.schedule_kind` at query time so a dose's own
    -- history stays correct even if the medication's schedule is edited
    -- later.
    slot          text not null check (slot in ('am', 'pm', 'adhoc')),
    -- Null when only the day is known, which is everything the importer can
    -- ever supply -- the source relation names a day, not a time.
    taken_at      timestamptz,
    note          text,
    created_at    timestamptz not null default now(),
    created_by    uuid references users(id) on delete set null,

    -- One dose per medication per day per slot. This is also what makes
    -- "tap taken" idempotent and matches the source's own ceiling: Notion's
    -- relation can link a medication to a Daily Log page at most once, so a
    -- second same-day PRN dose is not a distinction the source ever made
    -- either.
    unique (medication_id, on_date, slot)
);

create index medication_doses_medication_idx on medication_doses (medication_id, on_date desc);

-- ─── move the vitamin vocabulary here ──────────────────────────────────────
--
-- Before this migration, "Vitamins & Medications" imported as
-- `health_vocabulary` rows of kind 'vitamin' (a `vocabularyMapper` catch-all
-- that only ever read the row's name, page body and "Running Low" -- Type,
-- Dose, Unit, Brand, Routine, Frequency, and the start/end dates were columns
-- the old mapper never looked at, because the vocabulary model has nowhere to
-- put them). Existing rows are moved rather than copied-and-kept: leaving a
-- second, unmaintained representation around is exactly the kind of stale
-- duplicate this whole migration exists to avoid, and every row here is
-- about to gain a live, re-importable home.
--
-- The id is carried across unchanged. That turns "move the daily_log_health
-- links too" into a plain join on the id that used to be the vocabulary's and
-- is now the medication's, with no id-mapping table, and it means the very
-- next Notion export upserts these same rows by `notion_page_id` rather than
-- creating duplicates.
--
-- What the old rows never had -- type, schedule, dose, brand, dates -- cannot
-- be recovered by SQL; it only exists in the CSV, not in the database this
-- migration runs against. `type` defaults to 'vitamin' (the blanket kind
-- every one of these rows already carried) and `schedule_kind` defaults to
-- 'as_needed' (the reading that asserts the least -- it does not claim a
-- daily routine or a schedule the source never confirmed). Both are
-- overwritten with the real values the moment this household's next export
-- is imported, because the mapper upserts by `notion_page_id`.
--
-- `health_vocabulary.kind` still lists 'vitamin' as a legal value after this
-- migration. Removing it would mean editing the check constraint AND
-- `/health`'s page component, and that page belongs to a sibling change
-- landing on this branch's neighbour; narrowing the enum here would fight
-- that merge for no present benefit; every existing vitamin row is gone by
-- the end of this file regardless of what the constraint still permits.
insert into medications (
    id, household_id, owner_user_id, visibility, name, type, notes, attributes,
    running_low, notion_page_id, source_record_id,
    created_at, updated_at, created_by, updated_by, archived_at
)
select
    v.id, v.household_id, v.owner_user_id, v.visibility, v.name, 'vitamin', v.notes, v.attributes,
    coalesce(v.attributes ->> 'Running Low', 'No') = 'Yes',
    v.notion_page_id, v.source_record_id,
    v.created_at, v.updated_at, v.created_by, v.updated_by, v.archived_at
from health_vocabulary v
where v.kind = 'vitamin';

-- Every day a moved medication was logged against, carried into a dose. The
-- slot is `adhoc` for all of them because the default `schedule_kind` set
-- above is `as_needed` -- consistent with that default, and corrected the
-- same way once a real Routine is imported.
insert into medication_doses (medication_id, on_date, slot, created_at)
select dlh.vocabulary_id, dl.on_date, 'adhoc', dlh.created_at
from daily_log_health dlh
join daily_logs dl on dl.id = dlh.daily_log_id
-- Restricts to exactly the rows just moved: `medications` had no other rows
-- before this migration, so a match here only ever means "this vocabulary id
-- is now a medication id".
join medications m on m.id = dlh.vocabulary_id
on conflict (medication_id, on_date, slot) do nothing;

-- The cascade on `daily_log_health.vocabulary_id` removes its links to these
-- rows in the same statement; every one of those links was already copied
-- above, so nothing here is lost, only de-duplicated.
delete from health_vocabulary where kind = 'vitamin';
