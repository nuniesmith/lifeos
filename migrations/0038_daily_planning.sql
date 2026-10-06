-- Daily planning: themed workdays, Today's Three, and a fuller check-in
-- (Daily Planning pack, migration 0038).
--
-- Between 2026-09-24 and 2026-10-04 Kayla redesigned the household's Notion
-- workspace around three ideas this migration adds room for:
--
--  1. A task's THEME (which themed workday it belongs to) and its CATEGORY
--     (which kind of list it sits on) are separate questions that the source
--     workspace had started to conflate. `workday_theme` is a shared domain
--     rather than a duplicated CHECK, because `tasks.theme` and
--     `daily_logs.theme` below must never be able to drift onto two
--     different sets of labels for "the same thing". Category has no
--     counterpart elsewhere, so it stays a plain CHECK, the same way
--     `tasks.status`/`tasks.kind` already do (migration 0004).
--
--  2. Today's Three: one DUE, one HARD and one EASY task per person per day.
--     `todays_three` carries no household_id, owner or visibility of its
--     own — it is scoped through the task it names, exactly the way
--     `bill_payments` is scoped through `bills` (migration 0029) — and picks
--     are replaced or cleared outright rather than edited, so there is no
--     updated_at either, the same shape `habit_logs` and
--     `routine_step_completions` already take for a per-day, per-person row.
--
--  3. The Daily Log grows a real check-in and reflection, in place of the
--     four fields migration 0004 gave it. Nullable throughout, and nothing
--     existing changes meaning: `note` keeps its column name even though the
--     UI relabels it "Today, as it happened" (repositories.*.ts and the
--     journal page are where a label lives, not the schema), and `highlight`
--     is unchanged but for the hint its edit form now shows.
--
-- Additive and backward compatible: every new column is nullable (or
-- defaults to an empty array), so an old row simply has nothing recorded yet.

-- ─── the shared theme vocabulary ────────────────────────────────────────────
-- One domain, so a task's theme and a day's theme can never name two
-- different sets of workdays. Labels live in src/lib/daily-planning.ts, the
-- one shared, non-server module the brief calls for — not here, where a
-- rename would need a migration rather than a constant.
create domain workday_theme as text
    check (value in (
        'money_admin', 'home_environment', 'errands_appointments', 'flex_overflow',
        'self_care', 'random_fun', 'reset'
    ));

-- ─── tasks: theme and category ──────────────────────────────────────────────
-- Both nullable: an imported task has neither opinion, and a themed workday
-- or a list is something the household assigns deliberately, not a default
-- every task must carry.
alter table tasks
    add column theme    workday_theme,
    -- The kind of list a task sits on (Dopamine Menu, Three Tweaks, Hard
    -- Deadlines, Parking Lot) — a different axis from theme, and from
    -- `is_important`/`is_urgent` below, which are untouched by this
    -- migration on purpose (the brief is explicit: leave them exactly as
    -- they are).
    add column category text
        check (category is null or category in (
            'dopamine_menu', 'three_tweaks', 'hard_deadline', 'parking_lot'
        ));

-- Note for future reading of this schema: `do_on` is Notion's own "Planning
-- Day" — the day you intend to do the task, set during weekly planning. No
-- schema change for it; only its label and hint change, in the journal/tasks
-- UI.

-- ─── today's three ──────────────────────────────────────────────────────────
-- The daily focus: one task in each of three slots. `on_date` is the
-- household's own day (base.ts's `householdToday`), never UTC.
create table todays_three (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid not null references users(id) on delete cascade,
    on_date    date not null,
    slot       text not null check (slot in ('due', 'hard', 'easy')),
    task_id    uuid not null references tasks(id) on delete cascade,
    created_at timestamptz not null default now(),

    -- One task per slot per day...
    unique (user_id, on_date, slot),
    -- ...and the same task cannot occupy two slots on the same day, which
    -- would make "three" a lie.
    unique (user_id, on_date, task_id)
);

-- Supports the cascade above and "which slots hold this task" without a scan;
-- neither unique index puts task_id first.
create index todays_three_task_idx on todays_three (task_id);

-- ─── daily log: check-in, daily life, and reflection ───────────────────────
-- Grouped in the migration the way the journal page now groups them.
alter table daily_logs
    -- Check-in.
    add column intention     text,
    -- Free tags, cleaned the way reading.ts's cleanTextArray already cleans
    -- a book's moods/tags: trimmed, blanks dropped, deduped case-insensitively.
    add column pattern_tags  text[] not null default '{}',
    add column theme         workday_theme,
    add column activation    integer check (activation is null or activation between 1 and 5),
    add column effectiveness integer
        check (effectiveness is null or effectiveness between 1 and 5),
    -- "The broader mental/cognitive-state context" (Kayla's own definition).
    add column head_space    text,
    -- Daily life: "how many today", not a time of day.
    add column water         integer check (water is null or water between 0 and 50),
    add column caffeine      integer check (caffeine is null or caffeine between 0 and 50),
    add column carbonation   integer check (carbonation is null or carbonation between 0 and 50),
    -- Reflection.
    add column wins          text,
    add column challenges    text,
    -- The journal page-body sections. `note` ("Today, as it happened") and
    -- `highlight` already exist (migration 0004) and keep their columns;
    -- these two are new.
    add column worth_keeping text,
    add column anything_else text;
