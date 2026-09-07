import { sql } from '$lib/server/db';
import {
	countTasks,
	goalsNeedingSetup,
	householdToday,
	listAreas,
	listGoals,
	listProjects,
	openTaskCountsByArea,
	reviewQueue
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { PageServerLoad } from './$types';

/**
 * Master Dashboards.
 *
 * The home page answers "what am I doing today". This one answers the
 * question a weekly look-back asks instead: where is the work actually
 * sitting, and what is quietly not moving.
 *
 * Everything here is a count or a small list over tables that already exist —
 * no new schema — and every number is a link, because a dashboard that cannot
 * be drilled into is decoration.
 */

export const load: PageServerLoad = async ({ locals }) => {
	const viewer = await requireViewer(locals.user);
	const today = await householdToday(sql, viewer.householdId);

	const [
		waiting,
		open,
		overdue,
		dueToday,
		unfiled,
		areas,
		projects,
		goals,
		byArea,
		due,
		unsupported
	] = await Promise.all([
		countTasks(sql, viewer, { status: 'inbox' }),
		countTasks(sql, viewer, { status: 'open' }),
		countTasks(sql, viewer, { status: 'open', dueTo: previousDay(today) }),
		countTasks(sql, viewer, { status: 'open', dueFrom: today, dueTo: today }),
		countTasks(sql, viewer, { status: 'open', projectId: null }),
		listAreas(sql, viewer, { order: 'name', limit: 100 }),
		listProjects(sql, viewer, { openOnly: true, order: 'due', limit: 100 }),
		listGoals(sql, viewer, { order: 'target', limit: 100 }),
		openTaskCountsByArea(sql, viewer),
		reviewQueue(sql, viewer, today, { limit: 100 }),
		goalsNeedingSetup(sql, viewer)
	]);

	const perArea = new Map(byArea.map((row) => [row.id, row]));

	return {
		today,
		tasks: { waiting, open, overdue, dueToday, unfiled },
		areas: areas.map((area) => ({
			id: area.id,
			name: area.name,
			openTasks: perArea.get(area.id)?.openCount ?? 0,
			overdueTasks: perArea.get(area.id)?.overdueCount ?? 0,
			// An area with a cadence that has never been reviewed reads as the
			// most neglected thing on the page, which is the intent.
			lastReviewedOn: area.lastReviewedOn,
			reviewEveryDays: area.reviewEveryDays
		})),
		projects: {
			total: projects.length,
			// Past its own end date and still open — the project equivalent of
			// an overdue task, and the thing a weekly look-back is for.
			overdue: projects.filter((p) => p.dueOn !== null && p.dueOn < today).length
		},
		goals: {
			total: goals.length,
			active: goals.filter((g) => g.status === 'active').length,
			later: goals.filter((g) => g.status === 'planned' || g.status === 'someday').length,
			needingSetup: unsupported.length
		},
		reviewDue: due.length
	};
};

/** Yesterday, so an "overdue" filter excludes today. Plain string arithmetic. */
function previousDay(day: string): string {
	const d = new Date(`${day}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() - 1);
	return d.toISOString().slice(0, 10);
}
