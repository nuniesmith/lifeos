-- Food log (nutrition) (MODEL-002, feature pack).
--
-- Notion held two databases under Food HQ that LifeOS has not carried over
-- yet: Food Library (foods, with nutrients per serving) and Food Log (what
-- was eaten, when, and how much). This migration adds both. There is no
-- importer for either -- the household re-enters this by hand going forward
-- -- so, unlike `recipes` (migration 0012), nothing here backfills rows from
-- an export.
--
-- ─── foods: a second nutrient source beside recipes ─────────────────────────
--
-- `foods` is a full domain record, shaped like `recipes`: household-scoped,
-- shared by default, and carrying the same seven per-serving nutrient columns
-- with the same types and CHECKs, because a food log entry needs to draw on
-- either one interchangeably (see below). It is not folded into `recipes`
-- itself -- a can of chickpeas is not a dish with steps and a cook time, and
-- giving it a made-up "recipe" would misuse every column that assumes one.
create table foods (
    id               uuid primary key default gen_random_uuid(),
    household_id     uuid not null references households(id) on delete cascade,
    owner_user_id    uuid references users(id) on delete set null,
    visibility       visibility_kind not null default 'household',

    name             text not null check (length(trim(name)) between 1 and 200),
    brand            text,
    -- Free text on purpose, the way a nutrition label states it: "1 cup",
    -- "100 g", "2 bars". The nutrient columns below are already anchored to
    -- whatever this says; a structured amount (migration 0026's approach for
    -- an ingredient's quantity) would need a unit system for servings, which
    -- nothing here needs a second one of.
    serving          text,

    -- Per serving, the same seven columns as `recipes` (migration 0012), same
    -- types and the same `>= 0` CHECKs -- a food log entry's totals query
    -- below treats a food and a recipe as the same kind of nutrient source.
    kcal_per_serving numeric(7, 1) check (kcal_per_serving is null or kcal_per_serving >= 0),
    protein_g        numeric(6, 1) check (protein_g is null or protein_g >= 0),
    carbs_g          numeric(6, 1) check (carbs_g is null or carbs_g >= 0),
    fibre_g          numeric(6, 1) check (fibre_g is null or fibre_g >= 0),
    sugar_g          numeric(6, 1) check (sugar_g is null or sugar_g >= 0),
    total_fat_g      numeric(6, 1) check (total_fat_g is null or total_fat_g >= 0),
    sodium_mg        numeric(7, 1) check (sodium_mg is null or sodium_mg >= 0),

    notes            text,
    is_favourite     boolean not null default false,

    notion_page_id   uuid unique,
    source_record_id uuid references source_records(id) on delete set null,

    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    created_by       uuid references users(id) on delete set null,
    updated_by       uuid references users(id) on delete set null,
    archived_at      timestamptz
);

-- The library page leads with favourites; the shopping-list-style aisle
-- index does not apply here, so this is the one favourite-scoped index a
-- food needs, matching `recipes_favourite_idx`.
create index foods_favourite_idx on foods (household_id)
    where is_favourite and archived_at is null;

-- ─── food_log_entries: what one person ate ──────────────────────────────────
--
-- Owned like `health_measurements` (migration 0019), not shared like
-- `recipes`: what someone ate is a fact about their own day, so it defaults
-- to private with a NOT NULL owner -- the person who ate, not whoever typed
-- it in. `eaten_on` is a `date`, the household's own calendar day
-- (`householdToday`), never a `timestamptz`: nobody needs the minute a snack
-- was eaten, and the household's clock is the one that decides which day it
-- was, the same reasoning `daily_logs.on_date` already applies.
create table food_log_entries (
    id                    uuid primary key default gen_random_uuid(),
    household_id          uuid not null references households(id) on delete cascade,
    owner_user_id         uuid not null references users(id) on delete cascade,
    visibility            visibility_kind not null default 'private',

    eaten_on              date not null,
    -- The meal-plan slot vocabulary (migration 0012's `meal_plan_recipes.slot`),
    -- so a day's log and a day's plan speak of the same four meals.
    meal                  text not null check (meal in ('breakfast', 'lunch', 'dinner', 'snack')),

    -- Exactly one of these, or neither -- never both. Neither is a quick
    -- entry: a name and nutrients typed directly, with nothing in the Food
    -- Library behind them. `on delete set null` rather than `restrict`: a
    -- food or recipe removed later must not take a household's own eating
    -- history down with it, which is exactly why `name` is captured below
    -- rather than looked up through this link every time the log is read.
    food_id               uuid references foods(id) on delete set null,
    recipe_id             uuid references recipes(id) on delete set null,
    check (food_id is null or recipe_id is null),

    -- A snapshot taken at log time, not a live lookup: renaming a food, or
    -- removing it outright, must not change what an already-logged entry
    -- reads as. For a quick entry this is the only name it has ever had.
    name                  text not null check (length(trim(name)) between 1 and 200),
    servings              numeric(6, 2) not null default 1 check (servings > 0),

    -- Per-entry overrides. Null means "use the source's per-serving value,
    -- times servings"; set, it replaces that computation for this one
    -- nutrient only -- the repository's `nutritionTotals` computes
    -- `coalesce(override, servings * per_serving)` per nutrient, in SQL, so a
    -- restaurant version of a logged recipe can carry more sodium than the
    -- recipe says without every other nutrient on the same entry needing a
    -- number too. Same types and the same `>= 0` CHECKs as the source
    -- columns they stand in for.
    kcal_override         numeric(7, 1) check (kcal_override is null or kcal_override >= 0),
    protein_g_override    numeric(6, 1) check (protein_g_override is null or protein_g_override >= 0),
    carbs_g_override      numeric(6, 1) check (carbs_g_override is null or carbs_g_override >= 0),
    fibre_g_override      numeric(6, 1) check (fibre_g_override is null or fibre_g_override >= 0),
    sugar_g_override      numeric(6, 1) check (sugar_g_override is null or sugar_g_override >= 0),
    total_fat_g_override  numeric(6, 1) check (total_fat_g_override is null or total_fat_g_override >= 0),
    sodium_mg_override    numeric(7, 1) check (sodium_mg_override is null or sodium_mg_override >= 0),

    notes                 text,

    notion_page_id        uuid unique,
    source_record_id      uuid references source_records(id) on delete set null,

    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now(),
    created_by            uuid references users(id) on delete set null,
    updated_by            uuid references users(id) on delete set null

    -- No `archived_at`. Every other table in this schema treats "delete" as
    -- archive-and-hide because the record might still be worth having back --
    -- a cancelled task, a recipe not made in years. A food log entry logged
    -- by mistake is not that: it is simply wrong, the way an accidental habit
    -- check-in is (`habit_logs`, migration 0004, which has no `archived_at`
    -- either and is removed with a plain DELETE). Correcting it means
    -- deleting the row and, if anything, logging the right one -- there is no
    -- "still true, just not active" reading of an eaten meal to preserve, and
    -- a food log padded with archived rows would make every total above have
    -- to filter them out forever. See `archive.ts`'s `NOT_IN_THE_ARCHIVE` for
    -- the same distinction drawn about `attachments`.
);

-- Every list and total reads "this person's entries for one day"; the
-- household-visibility toggle's extra rows come through `readableScope`
-- (base.ts), which is a `visibility`/`owner_user_id` predicate this index
-- does not need to cover on its own -- the household member seeing another's
-- shared entries is the rarer path, not the one to optimise first.
create index food_log_entries_owner_day_idx
    on food_log_entries (owner_user_id, eaten_on);

create index food_log_entries_food_idx
    on food_log_entries (food_id) where food_id is not null;
create index food_log_entries_recipe_idx
    on food_log_entries (recipe_id) where recipe_id is not null;
