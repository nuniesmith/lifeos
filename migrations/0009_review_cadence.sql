-- Review cadence on goals and projects (UI: For Review).
--
-- Areas already carry `review_every_days` / `last_reviewed_on`. The Notion
-- workspace keeps the same pair on goals ("Set Review Frequency" + "Last
-- Review") and projects ("Review Frequency in Days" + "Last Review"), and
-- renders the derived "Review overdue · Aug 30" badge from them. Without these
-- columns that badge cannot exist here, and the review page would have had one
-- of its three sources.
--
-- Days rather than a calendar interval: Notion adds calendar months, so an
-- area reviewed 1 August next falls due 1 September, where 30 days lands on
-- 31 August. For "is this overdue" a day of drift is immaterial, and an
-- integer keeps the column the same shape as the one areas already use. If
-- exact parity is ever wanted, this becomes an `interval` and the arithmetic
-- moves into PostgreSQL unchanged.

alter table goals
    add column review_every_days integer,
    add column last_reviewed_on  date;

alter table projects
    add column review_every_days integer,
    add column last_reviewed_on  date;

alter table goals
    add constraint goals_review_every_days_positive
    check (review_every_days is null or review_every_days > 0);

alter table projects
    add constraint projects_review_every_days_positive
    check (review_every_days is null or review_every_days > 0);

-- The review page asks each table for "cadence set, and due on or before
-- today". Partial, because a record with no cadence is never in the answer.
create index areas_review_due_idx on areas (household_id, last_reviewed_on)
    where review_every_days is not null and archived_at is null;

create index goals_review_due_idx on goals (household_id, last_reviewed_on)
    where review_every_days is not null and archived_at is null;

create index projects_review_due_idx on projects (household_id, last_reviewed_on)
    where review_every_days is not null and archived_at is null;
