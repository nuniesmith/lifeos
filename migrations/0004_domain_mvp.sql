-- MVP domain tables (MODEL-001).
--
-- Real columns and real foreign keys, not an entity-attribute-value copy of
-- Notion. Every user-owned table carries the shared conventions from plan §6:
-- application-generated UUID, household scoping, optional owner, provenance
-- back to the import, visibility, audit columns, and archived_at for
-- recoverable deletion.
--
-- Formula and rollup columns from the source are deliberately NOT stored.
-- Values like "Past Deadline?" and "Number of Subtasks" are derived at query
-- time; the source's rendered values are kept only in import provenance as
-- comparison fixtures (IMP-008).

create domain visibility_kind as text
    check (value in ('household', 'private'));

-- ─── areas ─────────────────────────────────────────────────────────────────
create table areas (
    id               uuid primary key default gen_random_uuid(),
    household_id     uuid not null references households(id) on delete cascade,
    owner_user_id    uuid references users(id) on delete set null,
    visibility       visibility_kind not null default 'household',

    name             text not null check (length(trim(name)) between 1 and 200),
    description      text,
    icon             text,
    -- Cadence in days between reviews; null means no scheduled review.
    review_every_days integer check (review_every_days is null or review_every_days > 0),
    last_reviewed_on date,
    sort_order       integer not null default 0,

    notion_page_id   uuid unique,
    source_record_id uuid references source_records(id) on delete set null,

    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    created_by       uuid references users(id) on delete set null,
    updated_by       uuid references users(id) on delete set null,
    archived_at      timestamptz
);

create index areas_household on areas (household_id) where archived_at is null;

-- ─── goals ─────────────────────────────────────────────────────────────────
create table goals (
    id               uuid primary key default gen_random_uuid(),
    household_id     uuid not null references households(id) on delete cascade,
    owner_user_id    uuid references users(id) on delete set null,
    visibility       visibility_kind not null default 'household',

    title            text not null check (length(trim(title)) between 1 and 300),
    description      text,
    status           text not null default 'active'
                          check (status in ('active', 'achieved', 'paused', 'dropped')),
    target_date      date,
    achieved_on      date,
    -- Progress is derived from linked projects and habits, never stored as
    -- truth; this is only a manual override when there is nothing to derive.
    manual_progress  numeric(5, 4) check (manual_progress between 0 and 1),

    notion_page_id   uuid unique,
    source_record_id uuid references source_records(id) on delete set null,

    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    created_by       uuid references users(id) on delete set null,
    updated_by       uuid references users(id) on delete set null,
    archived_at      timestamptz
);

create index goals_household on goals (household_id) where archived_at is null;

-- ─── projects ──────────────────────────────────────────────────────────────
create table projects (
    id               uuid primary key default gen_random_uuid(),
    household_id     uuid not null references households(id) on delete cascade,
    owner_user_id    uuid references users(id) on delete set null,
    visibility       visibility_kind not null default 'household',

    name             text not null check (length(trim(name)) between 1 and 300),
    description      text,
    status           text not null default 'active'
                          check (status in ('planned', 'active', 'on_hold', 'done', 'dropped')),
    start_on         date,
    due_on           date,
    completed_on     date,
    is_template      boolean not null default false,

    notion_page_id   uuid unique,
    source_record_id uuid references source_records(id) on delete set null,

    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    created_by       uuid references users(id) on delete set null,
    updated_by       uuid references users(id) on delete set null,
    archived_at      timestamptz
);

create index projects_household on projects (household_id) where archived_at is null;
create index projects_status    on projects (household_id, status) where archived_at is null;

