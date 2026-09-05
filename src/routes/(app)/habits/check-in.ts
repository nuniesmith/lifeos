import { fail } from '@sveltejs/kit';
import { isDay, logHabit, unlogHabit } from '$lib/server/repositories';
import { sql } from '$lib/server/db';
import { requireViewer } from '$lib/server/viewer';

/**
 * The habit check-in, shared by the list and the detail page (UI-009).
 *
 * Idempotent in both directions, and deliberately so. `habit_logs` is unique
 * on (habit, person, day) in the database, so a second tick writes the same
 * row rather than a duplicate; un-ticking a day that was never ticked leaves
 * the day unlogged, which is the state the caller asked for. Neither is
 * reported as a failure, because a double tap on a phone is not an error and
 * a check-in must never depend on the page being fresh.
 *
 * There is no version precondition here for the same reason: ticking a box is
 * not an edit that can be lost.
 */
export async function toggleCheckIn(locals: App.Locals, request: Request) {
	const viewer = await requireViewer(locals.user);
	const form = await request.formData();

	const habitId = String(form.get('id') ?? '');
	const day = String(form.get('day') ?? '');
	if (!isDay(day)) return fail(400, { error: 'That is not a date.' });

	if (form.get('done') === 'true') {
		const result = await logHabit(sql, viewer, { habitId, onDate: day, completed: true });
		// The insert selects through `habits`, so a habit in another household
		// or another member's private one matches nothing and writes nothing.
		if (!result.ok) return fail(404, { error: 'That habit is not available.' });
		return { checked: habitId, day };
	}

	await unlogHabit(sql, viewer, habitId, day);
	return { checked: habitId, day };
}
