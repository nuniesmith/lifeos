import { fail } from '@sveltejs/kit';
import {
	createRoutine,
	householdToday,
	listRoutines,
	routineStepProgress,
	TIME_OF_DAY,
	type TimeOfDay
} from '$lib/server/repositories';
import { sql } from '$lib/server/db';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * Routines: grouped by time of day, each with today's progress.
 *
 * "Today's progress" is asked for over every live routine in one query
 * (`routineStepProgress`), the same one-round-trip discipline
 * `habitSummaries` and `recentDosesFor` already follow, rather than one
 * progress query per routine on the list.
 */

export const load: PageServerLoad = async ({ locals }) => {
	const viewer = await requireViewer(locals.user);
	const today = await householdToday(sql, viewer.householdId);

	const routines = await listRoutines(sql, viewer, { limit: 200 });
	const progress = await routineStepProgress(
		sql,
		viewer,
		routines.map((r) => r.id),
		viewer.userId,
		today
	);

	const rows = routines.map((routine) => ({
		id: routine.id,
		name: routine.name,
		timeOfDay: routine.timeOfDay,
		...(progress.get(routine.id) ?? { done: 0, total: 0 })
	}));

	const groups = TIME_OF_DAY.map((timeOfDay: TimeOfDay) => ({
		timeOfDay,
		routines: rows.filter((row) => row.timeOfDay === timeOfDay)
	})).filter((group) => group.routines.length > 0);

	return { today, groups };
};

export const actions: Actions = {
	create: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await createRoutine(sql, viewer, {
			name: form.get('name'),
			timeOfDay: form.get('timeOfDay')
		});
		if (!result.ok) {
			return fail(result.reason === 'invalid' ? 400 : 403, {
				error: result.reason === 'invalid' ? result.message : 'Not allowed.'
			});
		}
		return { created: result.record.id };
	}
};