-- ─── tasks ─────────────────────────────────────────────────────────────────
create table tasks (
    id               uuid primary key default gen_random_uuid(),
    household_id     uuid not null references households(id) on delete cascade,
    owner_user_id    uuid references users(id) on delete set null,
    visibility       visibility_kind not null default 'household',

    title            text not null check (length(trim(title)) between 1 and 500),
    notes            text,
    -- 'milestone' is retained from the source Type column rather than dropped.
    kind             text not null default 'task' check (kind in ('task', 'milestone')),
    status           text not null default 'todo'
                          check (status in ('todo', 'in_progress', 'blocked', 'done', 'dropped')),

    project_id       uuid references projects(id) on delete set null,
    area_id          uuid references areas(id) on delete set null,
    parent_task_id   uuid references tasks(id) on delete cascade,

    do_on            date,
    deadline_on      date,
    completed_at     timestamptz,

    is_important     boolean not null default false,
    is_urgent        boolean not null default false,
    energy           text check (energy in ('low', 'medium', 'high')),
    context          text,

    -- Recurrence as a rule, not as a pre-expanded series.
    recurrence_rule  text,
    recurrence_every integer check (recurrence_every is null or recurrence_every > 0),
    next_due_on      date,
    last_completed_on date,

    is_template      boolean not null default false,
    sort_order       integer not null default 0,

    notion_page_id   uuid unique,
    source_record_id uuid references source_records(id) on delete set null,

    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    created_by       uuid references users(id) on delete set null,
    updated_by       uuid references users(id) on delete set null,
    archived_at      timestamptz,

    -- A task cannot be its own parent. Deeper cycles are checked in the
    -- repository layer, where the whole chain is visible.
    constraint tasks_no_self_parent check (parent_task_id is null or parent_task_id <> id)
);

create index tasks_household on tasks (household_id) where archived_at is null;
create index tasks_project   on tasks (project_id)   where archived_at is null;
create index tasks_parent    on tasks (parent_task_id);
-- Drives the "Today" and "This Week" views.
create index tasks_do_on     on tasks (household_id, do_on)
    where archived_at is null and status <> 'done';

-- ─── task dependencies ─────────────────────────────────────────────────────
-- The source's "Blocked by" / "Blocking" pair is one relation, stored once.
create table task_dependencies (
    blocked_task_id  uuid not null references tasks(id) on delete cascade,
    blocking_task_id uuid not null references tasks(id) on delete cascade,
    created_at       timestamptz not null default now(),
    primary key (blocked_task_id, blocking_task_id),
    constraint task_dependencies_no_self check (blocked_task_id <> blocking_task_id)
);

create index task_dependencies_blocking on task_dependencies (blocking_task_id);

-- ─── tags ──────────────────────────────────────────────────────────────────
create table tags (
    id               uuid primary key default gen_random_uuid(),
    household_id     uuid not null references households(id) on delete cascade,
    name             citext not null check (length(trim(name)) between 1 and 100),
    colour           text,

    notion_page_id   uuid unique,
    source_record_id uuid references source_records(id) on delete set null,

    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    archived_at      timestamptz,
    unique (household_id, name)
);

-- Polymorphic on purpose: tags apply across every feature pack, and a column
-- per entity type would need a migration for each new one.
create table entity_tags (
    tag_id      uuid not null references tags(id) on delete cascade,
    entity_type text not null,
    entity_id   uuid not null,
    created_at  timestamptz not null default now(),
    primary key (tag_id, entity_type, entity_id)
);

create index entity_tags_entity on entity_tags (entity_type, entity_id);

-- ─── important dates ───────────────────────────────────────────────────────
create table important_dates (
    id               uuid primary key default gen_random_uuid(),
    household_id     uuid not null references households(id) on delete cascade,
    owner_user_id    uuid references users(id) on delete set null,
    visibility       visibility_kind not null default 'household',

    title            text not null check (length(trim(title)) between 1 and 300),
    notes            text,
    on_date          date not null,
    -- 'yearly' covers birthdays and anniversaries, the common case.
    recurrence       text not null default 'none'
                          check (recurrence in ('none', 'yearly', 'monthly', 'custom')),
    recurrence_rule  text,
    remind_days_before integer check (remind_days_before is null or remind_days_before >= 0),

    notion_page_id   uuid unique,
    source_record_id uuid references source_records(id) on delete set null,

    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    created_by       uuid references users(id) on delete set null,
    updated_by       uuid references users(id) on delete set null,
    archived_at      timestamptz
);

