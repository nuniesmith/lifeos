import { fail } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import {
	assessmentPeriods,
	createAssessment,
	listAreas,
	listAssessments
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * Perspectives — the wheel of life.
 *
 * A periodic self-rating of each area, lowest first, because the point of the
 * exercise is to see what is being neglected rather than to admire what is
 * going well.
 */

export const load: PageServerLoad = async ({ locals, url }) => {
	const viewer = await requireViewer(locals.user);
	const yearParam = Number(url.searchParams.get('year'));
	const year = Number.isFinite(yearParam) && yearParam > 1900 ? yearParam : undefined;

	const [assessments, periods, areas] = await Promise.all([
		listAssessments(sql, viewer, { ...(year ? { year } : {}), limit: 200 }),
		assessmentPeriods(sql, viewer),
		listAreas(sql, viewer, { order: 'name', limit: 100 })
	]);

	const average =
		assessments.length > 0
			? Math.round((assessments.reduce((s, a) => s + a.rating, 0) / assessments.length) * 10) / 10
			: null;

	return {
		assessments,
		periods,
		year: year ?? null,
		average,
		areas: areas.map((a) => ({ id: a.id, name: a.name }))
	};
};

export const actions: Actions = {
	add: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const result = await createAssessment(sql, viewer, {
			focus: form.get('focus'),
			rating: form.get('rating'),
			period: form.get('period'),
			year: form.get('year'),
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
