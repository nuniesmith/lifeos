-- Units for blood glucose and weight (PACK3-002).
--
-- Both were bare numbers: Notion's "Blood Glucose" and "Weight" properties
-- record no unit, so migration 0019 stored none either, and the page showed
-- the number alone rather than guess. But a glucose of 6.2 and one of 112 are
-- the same reading in two different units (mmol/L, which Canada uses, and
-- mg/dL, which a US meter or lab report uses), and a weight of 72 means
-- nothing until it says kg or lb. So each reading now records the unit it was
-- taken in, next to the number exactly as it was typed: nothing is converted
-- on the way in, so nothing is rounded away, and a reading can always be read
-- back the way it was written down.
--
-- Converting for display (a chart that has to put 6.2 mmol/L and 112 mg/dL on
-- one axis) happens in the application, from these two columns; see
-- `$lib/units`. The columns hold the unit's own symbol rather than a code, so
-- the table reads correctly in psql and in an export without a lookup.
--
-- ─── existing readings keep no unit ─────────────────────────────────────────
--
-- There is no backfill. Every reading already here came from Notion without a
-- unit, and a value's size is only a hint, not a record: nothing in the data
-- says whether a weight of 100 is kg or lb. NULL keeps meaning what it has
-- always meant here, "not recorded", and the edit form lets the household set
-- each one. New readings always carry a unit; the form requires one.
alter table health_measurements
    add column glucose_unit text,
    add column weight_unit  text,
    add constraint health_measurements_glucose_unit_check
        check (glucose_unit is null or glucose_unit in ('mmol/L', 'mg/dL')),
    add constraint health_measurements_weight_unit_check
        check (weight_unit is null or weight_unit in ('kg', 'lb')),
    -- A unit says what a number means, so it cannot outlive the number: a
    -- reading whose weight is cleared loses its weight unit with it. The
    -- repository and the importer both clear the unit themselves; this is the
    -- backstop that holds regardless.
    add constraint health_measurements_glucose_unit_needs_value
        check (glucose_unit is null or glucose is not null),
    add constraint health_measurements_weight_unit_needs_value
        check (weight_unit is null or weight is not null);
