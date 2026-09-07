import { fail } from '@sveltejs/kit';
import {
	agenda,
	countTasks,
	daysBetween,
	habitSummaries,
	listDailyLogs,
	listGoals,
	listHabits,
	listProjects,
	listTasks,
	logHabit,
	unlogHabit,
	upcomingImportantDates,
	updateTask
} from '$lib/server/repositories';
import { householdToday } from '$lib/server/repositories/base';
import { sql } from '$lib/server/db';
import { requireViewer } from '$lib/server/viewer';
import { calendarWindowForMonth } from '$lib/server/calendar';
import { getWeather } from '$lib/server/weather';
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
	const [today, households] = await Promise.all([
		householdToday(sql, viewer.householdId),
		sql<{ timezone: string }[]>`
			select timezone from households where id = ${viewer.householdId}::uuid
		`
	]);
	const timezone = households[0]?.timezone;
	if (!timezone) throw new Error('household not found');

	// Load the six-week month grid, including its leading and trailing days.
	// Day strings stay independent of the runtime's local timezone.
	const calendarRange = calendarWindowForMonth(today.slice(0, 7));

	// `assignee: 'me'` includes unowned household tasks, which belong to
	// everyone — a shared errand should appear on both people's Today.
	const [
		board,
		habits,
		summaries,
		recentJournal,
		upcomingDates,
		activeProjects,
		activeGoals,
		inboxCount,
		waitingCount,
		calendarRows,
		calendarDateRows,
		weather
	] = await Promise.all([
		agenda(sql, viewer, { today, assignee: 'me' }),
		listHabits(sql, viewer, { activeOnly: true }),
		habitSummaries(sql, viewer, {
			from: today,
			to: today,
			today,
			filters: { activeOnly: true }
		}),
		// Journal previews are always this person's own entries, even when
		// another household member has chosen to share a journal entry.
		listDailyLogs(sql, viewer, { ownerUserId: viewer.userId, to: today, limit: 3 }),
		upcomingImportantDates(sql, viewer, { today, days: 30, limit: 4 }),
		listProjects(sql, viewer, { status: 'active', order: 'due', limit: 4 }),
		listGoals(sql, viewer, { status: 'active', order: 'target', limit: 4 }),
		countTasks(sql, viewer, { status: 'open', projectId: null }),
		// Genuinely untriaged, as opposed to merely unfiled: a task sitting at
		// status 'inbox' has not been decided about yet. See migration 0008.
		countTasks(sql, viewer, { status: 'inbox' }),
		// The month calendar shows readable household work, including shared
		// tasks assigned to the other member. Fetch one extra to disclose a cap.
		listTasks(sql, viewer, {
			status: 'open',
			scheduledFrom: calendarRange.from,
			scheduledTo: calendarRange.to,
			order: 'due',
			limit: 101
		}),
		upcomingImportantDates(sql, viewer, {
			today: calendarRange.from,
			days: daysBetween(calendarRange.from, calendarRange.to),
			limit: 200
		}),
		getWeather(timezone)
	]);

	const summaryFor = new Map(summaries.map((s) => [s.habitId, s]));

	return {
		today,
		timezone,
		dailyLog: recentJournal.find((entry) => entry.onDate === today) ?? null,
		recentJournal,
		upcomingDates,
		activeProjects,
		activeGoals,
		// Includes scheduled work; this is "tasks without a project", not
		// a count of tasks with no date or other organisation.
		inboxCount,
		waitingCount,
		calendarRange,
		calendarTasks: calendarRows.slice(0, 100),
		calendarTruncated: calendarRows.length > 100,
		calendarDates: calendarDateRows.map((item) => ({
			id: item.record.id,
			name: item.record.title,
			day: item.nextOn
		})),
		weather,
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