create index important_dates_when on important_dates (household_id, on_date)
    where archived_at is null;

-- ─── daily logs ────────────────────────────────────────────────────────────
-- One entry per person per day. Journals default to private: a shared default
-- here would be the wrong way round to discover.
create table daily_logs (
    id               uuid primary key default gen_random_uuid(),
    household_id     uuid not null references households(id) on delete cascade,
    owner_user_id    uuid not null references users(id) on delete cascade,
    visibility       visibility_kind not null default 'private',

    on_date          date not null,
    note             text,
    energy_level     integer check (energy_level between 1 and 5),
    mood             text,
    gratitude        text,
    highlight        text,

    notion_page_id   uuid unique,
    source_record_id uuid references source_records(id) on delete set null,

    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    created_by       uuid references users(id) on delete set null,
    updated_by       uuid references users(id) on delete set null,
    archived_at      timestamptz,

    unique (owner_user_id, on_date)
);

create index daily_logs_date on daily_logs (household_id, on_date desc);

-- ─── habits ────────────────────────────────────────────────────────────────
create table habits (
    id               uuid primary key default gen_random_uuid(),
    household_id     uuid not null references households(id) on delete cascade,
    owner_user_id    uuid references users(id) on delete set null,
    visibility       visibility_kind not null default 'household',

    name             text not null check (length(trim(name)) between 1 and 200),
    description      text,
    area_id          uuid references areas(id) on delete set null,
    -- Target occurrences per period, e.g. 3 per 'week'.
    target_count     integer not null default 1 check (target_count > 0),
    target_period    text not null default 'day'
                          check (target_period in ('day', 'week', 'month')),
    active           boolean not null default true,

    notion_page_id   uuid unique,
    source_record_id uuid references source_records(id) on delete set null,

    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    created_by       uuid references users(id) on delete set null,
    updated_by       uuid references users(id) on delete set null,
    archived_at      timestamptz
);

create index habits_household on habits (household_id) where archived_at is null;

-- One log per habit per person per day, enforced by the database rather than
-- by the application remembering to check.
create table habit_logs (
    id            uuid primary key default gen_random_uuid(),
    habit_id      uuid not null references habits(id) on delete cascade,
    user_id       uuid not null references users(id) on delete cascade,
    on_date       date not null,
    completed     boolean not null default true,
    note          text,
    created_at    timestamptz not null default now(),
    unique (habit_id, user_id, on_date)
);

create index habit_logs_date on habit_logs (habit_id, on_date desc);

-- ─── relationship tables ───────────────────────────────────────────────────
create table project_areas (
    project_id uuid not null references projects(id) on delete cascade,
    area_id    uuid not null references areas(id)    on delete cascade,
    primary key (project_id, area_id)
);

create table project_goals (
    project_id uuid not null references projects(id) on delete cascade,
    goal_id    uuid not null references goals(id)    on delete cascade,
    primary key (project_id, goal_id)
);

create table goal_areas (
    goal_id uuid not null references goals(id) on delete cascade,
    area_id uuid not null references areas(id) on delete cascade,
    primary key (goal_id, area_id)
);

create table goal_habits (
    goal_id  uuid not null references goals(id)  on delete cascade,
    habit_id uuid not null references habits(id) on delete cascade,
    primary key (goal_id, habit_id)
);

-- ─── updated_at triggers ───────────────────────────────────────────────────
do $$
declare t text;
begin
    foreach t in array array[
        'areas', 'goals', 'projects', 'tasks', 'tags',
        'important_dates', 'daily_logs', 'habits'
    ] loop
        execute format(
            'create trigger %I_updated_at before update on %I
             for each row execute function set_updated_at()', t, t
        );
    end loop;
end
$$;
