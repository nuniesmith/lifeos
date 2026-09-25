import { error, fail, redirect } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import {
	addVisitSymptom,
	getMedicalVisit,
	listHealthTerms,
	removeVisitSymptom,
	resultsForVisit,
	setMedicalVisitArchived,
	symptomsForVisit,
	updateMedicalVisit
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * One medical visit: its details, the symptoms it was for, and the lab
 * results drawn at it (migration 0020).
 *
 * The lab results are read-only here, the same choice `goals/[id]` makes for
 * its own project and habit links: a result attaches to a visit from the
 * result's own "add a result" form (`/health/labs/[id]`), not from here, so
 * no control is drawn that would do nothing.
 */
export const load: PageServerLoad = async ({ locals, params }) => {
	const viewer = await requireViewer(locals.user);

	const visit = await getMedicalVisit(sql, viewer, params.id);
	if (!visit) error(404, 'Visit not found');

	const [results, symptoms, availableSymptoms] = await Promise.all([
		resultsForVisit(sql, viewer, visit.id),
		symptomsForVisit(sql, viewer, visit.id),
		listHealthTerms(sql, viewer, { kind: 'symptom', limit: 300 })
	]);

	const attached = new Set(symptoms.map((s) => s.vocabularyId));
	return {
		visit,
		results,
		symptoms,
		// Offered in the "attach a symptom" picker: everything not already on
		// this visit.
		pickableSymptoms: availableSymptoms.filter((term) => !attached.has(term.id))
	};
};

export const actions: Actions = {
	saveVisit: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await updateMedicalVisit(
			sql,
			viewer,
			params.id,
			{
				reason: form.get('reason'),
				visitDate: form.get('visitDate'),
				visitTime: form.get('visitTime'),
				visitType: form.get('visitType'),
				provider: form.get('provider'),
				location: form.get('location'),
				amount: form.get('amount'),
				currency: form.get('currency'),
				paidBy: form.get('paidBy'),
				requirements: form.get('requirements'),
				familyMember: form.get('familyMember'),
				notes: form.get('notes')
			},
			String(form.get('updatedAt') ?? '')
		);

		if (!result.ok) {
			if (result.reason === 'conflict') {
				return fail(409, {
					error: 'This visit changed elsewhere. Reload to see the current version.'
				});
			}
			if (result.reason === 'invalid') {
				return fail(400, { error: result.message ?? 'That change is not valid.' });
			}
			return fail(403, { error: 'You cannot change this visit.' });
		}
		return { saved: true };
	},

	archiveVisit: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const archived = form.get('archived') === 'true';

		const result = await setMedicalVisitArchived(sql, viewer, params.id, archived);
		if (!result.ok) return fail(400, { error: 'Could not update that visit.' });

		if (archived) redirect(303, '/health/visits');
		return { restored: true };
	},

	addSymptom: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const result = await addVisitSymptom(
			sql,
			viewer,
			params.id,
			String(form.get('vocabularyId') ?? '')
		);
		if (!result.ok) return fail(400, { error: 'Could not attach that symptom.' });
		return { symptomAdded: true };
	},

	removeSymptom: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const result = await removeVisitSymptom(
			sql,
			viewer,
			params.id,
			String(form.get('vocabularyId') ?? '')
		);
		if (!result.ok) return fail(400, { error: 'Could not remove that symptom.' });
		return { symptomRemoved: true };
	}
};
