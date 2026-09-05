import { fail } from '@sveltejs/kit';
import {
	createArea,
	householdToday,
	listAreas,
	listProjects,
	openTaskCountsByArea
} from '$lib/server/repositories';
import { sql } from '$lib/server/db';
import { requireViewer } from '$lib/server/viewer';
import { countsById, progressOf, reviewOf } from '../projects/planning';
import type { Actions, PageServerLoad } from './$types';

/**
 * Life areas (UI-007).
 *
 * The standing parts of a life — the ones that are never "done" — so this page
 * answers a different question from Projects: not "how far along", but "when
 * did I last look at this, and does it need me now".
 *
 * The direct-task counts are the strict reading: a task counts towards an area
 * only when it points at that area itself, not through its project. The source
 * workspace's `Open Direct Tasks` could not be reproduced (DISC-004 — three
 * readings were tried and each agreed with some areas while contradicting
 * others), so the reading used here is named rather than guessed at, and the
 * page says which one it is.
 */

const VIEWS = ['all', 'review', 'archived'] as const;
type View = (typeof VIEWS)[number];

const isView = (value: string | null): value is View => VIEWS.includes((value ?? '') as View);

export const load: PageServerLoad = async ({ locals, url }) => {
	const viewer = await requireViewer(locals.user);
	const today = await householdToday(sql, viewer.householdId);

	const view: View = isView(url.searchParams.get('view'))
		? (url.searchParams.get('view') as View)
		: 'all';

	const [found, counts] = await Promise.all([
		listAreas(sql, viewer, { includeArchived: view === 'archived', order: 'manual', limit: 200 }),
		openTaskCountsByArea(sql, viewer, { today })
	]);

	const areas = view === 'archived' ? found.filter((area) => area.archivedAt !== null) : found;

	// One query per area for its open projects. That is a handful of queries,
	// not a page of them: areas are how a household divides its life, and there
	// are a dozen of them, not a dozen a month.
	const projectLists = await Promise.all(
		areas.map((area) => listProjects(sql, viewer, { areaId: area.id, openOnly: true, limit: 200 }))
	);

	const byId = countsById(counts);
	const rows = areas.map((area, index) => ({
		id: area.id,
		name: area.name,
		description: area.description,
		icon: area.icon,
		archived: area.archivedAt !== null,
		tasks: progressOf(byId.get(area.id)),
		openProjects: projectLists[index]?.length ?? 0,
		review: reviewOf(area, today)
	}));

	// An archived area is not asking to be reviewed, so the archived view never
	// contributes to the count in the header.
	const needsReview =
		view === 'archived'
			? []
			: rows.filter((row) => row.review.state === 'due' || row.review.state === 'never');

	return {
		today,
		view,
		views: VIEWS,
		areas: view === 'review' ? needsReview : rows,
		dueCount: needsReview.length
	};
};

export const actions: Actions = {
	create: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await createArea(sql, viewer, { name: form.get('name') });
		if (!result.ok) {
			return fail(result.reason === 'invalid' ? 400 : 403, {
				error:
					result.reason === 'invalid'
						? (result.message ?? 'That area could not be created.')
						: 'Not allowed.'
			});
		}
		return { created: result.record.id };
	}
};
