-- Goals that have not started yet (UI: "On the Horizon").
--
-- The source workspace separates goals being worked on from goals chosen for
-- later, and renders the second group on its own board — "Things I've chosen
-- to work on... but later" — split into Planned and Someday. `Planned` was
-- absent from the import's status table, so it fell to the `active` fallback
-- and a goal nobody had started counted as one in progress. The review page
-- would then have asked for progress on something deliberately not begun.
--
-- `someday` has no rows in the current export but is a column on that board,
-- so it is admitted here rather than waiting to be discovered as a second
-- silent fallback the first time a goal is filed under it.
--
-- Neither status counts as finished: both stay in the review queue, because a
-- goal parked indefinitely is exactly what a review is for.

alter table goals drop constraint goals_status_check;

alter table goals add constraint goals_status_check
    check (status = any (array['someday', 'planned', 'active', 'paused', 'achieved', 'dropped']));
