-- Lab results and medical visits (MODEL-002, feature pack 6).
--
-- Three source databases, joined the way the source joins them: a marker is
-- looked up once ("HbA1c", with a reference range), a result is one draw of
-- one marker on one day, and a visit is the appointment a result may have come
-- from. The source's own "Results" rollup on a marker and "Out of Range?" on a
-- result are both formulas over data this migration already stores, so neither
-- is a column here — see `rangeStatus` in the repository, computed from a
-- result's value against its marker's own reference range rather than carried
-- as a second, staler copy of the same answer.
--
-- `lab_markers` is a vocabulary, the same shape as `health_vocabulary`
-- (migration 0011): a small, mostly-stable list of named things a household
-- defines once and results point at. It gets the same treatment — household-
-- shared by default, a plain rather than a unique index on the name.
-- Migration 0016 is the reason for "plain": a unique index on a label aborts
-- an entire import transaction the moment two rows share one, which is a real
-- shape Notion data takes and not a data error.
--
-- `medical_visits` is declared before `lab_results` so the result can carry an
-- optional `medical_visit_id` — a result is often drawn without a visit (a
-- standing lab requisition), so the link is nullable rather than the visit
-- being required to have results.
--
-- Visibility: unlike `daily_log_health` (private by construction, because it
-- answers "what did this person personally notice today"), a lab result or a
-- visit is closer to `ingredients` or `recipes` than to a journal entry — a
-- fact about an appointment or a blood draw, which in a two-person household
-- caring for a chronic illness together is exactly the kind of thing a partner
-- also wants to see and can help track. So all three tables default to
-- household-shared with no owner, like the rest of migration 0011/0012's
-- vocabularies, while still carrying `owner_user_id`/`visibility` so a
-- specific record can be marked private later through the same
-- `resolveOwnership` path every other repository uses.

-- ─── lab markers ────────────────────────────────────────────────────────────

create table lab_markers (
    id               uuid primary key default gen_random_uuid(),
    household_id     uuid not null references households(id) on delete cascade,
    owner_user_id    uuid references users(id) on delete set null,
    visibility       visibility_kind not null default 'household',

    name             text not null check (length(trim(name)) between 1 and 200),
    units            text,
    -- Either bound may be absent on its own: the source has markers with only
    -- an upper bound (a marker that is only a problem when high) and markers
    -- with only a lower one. `rangeStatus` treats an absent bound as simply
    -- not tracked, never as zero.
    reference_low    numeric(10, 4),
    reference_high   numeric(10, 4),
    notes            text,

    notion_page_id   uuid unique,
    source_record_id uuid references source_records(id) on delete set null,

    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    created_by       uuid references users(id) on delete set null,
    updated_by       uuid references users(id) on delete set null,
    archived_at      timestamptz,

    check (reference_low is null or reference_high is null or reference_high >= reference_low)
);

-- Lookup, not identity (migration 0016) -- a household can have two markers
-- with the same label and an import must not abort over it.
create index lab_markers_name_idx
    on lab_markers (household_id, lower(trim(name)));

-- ─── medical visits ─────────────────────────────────────────────────────────

