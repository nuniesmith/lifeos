-- The day of the month a bill is really due, so "mark paid" keeps it
-- (PACK4-002 follow-up).
--
-- Advancing a monthly bill clamps into a short month: Jan 31 + 1 month is
-- Feb 28. The next advance used to start from that clamped day, so a bill due
-- on the 31st moved to the 28th in February and stayed there for good.
-- `due_day` remembers the 31. It is set whenever a person enters or changes
-- the due date, never by an advance, so each advance clamps from it afresh:
-- Jan 31, Feb 28, Mar 31, Apr 30.
--
-- Existing rows take the day of their current due date, the only evidence
-- there is of what was meant.

alter table bills
    add column due_day smallint check (due_day is null or due_day between 1 and 31);

update bills set due_day = extract(day from next_due_on)::smallint
where next_due_on is not null;
