-- Food HQ (MODEL-002, feature pack 2).
--
-- Unlike health, this one really is relational: 68 ingredients, 17 recipes,
-- a fortnight of menus and the prep that has to happen the night before. The
-- source models it as four databases joined by relations, and so does this.
--
-- Two things are deliberately not stored because they are derivable, and a
-- stored copy of a derived value is a second source of truth that goes stale:
-- the meal plan's "Day of the Week" (it is the date's own weekday) and the
-- recipe's "Total Time" (prep + cook + additional).

-- ─── ingredients ───────────────────────────────────────────────────────────
--
-- This is a pantry and a shopping list in one table, which is what the source
-- does: `status` is the whole mechanic, and every one of the 68 rows has one.

create table ingredients (
    id               uuid primary key default gen_random_uuid(),
    household_id     uuid not null references households(id) on delete cascade,
    owner_user_id    uuid references users(id) on delete set null,
    visibility       visibility_kind not null default 'household',

    name             text not null check (length(trim(name)) between 1 and 200),
    -- Where it sits in the shop, which is how a list gets walked.
    aisle            text,
    category         text,
    status           text not null default 'in_stock'
                     check (status in ('in_stock', 'shopping_list', 'use_up', 'not_needed')),
    -- A staple is re-bought without thinking about it.
    is_staple        boolean not null default false,
    store            text,
    quantity         text,
    preferred_brand  text,
    notes            text,

    notion_page_id   uuid unique,
    source_record_id uuid references source_records(id) on delete set null,

    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    created_by       uuid references users(id) on delete set null,
    updated_by       uuid references users(id) on delete set null,
    archived_at      timestamptz
);

create unique index ingredients_name_idx
    on ingredients (household_id, lower(trim(name)));

-- The shopping list is the query this table exists to answer.
create index ingredients_status_idx on ingredients (household_id, status)
    where archived_at is null;

-- ─── recipes ───────────────────────────────────────────────────────────────

create table recipes (
    id               uuid primary key default gen_random_uuid(),
    household_id     uuid not null references households(id) on delete cascade,
    owner_user_id    uuid references users(id) on delete set null,
    visibility       visibility_kind not null default 'household',

    name             text not null check (length(trim(name)) between 1 and 300),
    notes            text,
    url              text,
    servings         integer check (servings is null or servings > 0),

    -- Minutes. Total is prep + cook + additional and is not stored.
    prep_minutes       integer check (prep_minutes is null or prep_minutes >= 0),
    cook_minutes       integer check (cook_minutes is null or cook_minutes >= 0),
    additional_minutes integer check (additional_minutes is null or additional_minutes >= 0),

    -- Per serving, matching how the source records them.
    kcal_per_serving numeric(7, 1) check (kcal_per_serving is null or kcal_per_serving >= 0),
    protein_g        numeric(6, 1) check (protein_g is null or protein_g >= 0),
    carbs_g          numeric(6, 1) check (carbs_g is null or carbs_g >= 0),
    fibre_g          numeric(6, 1) check (fibre_g is null or fibre_g >= 0),
    sugar_g          numeric(6, 1) check (sugar_g is null or sugar_g >= 0),
    total_fat_g      numeric(6, 1) check (total_fat_g is null or total_fat_g >= 0),
    sodium_mg        numeric(7, 1) check (sodium_mg is null or sodium_mg >= 0),

    -- Multi-selects in the source: a recipe is "Breakfast, Snacks" and
    -- "Fall, Winter". Arrays rather than a join table, because nothing ever
    -- needs to be said *about* a course.
    courses          text[] not null default '{}',
    seasons          text[] not null default '{}',
    cuisine          text,
    occasion         text,
    effort           text,
    source_type      text,
    status           text,
    is_favourite     boolean not null default false,
    last_made_on     date,

    notion_page_id   uuid unique,
    source_record_id uuid references source_records(id) on delete set null,

    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    created_by       uuid references users(id) on delete set null,
    updated_by       uuid references users(id) on delete set null,
    archived_at      timestamptz
);

create index recipes_courses_idx on recipes using gin (courses);
create index recipes_favourite_idx on recipes (household_id)
    where is_favourite and archived_at is null;

create table recipe_ingredients (
    recipe_id     uuid not null references recipes(id) on delete cascade,
    ingredient_id uuid not null references ingredients(id) on delete cascade,
    -- "2 cups, chopped" — the amount is a property of the pairing, not of the
    -- ingredient, which is why it lives here.
    amount        text,
    primary key (recipe_id, ingredient_id)
);

create index recipe_ingredients_ingredient_idx on recipe_ingredients (ingredient_id);

-- ─── the plan ──────────────────────────────────────────────────────────────

create table meal_plans (
    id               uuid primary key default gen_random_uuid(),
    household_id     uuid not null references households(id) on delete cascade,
    owner_user_id    uuid references users(id) on delete set null,
    visibility       visibility_kind not null default 'household',

    on_date          date not null,
    -- The source titles these "Friday's Menu"; kept for display, but the date
    -- is the identity.
    name             text,
    notes            text,

    notion_page_id   uuid unique,
    source_record_id uuid references source_records(id) on delete set null,

    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    created_by       uuid references users(id) on delete set null,
    updated_by       uuid references users(id) on delete set null,
    archived_at      timestamptz,

    -- One plan per day per household: dinner is a household fact, unlike a
    -- journal entry, so this is not keyed by person.
    unique (household_id, on_date)
);

create table meal_plan_recipes (
    meal_plan_id uuid not null references meal_plans(id) on delete cascade,
    recipe_id    uuid not null references recipes(id) on delete cascade,
    slot         text not null check (slot in ('breakfast', 'lunch', 'dinner', 'snack')),
    -- A dinner can be two recipes — a bowl and the sauce that goes on it — so
    -- the slot is part of the key rather than unique on its own.
    primary key (meal_plan_id, recipe_id, slot)
);

create index meal_plan_recipes_recipe_idx on meal_plan_recipes (recipe_id);

-- ─── prep ──────────────────────────────────────────────────────────────────
--
-- Not folded into `tasks`: these carry their own vocabulary for *when* — batch
-- prep, the night before, just before cooking — which is about a cooking
-- rhythm rather than a calendar, and they hang off a recipe.

create table prep_tasks (
    id               uuid primary key default gen_random_uuid(),
    household_id     uuid not null references households(id) on delete cascade,
    owner_user_id    uuid references users(id) on delete set null,
    visibility       visibility_kind not null default 'household',

    name             text not null check (length(trim(name)) between 1 and 200),
    is_done          boolean not null default false,
    when_to_do       text check (when_to_do is null or when_to_do in
                         ('batch_prep', 'night_before', 'before_cooking')),
    recipe_id        uuid references recipes(id) on delete set null,
    notes            text,

    notion_page_id   uuid unique,
    source_record_id uuid references source_records(id) on delete set null,

    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    created_by       uuid references users(id) on delete set null,
    updated_by       uuid references users(id) on delete set null,
    archived_at      timestamptz
);

create index prep_tasks_open_idx on prep_tasks (household_id)
    where not is_done and archived_at is null;
