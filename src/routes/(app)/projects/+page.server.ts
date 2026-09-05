import { fail } from '@sveltejs/kit';
import {
	createProject,
	householdToday,
	listAreas,
	listProjects,
	openTaskCountsByProject,
	type ProjectFilters
} from '$lib/server/repositories';
import { sql } from '$lib/server/db';
import { requireViewer } from '$lib/server/viewer';
import { areasByProject, countsById, progressOf } from './planning';
import type { Actions, PageServerLoad } from './$types';

/**
 * Projects (UI-005).
 *
 * A review surface: what is running, how far along it is, and what has slipped.
 * Every number on it is derived at request time from the tasks themselves —
 * see the note on `progressOf` for why none of it is stored.
 */

/** The list's named views. Only `archived` shows archived projects. */
const VIEWS = ['open', 'active', 'on_hold', 'done', 'all', 'archived'] as const;
type View = (typeof VIEWS)[number];

const isView = (value: string | null): value is View => VIEWS.includes((value ?? '') as View);

function filtersFor(view: View): ProjectFilters {
	switch (view) {
		case 'active':
			return { status: 'active' };
		case 'on_hold':
			return { status: 'on_hold' };
		case 'done':
			return { status: ['done', 'dropped'] };
		case 'all':
			return {};
		case 'archived':
			return { includeArchived: true };
		case 'open':
		default:
			// Planned, active and on hold: everything not finished or abandoned.
			return { openOnly: true };
	}
}

export const load: PageServerLoad = async ({ locals, url }) => {
	const viewer = await requireViewer(locals.user);
	const today = await householdToday(sql, viewer.householdId);

	const view: View = isView(url.searchParams.get('view'))
		? (url.searchParams.get('view') as View)
		: 'open';

	const [found, counts, areas] = await Promise.all([
		listProjects(sql, viewer, { ...filtersFor(view), order: 'due', limit: 200 }),
		// One query for every project's counts, scoped on both sides: a task the
		// viewer may not read never reaches a number on this page.
		openTaskCountsByProject(sql, viewer, { today }),
		listAreas(sql, viewer, { limit: 100 })
	]);

	// There is no "archived only" filter, and adding one is repository work.
	// `includeArchived` plus a filter here asks the same question of the same
	// scoped result set.
	const projects = view === 'archived' ? found.filter((p) => p.archivedAt !== null) : found;

	const byId = countsById(counts);
	const areaChips = await areasByProject(sql, viewer, areas);

	const rows = projects.map((project) => ({
		id: project.id,
		name: project.name,
		status: project.status,
		dueOn: project.dueOn,
		archived: project.archivedAt !== null,
		// Archived projects are left out of the counts query, so theirs is the
		// zero case rather than a number that quietly means "not counted".
		progress: progressOf(byId.get(project.id)),
		areas: areaChips.get(project.id) ?? []
	}));

	return {
		today,
		view,
		views: VIEWS,
		projects: rows,
		overdue: rows.reduce((n, row) => n + row.progress.overdue, 0)
	};
};

export const actions: Actions = {
	/**
	 * Creating from the list takes a name and nothing else. Dates, status and
	 * the rest are set on the project's own page, where there is room to see
	 * what they mean.
	 */
	create: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await createProject(sql, viewer, { name: form.get('name') });
		if (!result.ok) {
			return fail(result.reason === 'invalid' ? 400 : 403, {
				error:
					result.reason === 'invalid'
						? (result.message ?? 'That project could not be created.')
						: 'Not allowed.'
			});
		}
		return { created: result.record.id };
	}
};
