import { calendarMonth, calendarWindowForMonth } from '$lib/server/calendar';
import { sql } from '$lib/server/db';
import {
	daysBetween,
	listTasks,
	upcomingImportantDates,
	TASK_STATUSES
} from '$lib/server/repositories';
import { householdToday } from '$lib/server/repositories/base';
import { requireViewer } from '$lib/server/viewer';
import type { PageServerLoad } from './$types';

/** The full household month view, with every task state visible. */
export const load: PageServerLoad = async ({ locals, url }) => {
	const viewer = await requireViewer(locals.user);
	const today = await householdToday(sql, viewer.householdId);
	const month = calendarMonth(url.searchParams.get('month'), today);
	const range = calendarWindowForMonth(month);

	const [tasks, importantDates] = await Promise.all([
		listTasks(sql, viewer, {
			status: [...TASK_STATUSES],
			dueFrom: range.from,
			dueTo: range.to,
			order: 'due',
			limit: 500
		}),
		upcomingImportantDates(sql, viewer, {
			today: range.from,
			days: daysBetween(range.from, range.to),
			limit: 500
		})
	]);

	return {
		today,
		month,
		range,
		tasks,
		calendarTruncated: tasks.length >= 500,
		dates: importantDates.map((item) => ({
			id: item.record.id,
			name: item.record.title,
			day: item.nextOn
		}))
	};
};
