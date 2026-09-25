-- Health Measurements (MODEL-002, feature pack).
--
-- Notion split Systolic BP / Diastolic BP / Heart Rate / Blood Glucose out of
-- the Daily Log database and gave them a database of their own, alongside
-- Weight, a QT Interval, and the two context selects ("Fasting", "Random -
-- Sitting", and so on) that say how a reading was taken. The Daily Log kept
-- only Heart Rate Variability -- overnight autonomic-nervous-system data from
-- a wearable, not a spot reading someone takes and writes down, so it is a
-- different kind of thing than the four that left.
--
-- LifeOS follows the source and finishes the move the source only started:
-- this migration adds the new table AND relocates the data, so a reading
-- lives in exactly one place rather than being importable into two.
-- `daily_logs` stops being a health-readings table; `health_measurements`
-- becomes the only one, free to hold more than one reading a day and things
-- `daily_logs` never modelled at all (Weight, QT Interval).
--
-- ─── measured_at: a time of day the old data never recorded ────────────────
--
-- Every reading imported from the new Health Measurements database carries
-- its own "Date & Time" (see the importer mapper), but the four readings
-- already sitting on `daily_logs` only ever had a DATE -- `on_date`, with no
-- time of day at all. `measured_at` is `timestamptz not null`, so migrating
-- them means choosing a wall-clock time to anchor to.
--
-- Noon in the household's own zone (`households.timezone`), not midnight.
-- Midnight is the trap: converting a local midnight to UTC moves it into the
-- PREVIOUS UTC day for every zone west of Greenwich, including this
-- household's -- the same class of bug `sourceInstant` (promote.ts) exists to
-- avoid on the way IN, met here on the way a stored instant gets read back.
-- Noon sits twelve hours from either boundary, so `on_date` survives being
-- re-derived as a calendar day in the household's own zone, in UTC, or in any
-- zone within about half a day of Toronto -- which covers every zone anyone in
-- this two-person household will ever actually view the app from.
--
-- ─── daily_logs stops being a source, not just a mirror ────────────────────
--
-- `upsertDailyLogs` (promote.ts) is edited in this same change to stop writing
-- these four columns, and `recentVitals` (health.ts) to stop reading them --
-- both belong to health_measurements from here on. The four columns are then
-- DROPPED below, in the same migration as the backfill that empties them of
-- anything worth keeping. Leaving them in place unused would be worse than a
-- derived column (the rule migration 0012 already applies to stored totals):
-- a derived column is at least labelled as such, where a column nobody writes
-- anymore just quietly goes stale and nothing marks it. Heart Rate
-- Variability is untouched -- it never moved.
--
-- `carryForwardRemovedColumns` (promote.ts) would otherwise reintroduce
-- "Systolic BP" and friends into a staged Daily Log row on every future
-- import, since the export no longer carries those columns at all. That
-- mechanism works on staged CSV text, not on what a mapper chooses to do with
-- it, so the fix belongs in the mapper: `upsertDailyLogs` no longer reads
-- those keys, carried forward or not, so nothing it never looks at can
-- resurrect a value daily_logs no longer has a column for.
create table health_measurements (
    id               uuid primary key default gen_random_uuid(),
    household_id     uuid not null references households(id) on delete cascade,
    -- Owned like `daily_logs`, not shared like `health_vocabulary`: a reading
    -- is a fact about one person's body, and private-by-default is the same
    -- treatment this app already gives a journal entry, not a shopping list.
    owner_user_id    uuid not null references users(id) on delete cascade,
    visibility       visibility_kind not null default 'private',

    measured_at      timestamptz not null,
    systolic         integer check (systolic is null or systolic between 40 and 300),
    diastolic        integer check (diastolic is null or diastolic between 20 and 200),
    -- Free text, not an enum: the source is a Notion select the household
    -- extends over time, and this migration has only ever seen one of its
    -- values in the real export -- an allow-list built from a sample of one
    -- would refuse a future reading rather than just store the option.
    bp_context       text,
    heart_rate       integer check (heart_rate is null or heart_rate between 20 and 250),
    glucose          numeric(4, 1) check (glucose is null or glucose > 0),
    glucose_context  text,
    weight           numeric(5, 1) check (weight is null or weight > 0),
    -- Milliseconds. Generous bounds: a normal QT interval is roughly
    -- 350-450ms, and the entire point of tracking it is to notice a value well
    -- outside that, so the constraint here is a sanity bound, not a norm.
    qt_interval      integer check (qt_interval is null or qt_interval between 200 and 800),
    notes            text,

    -- Which day's journal entry this reading happened alongside, if any --
    -- most readings have none (see the importer: only one of the four rows in
    -- the real export carries this relation). Set-null rather than cascade:
    -- the reading outlives the journal entry it happened to be logged near.
    daily_log_id     uuid references daily_logs(id) on delete set null,

    notion_page_id   uuid unique,
    source_record_id uuid references source_records(id) on delete set null,

    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    created_by       uuid references users(id) on delete set null,
    updated_by       uuid references users(id) on delete set null,
    archived_at      timestamptz,

    -- A measurement with nothing measured is not a row worth having; the
    -- import mapper and the "add a reading" form both refuse before either
    -- would ever produce one, and this is the backstop that holds regardless.
    check (
        systolic is not null or diastolic is not null or heart_rate is not null or
        glucose is not null or weight is not null or qt_interval is not null
    )
);

-- Every list and chart on the page reads "this person's readings, most recent
-- first"; nothing here is ever looked up by id alone.
create index health_measurements_owner_idx
    on health_measurements (owner_user_id, measured_at desc);

create index health_measurements_daily_log_idx
    on health_measurements (daily_log_id) where daily_log_id is not null;

-- ─── move the data ──────────────────────────────────────────────────────────
--
-- Every daily_logs row carrying any of the four readings becomes one
-- health_measurements row. No notion_page_id / source_record_id: these rows
-- were never a Health Measurements Notion page, and copying the Daily Log
-- page's own id would make a future lookup by page id ambiguous between two
-- tables for a page that, from here on, only ever lives in one of them.
insert into health_measurements (
    household_id, owner_user_id, visibility, measured_at,
    systolic, diastolic, heart_rate, glucose, daily_log_id,
    created_at, updated_at, archived_at
)
select
    dl.household_id, dl.owner_user_id, dl.visibility,
    (dl.on_date + time '12:00:00') at time zone h.timezone,
    dl.systolic_bp, dl.diastolic_bp, dl.heart_rate, dl.blood_glucose, dl.id,
    dl.created_at, dl.updated_at, dl.archived_at
from daily_logs dl
join households h on h.id = dl.household_id
where dl.blood_glucose is not null or dl.systolic_bp is not null
   or dl.diastolic_bp is not null or dl.heart_rate is not null;

-- ─── daily_logs stops carrying them ─────────────────────────────────────────
alter table daily_logs
    drop column blood_glucose,
    drop column systolic_bp,
    drop column diastolic_bp,
    drop column heart_rate;
