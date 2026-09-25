import { fail } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import { createMedicalVisit, listMedicalVisits } from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * Medical visits: appointments, upcoming and past (migration 0020).
 *
 * One list, ascending by `visit_at`, split here into the two the source's
 * own "Appointments" view implies -- soonest upcoming first, most recent
 * past first -- rather than asked for as two separate queries: a household
 * with a handful of visits does not need two round trips to look at all of
 * them once.
 */

export const load: PageServerLoad = async ({ locals }) => {
	const viewer = await requireViewer(locals.user);

	const visits = await listMedicalVisits(sql, viewer, { order: 'asc', limit: 500 });
	const now = Date.now();
	const upcoming = visits.filter((v) => v.visitAt.getTime() >= now);
	// Ascending overall, so reversing the tail gives most-recent-past-first.
	const past = visits.filter((v) => v.visitAt.getTime() < now).reverse();

	return { upcoming, past };
};

export const actions: Actions = {
	addVisit: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await createMedicalVisit(sql, viewer, {
			reason: form.get('reason'),
			visitDate: form.get('visitDate'),
			visitTime: form.get('visitTime'),
			visitType: form.get('visitType'),
			provider: form.get('provider'),
			location: form.get('location')
		});

		if (!result.ok) {
			return fail(result.reason === 'invalid' ? 400 : 403, {
				error: result.reason === 'invalid' ? result.message : 'Not allowed.'
			});
		}
		return { added: result.record.id };
	}
};