create table medical_visits (
    id               uuid primary key default gen_random_uuid(),
    household_id     uuid not null references households(id) on delete cascade,
    owner_user_id    uuid references users(id) on delete set null,
    visibility       visibility_kind not null default 'household',

    reason           text not null check (length(trim(reason)) between 1 and 300),
    -- A visit is an appointment, not a day: the source records a time of day
    -- ("September 25, 2026 2:40 PM"), and that is what makes "upcoming" orderable
    -- to the minute rather than just to the date. Contrast `daily_logs.on_date`
    -- and `important_dates.on_date`, which are genuinely day-level.
    visit_at         timestamptz not null,
    -- Free text rather than a checked vocabulary, like `recipes.cuisine` and
    -- `recipes.effort`: the household's own options ("Follow Up", "New
    -- Patient", ...) are not this schema's to enumerate, and a CHECK would
    -- reject a value that has not been seen yet.
    visit_type       text,
    provider         text,
    location         text,
    -- Same split as `bills.amount`/`bills.currency` (migration 0014): the
    -- source writes "CA$150.00", and the amount and its currency are separate
    -- facts even though only one currency is in use today.
    amount           numeric(12, 2) check (amount is null or amount >= 0),
    currency         text not null default 'CAD' check (length(currency) = 3),
    paid_by          text,
    -- "Bloodwork, Fasting" -- a multi-select in the source, held as an array
    -- like `recipes.courses` rather than a join table: nothing is ever said
    -- *about* a requirement on its own.
    requirements     text[] not null default '{}',
    -- The source's "Family Member" property. Kept as the plain text the export
    -- carries rather than a relation: this household has exactly the members
    -- modelled by `users`, and forcing the value onto a user id would invent a
    -- mapping the source does not state (a visit could equally be for a pet or
    -- a child with no account). `owner_user_id`/`visibility` above still carry
    -- the actual access-control "whose", the same as every other table here.
    family_member    text,
    notes            text,
    -- The source's Daily Log carries the reciprocal "Medical Visits" relation;
    -- either side may be the one Notion actually populates, so both directions
    -- are handled in promote.ts's applyRelation.
    daily_log_id     uuid references daily_logs(id) on delete set null,

    notion_page_id   uuid unique,
    source_record_id uuid references source_records(id) on delete set null,

    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    created_by       uuid references users(id) on delete set null,
    updated_by       uuid references users(id) on delete set null,
    archived_at      timestamptz
);

-- The "upcoming appointments" and "past appointments" queries both walk this.
create index medical_visits_upcoming_idx on medical_visits (household_id, visit_at)
    where archived_at is null;

-- What a visit's "Symptoms" relation points at: terms from the existing
-- `health_vocabulary` (kind = 'symptom', migration 0011). Not folded into
-- `daily_log_health` -- that table's key is a day, and a visit is not one.
create table medical_visit_symptoms (
    medical_visit_id uuid not null references medical_visits(id) on delete cascade,
    vocabulary_id    uuid not null references health_vocabulary(id) on delete cascade,
    created_at       timestamptz not null default now(),

    primary key (medical_visit_id, vocabulary_id)
);

create index medical_visit_symptoms_vocabulary_idx on medical_visit_symptoms (vocabulary_id);

-- ─── lab results ────────────────────────────────────────────────────────────

create table lab_results (
    id               uuid primary key default gen_random_uuid(),
    household_id     uuid not null references households(id) on delete cascade,
    owner_user_id    uuid references users(id) on delete set null,
    visibility       visibility_kind not null default 'household',

    -- Nullable like `tasks.project_id`: the importer's relation pass sets this
    -- in an UPDATE after the row already exists (promote.ts resolves relations
    -- once every row is in, in a second pass, so the marker cannot be known at
    -- insert time). The repository's create path requires it going forward;
    -- the column itself cannot, on pain of failing every import.
    marker_id        uuid references lab_markers(id) on delete cascade,
    -- The source's "Date" here carries no time of day, unlike a visit's.
    result_date      date not null,
    -- No sign or range CHECK: a marker's plausible values are not this
    -- schema's business (unlike, say, `recipes.kcal_per_serving`, which truly
    -- cannot be negative), and the household may add a marker this migration's
    -- author never anticipated.
    value            numeric(12, 4) not null,
    notes            text,
    medical_visit_id uuid references medical_visits(id) on delete set null,

    notion_page_id   uuid unique,
    source_record_id uuid references source_records(id) on delete set null,

    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    created_by       uuid references users(id) on delete set null,
    updated_by       uuid references users(id) on delete set null,
    archived_at      timestamptz
);

-- The chart and table on a marker's own page: every result for it, newest
-- first.
create index lab_results_marker_idx on lab_results (marker_id, result_date desc);
create index lab_results_visit_idx on lab_results (medical_visit_id)
    where medical_visit_id is not null;
