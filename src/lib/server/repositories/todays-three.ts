import type { Viewer } from '../auth/authz';
import { toDate, toDateOrNull } from '../db/coerce';
import {
	InvalidInput,
	guarded,
	isUuid,
	readableScope,
	toText,
	type Queryable,
	type WriteResult
} from './base';
import { isDay } from './dates';
import type { TaskStatus } from './tasks';
import { TODAYS_THREE_SLOTS, type TodaysThreeSlot } from '$lib/daily-planning';

/**
 * Today's Three (migration 0038): one DUE, one HARD and one EASY task per
 * person per day.
 *
 * `todays_three` carries no household_id, owner or visibility of its own —
 * it is scoped through the task it names, exactly the way `bill_payments` is
 * scoped through `bills`. That means every read and write here reaches the
 * task through `readableScope` in the SAME statement, the way
 * `resolveVisitLink` (labs-visits.ts) and `resolveHolder` (documents.ts)
 * already check a cross-reference before it is written: someone else's
 * private task is "not found", never "forbidden", for a pick exactly as it
 * is for the task itself.
 *
 * A pick is replaced or cleared, never edited — there is nothing on this row
 * a person fills in beyond which task it names — so unlike every table in
 * this directory it has no `updated_at` to maintain.
 *
 * `day` is always the household's own day (`householdToday` in base.ts), not
 * UTC: a planning ritual that runs between midnight and 4am UTC must not be
 * asked about a day that, locally, has not started yet.
 */

/** What a pick's task looks like once resolved, for the Today card. */
export interface TodaysThreeTask {
	id: string;
	title: string;
	status: TaskStatus;
	/** Never filtered out: a picked task that is later archived still shows,
	 *  struck through rather than vanishing (the brief's own rule). */
	archivedAt: Date | null;
	updatedAt: Date;
}

export interface TodaysThreePick {
	slot: TodaysThreeSlot;
	taskId: string;
	createdAt: Date;
	/**
	 * Null when the task is no longer readable — made private by whoever
	 * owns it, since the pick was made. The row in `todays_three` is
	 * untouched; this is the same live re-check `linkedNamesForVisit`
	 * performs for a visit's own links, not a fact cached at pick time.
	 */
	task: TodaysThreeTask | null;
}

interface PickRow {
	slot: string;
	task_id: string;
	created_at: unknown;
	title: string | null;
	status: string | null;
	archived_at: unknown;
	updated_at: unknown;
}

function mapPick(row: PickRow): TodaysThreePick {
	return {
		slot: row.slot as TodaysThreeSlot,
		taskId: row.task_id,
		createdAt: toDate(row.created_at),
		task:
			row.title === null
				? null
				: {
						id: row.task_id,
						title: toText(row.title),
						status: row.status as TaskStatus,
						archivedAt: toDateOrNull(row.archived_at),
						updatedAt: toDate(row.updated_at)
					}
	};
}

function isSlot(value: unknown): value is TodaysThreeSlot {
	return typeof value === 'string' && (TODAYS_THREE_SLOTS as readonly string[]).includes(value);
}

/**
 * The viewer's picks for one day, in slot order. A slot with nothing picked
 * simply has no row here — the caller (the Today page's load) fills the
 * three fixed slots in against this, the same way habit summaries are mapped
 * back onto the household's own list of habits.
 */
export async function todaysThree(
	sql: Queryable,
	viewer: Viewer,
	day: string
): Promise<TodaysThreePick[]> {
	if (!isDay(day)) return [];
	const rows = await sql<PickRow[]>`
		select p.slot, p.task_id, p.created_at,
		       t.title, t.status, t.archived_at, t.updated_at
		from todays_three p
		left join tasks t on t.id = p.task_id and ${readableScope(sql, viewer, 't')}
		where p.user_id = ${viewer.userId}::uuid and p.on_date = ${day}::date
		order by p.slot
	`;
	return rows.map(mapPick);
}

/**
 * Picks a task for a slot, replacing whatever it held.
 *
 * The task is resolved readable in the one INSERT itself — a `select ...
 * from tasks where id = ... and readableScope` feeding the row, not a
 * separate check beforehand — so a task the viewer may not read is a plain
 * "not found" and nothing is written. The table's own uniqueness is what
 * refuses the other failure mode: the same task already sitting in a
 * different slot today raises a unique violation on `(user_id, on_date,
 * task_id)`, which `guarded` turns into an ordinary `invalid` result, since
 * ON CONFLICT above only arms the slot's own index.
 */
export function pickTask(
	sql: Queryable,
	viewer: Viewer,
	day: string,
	slot: TodaysThreeSlot,
	taskId: string
): Promise<WriteResult<TodaysThreePick>> {
	return guarded<TodaysThreePick>(async () => {
		if (!isDay(day)) throw new InvalidInput('date must be a calendar date');
		if (!isSlot(slot))
			throw new InvalidInput(`slot must be one of ${TODAYS_THREE_SLOTS.join(', ')}`);
		if (!isUuid(taskId)) return { ok: false, reason: 'not_found' };

		const rows = await sql<PickRow[]>`
			with picked as (
				insert into todays_three (user_id, on_date, slot, task_id)
				select ${viewer.userId}::uuid, ${day}::date, ${slot}, t.id
				from tasks t
				where t.id = ${taskId}::uuid and ${readableScope(sql, viewer, 't')}
				on conflict (user_id, on_date, slot)
					do update set task_id = excluded.task_id
				returning slot, task_id, created_at
			)
			select p.slot, p.task_id, p.created_at,
			       t.title, t.status, t.archived_at, t.updated_at
			from picked p
			join tasks t on t.id = p.task_id
		`;
		const row = rows[0];
		if (!row) return { ok: false, reason: 'not_found' };
		return { ok: true, record: mapPick(row) };
	});
}

/** Clears a slot. Missing is success: the slot ends up empty either way. */
export async function clearSlot(
	sql: Queryable,
	viewer: Viewer,
	day: string,
	slot: TodaysThreeSlot
): Promise<boolean> {
	if (!isDay(day) || !isSlot(slot)) return false;
	const rows = await sql<{ id: string }[]>`
		delete from todays_three
		where user_id = ${viewer.userId}::uuid and on_date = ${day}::date and slot = ${slot}
		returning id
	`;
	return rows.length > 0;
}
