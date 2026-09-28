-- Link a medical visit's provider and location to `people`, and to the pet
-- it was for (PACK3-002).
--
-- Three nullable foreign keys, not three join tables. A visit has at most one
-- provider, one location and one pet -- the same singular relationship
-- `wishlist_items.for_person_id` (migration 0014) and
-- `important_dates.person_id` (migration 0024) already model as a plain
-- column, and for the same reason: nothing is ever said *about* a visit's
-- link to a specific provider beyond "this is who it was with", so a join
-- table would only add a row that carries no attributes of its own. Contrast
-- `medical_visit_symptoms` (migration 0020), which stays a join table because
-- a visit genuinely has many symptoms -- that is a real one-to-many the
-- source itself records, not a modelling default.
--
-- All three reference `people` rather than three different tables, because
-- providers, places and pets are already rows there (migration 0014),
-- distinguished by `kind`. The column name says which `kind` the repository
-- requires when it resolves the id -- `provider_person_id` a 'person',
-- `location_place_id` a 'place', `pet_id` a 'pet' -- but nothing below can
-- express that as a CHECK constraint, since a check cannot see another
-- table's column. It is enforced instead where every other cross-reference in
-- this schema is enforced: in the repository's own WHERE clause, alongside
-- household and visibility (see `resolveVisitLink` in labs-visits.ts).
--
-- `on delete set null`, matching every other optional person-reference in the
-- schema: a visit is a historical record of an appointment that happened, and
-- deleting the person who was the provider must not delete the fact that the
-- visit itself took place.
--
-- The imported `provider` and `location` text columns (migration 0020) are
-- untouched by this migration and untouched by the repository's linking code
-- -- they are the source's own words, and this adds a second, independent way
-- to point at a person without rewriting the first.
alter table medical_visits
    add column provider_person_id uuid references people(id) on delete set null,
    add column location_place_id  uuid references people(id) on delete set null,
    add column pet_id             uuid references people(id) on delete set null;

-- What a person's or a pet's own page will eventually ask of this table:
-- every visit that links to them. Partial, like `wishlist_person_idx`, since
-- most visits (imported ones, and any not yet linked) have none of the three
-- set.
create index medical_visits_provider_idx on medical_visits (provider_person_id)
    where provider_person_id is not null;
create index medical_visits_location_idx on medical_visits (location_place_id)
    where location_place_id is not null;
create index medical_visits_pet_idx on medical_visits (pet_id)
    where pet_id is not null;
