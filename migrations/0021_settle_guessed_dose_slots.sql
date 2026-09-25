-- Settle the dose slots migration 0018 had to guess.
--
-- 0018 moved every vitamin day-link into `medication_doses` with slot
-- 'adhoc'. It could not do better: the rows it read from never recorded a
-- Routine, so it could not tell a morning pill from an evening one, and every
-- medication it created started as 'as_needed'. The first real import after
-- it then did two things:
--   - set each medication's actual `schedule_kind` (daily_am, daily_pm, ...);
--   - brought the Daily Log's dose links in again under the RIGHT slot.
-- So a daily-AM medication logged on a day before 0018 now appears twice for
-- that day: the guessed 'adhoc' row and the real 'am' one. On the live data
-- that was 3 days, out of 10 dose rows.
--
-- Now that the schedules are known, the guesses can be settled:
--   1. an 'adhoc' dose on a day that also has a real am/pm dose of the same
--      medication is the duplicate, so it goes;
--   2. any other 'adhoc' dose of a daily_am / daily_pm medication takes that
--      medication's slot, since a daily medication has no ad-hoc doses.
-- Doses of 'scheduled' and 'as_needed' medications are ad hoc by definition
-- and stay as they are. On a database whose doses were only ever logged by
-- hand or imported (never moved by 0018) this changes nothing: the importer
-- and the "taken" toggle both derive the slot from the schedule already.
--
-- Step 1 before step 2 is what makes step 2 safe: after the deletes, no day
-- that still has an 'adhoc' dose also has an am/pm one, so re-slotting cannot
-- collide with `unique (medication_id, on_date, slot)`.

delete from medication_doses guessed
using medication_doses real
where guessed.slot = 'adhoc'
  and real.medication_id = guessed.medication_id
  and real.on_date = guessed.on_date
  and real.slot in ('am', 'pm');

update medication_doses d
set slot = case m.schedule_kind when 'daily_am' then 'am' else 'pm' end
from medications m
where m.id = d.medication_id
  and d.slot = 'adhoc'
  and m.schedule_kind in ('daily_am', 'daily_pm');
