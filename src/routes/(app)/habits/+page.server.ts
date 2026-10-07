import { fail } from '@sveltejs/kit';
import {
	createHabit,
	habitSummaries,
	householdToday,
	listHabits,
	updateHabit
} from '$lib/server/repositories';
import { sql } from '$lib/server/db';
import { requireViewer } from '$lib/server/viewer';
import { toggleCheckIn } from './check-in';
import type { Actions, PageServerLoad } from './$types';

/**
 * Habits: today's check-in, and the list itself (UI-009).
 *
 * The summaries are asked for over the single day `today`. That is not a
 * narrower question than it looks: `summariseHabit` counts periods from a
 * long lookback, so a window of one day still returns the *current period's*
 * progress — 2 of 3 this week — alongside whether today itself is ticked, in
 * one query rather than one per habit.
 */
export const load: PageServerLoad = async ({ locals }) => {
	const viewer = await requireViewer(locals.user);
	const today = await householdToday(sql, viewer.householdId);

	const [habits, summaries] = await Promise.all([
		listHabits(sql, viewer, { limit: 200 }),
		habitSummaries(sql, viewer, { from: today, to: today, today, filters: { limit: 200 } })
	]);

	const summaryFor = new Map(summaries.map((summary) => [summary.habitId, summary]));

	const rows = habits.map((habit) => {
		const summary = summaryFor.get(habit.id);
		// from === to === today, so `periods` holds exactly one entry: the
		// period today falls in, counted over the whole lookback.
		const period = summary?.periods[0];
		return {
			id: habit.id,
			name: habit.name,
			description: habit.description,
			active: habit.active,
			updatedAt: habit.updatedAt.toISOString(),
			targetCount: habit.targetCount,
			targetPeriod: habit.targetPeriod,
			// One check-in per person per day, so "done today" is a count of one
			// — not a comparison against a target that spans a week.
			doneToday: (summary?.completedCount ?? 0) > 0,
			periodCompleted: period?.completed ?? 0,
			periodMet: period?.met ?? false,
			lastLoggedOn: summary?.lastLoggedOn ?? null,
			planTheReturn: summary?.planTheReturn ?? false
		};
	});

	return {
		today,
		active: rows.filter((row) => row.active),
		paused: rows.filter((row) => !row.active)
	};
};

export const actions: Actions = {
	toggle: ({ locals, request }) => toggleCheckIn(locals, request),

	create: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await createHabit(sql, viewer, {
			name: form.get('name'),
			targetCount: form.get('targetCount'),
			targetPeriod: form.get('targetPeriod')
		});

		if (!result.ok) {
			return fail(result.reason === 'invalid' ? 400 : 403, {
				error: result.reason === 'invalid' ? result.message : 'Not allowed.'
			});
		}
		return { created: result.record.id };
	},

	/** Bringing a paused habit back, from the list where it is visible. */
	resume: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await updateHabit(
			sql,
			viewer,
			String(form.get('id') ?? ''),
			{ active: true },
			String(form.get('updatedAt') ?? '')
		);
		if (!result.ok) {
			return fail(result.reason === 'conflict' ? 409 : 400, {
				error:
					result.reason === 'conflict'
						? 'That habit changed elsewhere. Reload to see the current version.'
						: 'Could not resume that habit.'
			});
		}
		return { resumed: true };
	}
};
