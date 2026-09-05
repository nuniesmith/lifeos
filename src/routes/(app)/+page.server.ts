import { fail } from '@sveltejs/kit';
import {
	agenda,
	habitSummaries,
	listHabits,
	logHabit,
	unlogHabit,
	updateTask
} from '$lib/server/repositories';
import { householdToday } from '$lib/server/repositories/base';
import { sql } from '$lib/server/db';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * Today (UI-002).
 *
 * Built from derived queries. The Notion source carried a `System Status`
 * database of pre-rendered strings like "✓ 1 open task"; those were
 * deliberately not imported, because a stored summary is a snapshot that goes
 * quietly stale. Everything here is asked at request time.
 */
export const load: PageServerLoad = async ({ locals }) => {
	const viewer = await requireViewer(locals.user);
	const today = await householdToday(sql, viewer.householdId);

	// `assignee: 'me'` includes unowned household tasks, which belong to
	// everyone — a shared errand should appear on both people's Today.
	const board = await agenda(sql, viewer, { today, assignee: 'me' });

	const habits = await listHabits(sql, viewer, { activeOnly: true });
	const summaries = await habitSummaries(sql, viewer, {
		from: today,
		to: today,
		today,
		filters: { activeOnly: true }
	});

	const summaryFor = new Map(summaries.map((s) => [s.habitId, s]));

	return {
		today,
		week: board.week,
		overdue: board.overdue,
		dueToday: board.dueToday,
		dueThisWeek: board.dueThisWeek,
		habits: habits.map((habit) => {
			const summary = summaryFor.get(habit.id);
			return {
				id: habit.id,
				name: habit.name,
				target: habit.targetCount,
				period: habit.targetPeriod,
				// Today's check-in state, which is what the tick reflects.
				doneToday: (summary?.completedCount ?? 0) >= (habit.targetCount || 1),
				completedToday: summary?.completedCount ?? 0,
				streak: summary?.currentStreak ?? 0
			};
		})
	};
};

export const actions: Actions = {
	/** Complete or reopen a task straight from Today. */
	toggleTask: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const done = form.get('done') === 'true';

		const result = await updateTask(
			sql,
			viewer,
			String(form.get('id') ?? ''),
			{ status: done ? 'done' : 'todo' },
			String(form.get('updatedAt') ?? '')
		);

		if (!result.ok) {
			return fail(result.reason === 'conflict' ? 409 : 400, {
				error:
					result.reason === 'conflict'
						? 'That task changed elsewhere. Reload to see the current version.'
						: 'Could not update that task.'
			});
		}
		return { ok: true };
	},

	/**
	 * Habit check-in. The database enforces one log per habit per person per
	 * day, so ticking twice is not an error — un-ticking is the inverse, and
	 * both are idempotent from the caller's point of view.
	 */
	toggleHabit: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const habitId = String(form.get('id') ?? '');
		const on = form.get('done') === 'true';
		const day = String(form.get('day') ?? '');

		if (on) {
			const result = await logHabit(sql, viewer, { habitId, onDate: day, completed: true });
			if (!result.ok) return fail(400, { error: 'Could not record that check-in.' });
			return { ok: true };
		}

		// unlogHabit returns false when there was nothing to delete. Un-ticking
		// a habit that was never ticked is the state the caller asked for, so
		// that is success, not a failure to report.
		await unlogHabit(sql, viewer, habitId, day);
		return { ok: true };
	}
};
