import { fail } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import {
	createEvent,
	householdToday,
	listAreas,
	listAssessments,
	listEvents,
	yearInReview,
	yearsOnRecord
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * Reflect & Reset — the year in review.
 *
 * Every figure on this page is computed from what is already recorded rather
 * than read from a stored rollup. The source keeps these as formula columns on
 * a Years row, which means they are only as fresh as the last recalculation;
 * a query makes "total days logged" true by construction.
 */

export const load: PageServerLoad = async ({ locals, url }) => {
	const viewer = await requireViewer(locals.user);
	const today = await householdToday(sql, viewer.householdId);

	const years = await yearsOnRecord(sql, viewer);
	const requested = Number(url.searchParams.get('year'));
	const year =
		Number.isFinite(requested) && requested > 1900
			? requested
			: (years[0] ?? Number(today.slice(0, 4)));

	const [review, events, assessments, areas] = await Promise.all([
		yearInReview(sql, viewer, year),
		listEvents(sql, viewer, { from: `${year}-01-01`, to: `${year}-12-31`, limit: 100 }),
		listAssessments(sql, viewer, { year, limit: 100 }),
		listAreas(sql, viewer, { order: 'name', limit: 100 })
	]);

	return {
		year,
		years: years.length > 0 ? years : [year],
		review,
		events,
		assessments,
		areas: areas.map((a) => ({ id: a.id, name: a.name }))
	};
};

export const actions: Actions = {
	addEvent: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const result = await createEvent(sql, viewer, {
			title: form.get('title'),
			onDate: form.get('onDate'),
			areaId: form.get('areaId') || null
		});
		if (!result.ok) {
			return fail(result.reason === 'invalid' ? 400 : 403, {
				error: result.reason === 'invalid' ? result.message : 'Not allowed.'
			});
		}
		return { added: result.record.id };
	}
};
