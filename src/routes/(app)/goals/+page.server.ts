import { fail } from '@sveltejs/kit';
import {
	createGoal,
	householdToday,
	listAreas,
	listGoals,
	type GoalFilters
} from '$lib/server/repositories';
import { sql } from '$lib/server/db';
import { requireViewer } from '$lib/server/viewer';
import { areasByGoal } from '../projects/planning';
import type { Actions, PageServerLoad } from './$types';

/**
 * Goals (UI-006).
 *
 * The list stays deliberately thin: a goal's real progress lives in the
 * projects underneath it, and asking for those is a query per goal. It is asked
 * once, on the goal's own page, rather than two hundred times to decorate a
 * list — see the note on `areasByRecord` in `projects/planning.ts` for which
 * directions of these relations are cheap and which are not.
 */

const VIEWS = ['active', 'paused', 'achieved', 'all', 'archived'] as const;
type View = (typeof VIEWS)[number];

const isView = (value: string | null): value is View => VIEWS.includes((value ?? '') as View);

function filtersFor(view: View): GoalFilters {
	switch (view) {
		case 'paused':
			return { status: 'paused' };
		case 'achieved':
			return { status: 'achieved' };
		case 'all':
			return {};
		case 'archived':
			return { includeArchived: true };
		case 'active':
		default:
			return { status: 'active' };
	}
}

export const load: PageServerLoad = async ({ locals, url }) => {
	const viewer = await requireViewer(locals.user);
	const today = await householdToday(sql, viewer.householdId);

	const view: View = isView(url.searchParams.get('view'))
		? (url.searchParams.get('view') as View)
		: 'active';

	const [found, areas] = await Promise.all([
		listGoals(sql, viewer, { ...filtersFor(view), order: 'target', limit: 200 }),
		listAreas(sql, viewer, { limit: 100 })
	]);

	// As on the projects list: there is no "archived only" filter, so the
	// archived view asks for everything and keeps the archived rows.
	const goals = view === 'archived' ? found.filter((goal) => goal.archivedAt !== null) : found;

	const chips = await areasByGoal(sql, viewer, areas);

	return {
		today,
		view,
		views: VIEWS,
		goals: goals.map((goal) => ({
			id: goal.id,
			title: goal.title,
			status: goal.status,
			targetDate: goal.targetDate,
			archived: goal.archivedAt !== null,
			areas: chips.get(goal.id) ?? []
		}))
	};
};

export const actions: Actions = {
	create: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await createGoal(sql, viewer, { title: form.get('title') });
		if (!result.ok) {
			return fail(result.reason === 'invalid' ? 400 : 403, {
				error:
					result.reason === 'invalid'
						? (result.message ?? 'That goal could not be created.')
						: 'Not allowed.'
			});
		}
		return { created: result.record.id };
	}
};
