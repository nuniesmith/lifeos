import { error, fail } from '@sveltejs/kit';
import {
	addDays,
	daysBetween,
	getHabit,
	habitSummary,
	householdToday,
	listAreas,
	listHabitLogs,
	updateHabit,
	weekWindow,
	type Period
} from '$lib/server/repositories';
import { sql } from '$lib/server/db';
import { requireViewer } from '$lib/server/viewer';
import { toggleCheckIn } from '../check-in';
import type { Actions, PageServerLoad } from './$types';

/**
 * One habit: its history, its progress against the target, and its settings
 * (UI-009).
 *
 * How far back to look depends on what the target is measured in. Twenty-eight
 * *days* is a useful history for a daily habit and a single data point for a
 * monthly one, so the window is expressed in the habit's own periods.
 */
const WINDOW: Record<Period, { days: number; periods: number }> = {
	day: { days: 27, periods: 28 },
	week: { days: 7 * 11, periods: 12 },
	month: { days: 31 * 5, periods: 6 }
};

/** Four weeks of days, aligned to whole weeks so the grid has square rows. */
const GRID_DAYS = 27;

export const load: PageServerLoad = async ({ locals, params }) => {
	const viewer = await requireViewer(locals.user);

	const habit = await getHabit(sql, viewer, params.id);
	// Not found and not permitted are the same answer: saying a habit exists
	// but is not yours to see is itself a disclosure. getHabit already applies
	// the readable scope.
	if (!habit) error(404, 'Habit not found');

	const today = await householdToday(sql, viewer.householdId);
	const window = WINDOW[habit.targetPeriod];
	const gridFrom = weekWindow(addDays(today, -GRID_DAYS)).start;

	const [summary, logs, areas] = await Promise.all([
		habitSummary(sql, viewer, habit.id, { from: addDays(today, -window.days), to: today, today }),
		listHabitLogs(sql, viewer, habit.id, { from: gridFrom, to: today }),
		listAreas(sql, viewer, { limit: 200 })
	]);
	if (!summary) error(404, 'Habit not found');

	const ticked = new Set(logs.filter((log) => log.completed).map((log) => log.onDate));
	const days = Array.from({ length: daysBetween(gridFrom, today) + 1 }, (_, i) => {
		const date = addDays(gridFrom, i);
		return { date, done: ticked.has(date), isToday: date === today };
	});

	return {
		today,
		habit: {
			id: habit.id,
			name: habit.name,
			description: habit.description,
			areaId: habit.areaId,
			targetCount: habit.targetCount,
			targetPeriod: habit.targetPeriod,
			active: habit.active,
			updatedAt: habit.updatedAt.toISOString()
		},
		areas: areas.map((area) => ({ value: area.id, label: area.name })),
		days,
		progress: {
			lastLoggedOn: summary.lastLoggedOn,
			planTheReturn: summary.planTheReturn,
			completionRate: summary.completionRate,
			periodsMet: summary.periodsMet,
			// The period containing today -- always the window's own last
			// entry, since `periods` runs oldest to newest -- for "X of target
			// this period" on the habit's own page.
			current: summary.periods.at(-1) ?? { completed: 0, target: habit.targetCount, met: false },
			// Oldest first, and only as many as the window is meant to show.
			periods: summary.periods.slice(-window.periods)
		}
	};
};

export const actions: Actions = {
	toggle: ({ locals, request }) => toggleCheckIn(locals, request),

	save: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await updateHabit(
			sql,
			viewer,
			params.id,
			{
				name: form.get('name'),
				description: form.get('description'),
				areaId: form.get('areaId'),
				targetCount: form.get('targetCount'),
				targetPeriod: form.get('targetPeriod')
			},
			String(form.get('updatedAt') ?? '')
		);

		if (!result.ok) {
			if (result.reason === 'conflict') {
				return fail(409, {
					error: 'This habit changed elsewhere. Reload to see the current version.'
				});
			}
			if (result.reason === 'invalid') return fail(400, { error: result.message });
			return fail(403, { error: 'You cannot change this habit.' });
		}
		return { saved: true };
	},

	/**
	 * Pause or resume. A paused habit keeps every check-in it ever had — it
	 * simply stops being asked for, which is what someone means when they stop
	 * a habit for a season.
	 */
	setActive: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await updateHabit(
			sql,
			viewer,
			params.id,
			{ active: form.get('active') === 'true' },
			String(form.get('updatedAt') ?? '')
		);
		if (!result.ok) {
			if (result.reason === 'conflict') {
				return fail(409, {
					error: 'This habit changed elsewhere. Reload to see the current version.'
				});
			}
			return fail(result.reason === 'forbidden' ? 403 : 400, {
				error: 'Could not change that habit.'
			});
		}
		return { saved: true };
	}
};
