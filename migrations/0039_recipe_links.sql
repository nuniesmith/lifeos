-- Related recipes (PACK2-001).
--
-- The source's Recipes database has a "Related Recipes" relation to itself —
-- the soup that goes with the bread, the sauce two dinners share — which the
-- importer has been leaving in source_links for want of somewhere to put it.
--
-- Modelled on `library_links` (migration 0023), the same kind of relation:
-- one table's rows linked to each other, no surrogate id, no household_id of
-- its own (both ends carry one, and every query scopes through `recipes`),
-- and no direction, so it shows on both recipes' pages alike. One row per
-- pair, in a canonical order: the check forces `recipe_a_id` to be the
-- smaller id, so the same pair can never be stored twice the other way
-- round, and the primary key is what rejects the duplicate.
create table recipe_links (
    recipe_a_id uuid not null references recipes(id) on delete cascade,
    recipe_b_id uuid not null references recipes(id) on delete cascade,
    created_at  timestamptz not null default now(),
    created_by  uuid references users(id) on delete set null,
    primary key (recipe_a_id, recipe_b_id),
    constraint recipe_links_ordered check (recipe_a_id < recipe_b_id)
);

-- The primary key indexes recipe_a_id; a link is looked up from either end.
create index recipe_links_b_idx on recipe_links (recipe_b_id);
