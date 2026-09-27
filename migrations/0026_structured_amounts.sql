-- A structured amount beside the free-text one (PACK2-002).
--
-- `recipe_ingredients.amount` and `ingredients.quantity` have always been free
-- text — "2 cups, chopped", "1 bag" — because that is what the source (and a
-- household typing quickly) actually writes down, and a parser guessing at
-- one of Notion's 68 ingredients would get some of them wrong in a way nobody
-- notices until a shopping list quietly drops a unit. Both columns keep
-- meaning exactly what they always have, and NEITHER is touched by this
-- migration: no imported row is parsed or rewritten here, or ever will be by
-- the application — the free text is a permanent fallback, not a staging area
-- to migrate out of.
--
-- What was missing is a form the app can actually validate: a number that is
-- unambiguously an amount, with a unit from a fixed list, so a bad value
-- ("-2", "0") is refused before the pantry believes it. So each table gets
-- two new, optional columns beside its text one. The app writes both together
-- or neither — a number with no unit is not "structured", it is just a
-- figure — and prefers the pair for display when it is there, falling back
-- to the text otherwise (every imported row, until someone edits it here).
--
-- The unit list is the small, fixed set an amount actually needs
-- (`src/lib/food-units.ts`, the same pattern migration 0022 used for a
-- reading's unit): weight and metric volume, the spoons and cups a recipe
-- calls for, and the three ways a kitchen counts something whole. It leaves
-- out imperial weight and volume on purpose — a free-text amount still
-- covers "1 lb" or "a quart", and a long unit list is itself a source of the
-- ambiguity this migration exists to remove.
--
-- The unit can never outlive its number, the same rule migration 0022 wrote
-- for a health reading's unit: clearing the number clears the unit with it,
-- enforced in the repository and backed here by a CHECK regardless of which
-- code path writes the row.

alter table recipe_ingredients
    add column amount_value numeric(8, 2),
    add column amount_unit  text,
    add constraint recipe_ingredients_amount_value_check
        check (amount_value is null or amount_value > 0),
    add constraint recipe_ingredients_amount_unit_check
        check (amount_unit is null or amount_unit in
            ('g', 'kg', 'ml', 'l', 'tsp', 'tbsp', 'cup', 'piece', 'pinch', 'can')),
    add constraint recipe_ingredients_amount_unit_needs_value
        check (amount_unit is null or amount_value is not null);

alter table ingredients
    add column quantity_value numeric(8, 2),
    add column quantity_unit  text,
    add constraint ingredients_quantity_value_check
        check (quantity_value is null or quantity_value > 0),
    add constraint ingredients_quantity_unit_check
        check (quantity_unit is null or quantity_unit in
            ('g', 'kg', 'ml', 'l', 'tsp', 'tbsp', 'cup', 'piece', 'pinch', 'can')),
    add constraint ingredients_quantity_unit_needs_value
        check (quantity_unit is null or quantity_value is not null);
