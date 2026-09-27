-- Contact details for people, and important dates linked to a person
-- (PACK1-002).
--
-- The plan's own §13 note has always described a page per person that never
-- got built: /people only ever listed names, groups and a birthday. Two
-- pieces were missing to make that page worth having, and both are additive.
--
-- ─── contact details ────────────────────────────────────────────────────────
--
-- Plain columns, not a separate table: a person has at most one email, one
-- phone number and one address worth keeping here, so a join for a fact that
-- is 1:1 with the person would only add a query everywhere the record is
-- read. They carry no format CHECK, matching every other free-text column on
-- this table (`notes`, `groups`) — a phone number written with a country
-- code, an extension or local punctuation is still a phone number, and a
-- household's own shorthand for an address is still an address.
--
-- Privacy is deliberately NOT a new column here. These three are read only by
-- the single-person fetch the person's own page uses; the list and search
-- queries that show a person's name and groups select their own, narrower
-- column list and never mention email, phone or address, so there is no
-- separate flag to keep in sync with that rule — the columns a query does not
-- name cannot leak through it. The existing visibility/owner columns on
-- `people` still gate the row itself, contacts included: a private person's
-- contact details are exactly as private as their name is.
alter table people
    add column email   text,
    add column phone   text,
    add column address text;

-- ─── important dates, linked to a person ───────────────────────────────────
--
-- `important_dates` has stood alone since migration 0004: a row could say
-- "Dentist" or "Jordan's birthday" but nothing recorded WHOSE birthday it
-- was, so a person's own page had no dates to show. Nullable and
-- `on delete set null`, matching `wishlist_items.for_person_id` from
-- migration 0014 for the same reason: a date is not required to be about a
-- person (a renewal, a deadline), and removing a person must not take their
-- anniversary down with them.
alter table important_dates
    add column person_id uuid references people(id) on delete set null;

-- The only question the person page asks of this table: their dates, in
-- order. Partial because most important dates are not about a person at all.
create index important_dates_person_idx on important_dates (person_id, on_date)
    where person_id is not null;
