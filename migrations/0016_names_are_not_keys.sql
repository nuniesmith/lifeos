-- Names are labels, not keys (DISC: "title is not a key").
--
-- Migrations 0011 and 0014 put case-insensitive UNIQUE indexes on the names of
-- ingredients, people and the health vocabulary. The first real import failed
-- on the first of them: the workspace has two "Carrots" — one bare and marked
-- "Don't Need", one categorised as a fresh vegetable and marked "Use up!".
-- Two Notion pages, the same label, different data.
--
-- That is not a corrupt export, it is how people use Notion, and the plan
-- already records it as a verified hazard for titles generally. The failure
-- mode is what makes it worth a migration rather than a data clean-up: a
-- unique index does not skip the offending row, it aborts the whole
-- transaction, so one duplicated word loses all 436 records.
--
-- The identity of an imported record is its `notion_page_id`, which is already
-- unique and is what the upserts key on. The name is a label and is now
-- indexed for lookup without being constrained.
--
-- Refusing a duplicate someone types by hand is still worth doing, and it
-- moves to the repository create path — where the person can be told, and
-- where an import carrying the source's own history is not affected. See
-- `createIngredient`, `createPerson` and `createHealthTerm`.

drop index if exists ingredients_name_idx;
create index ingredients_name_idx on ingredients (household_id, lower(trim(name)));

drop index if exists people_name_idx;
create index people_name_idx on people (household_id, lower(trim(name)));

drop index if exists health_vocabulary_name_idx;
create index health_vocabulary_name_idx
    on health_vocabulary (household_id, kind, lower(trim(name)));
