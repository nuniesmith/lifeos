import { error, fail, redirect } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import {
	addVisitSymptom,
	createPerson,
	getMedicalVisit,
	linkedNamesForVisit,
	listHealthTerms,
	listPeople,
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
 * results drawn at it (migration 0020), plus its provider, location and pet
 * links (migration 0028, PACK3-002).
 *
 * The lab results are read-only here, the same choice `goals/[id]` makes for
 * its own project and habit links: a result attaches to a visit from the
 * result's own "add a result" form (`/health/labs/[id]`), not from here, so
 * no control is drawn that would do nothing.
 *
 * The provider/place/pet lists are trimmed to `{id, name}` before they reach
 * the client: `listPeople` (collections.ts) also returns groups, notes and a
 * birthday, none of which this page's pickers have any business sending to
 * the browser for every person in the household just to fill a dropdown.
 */
export const load: PageServerLoad = async ({ locals, params }) => {
	const viewer = await requireViewer(locals.user);

	const visit = await getMedicalVisit(sql, viewer, params.id);
	if (!visit) error(404, 'Visit not found');

	const asOptions = (people: { id: string; name: string }[]) =>
		people.map((p) => ({ id: p.id, name: p.name }));

	const [results, symptoms, availableSymptoms, providers, places, pets, linked] = await Promise.all(
		[
			resultsForVisit(sql, viewer, visit.id),
			symptomsForVisit(sql, viewer, visit.id),
			listHealthTerms(sql, viewer, { kind: 'symptom', limit: 300 }),
			listPeople(sql, viewer, { kind: 'person', limit: 300 }),
			listPeople(sql, viewer, { kind: 'place', limit: 300 }),
			listPeople(sql, viewer, { kind: 'pet', limit: 300 }),
			linkedNamesForVisit(sql, viewer, visit)
		]
	);

	const attached = new Set(symptoms.map((s) => s.vocabularyId));
	return {
		visit,
		results,
		symptoms,
		// Offered in the "attach a symptom" picker: everything not already on
		// this visit.
		pickableSymptoms: availableSymptoms.filter((term) => !attached.has(term.id)),
		providers: asOptions(providers),
		places: asOptions(places),
		pets: asOptions(pets),
		linked
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
				notes: form.get('notes'),
				providerPersonId: form.get('providerPersonId'),
				locationPlaceId: form.get('locationPlaceId'),
				petId: form.get('petId')
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
			// A picker only ever offers a readable, live person/place/pet of the
			// right kind (see `resolveVisitLink`), so `not_found` here means the
			// choice went stale between load and save -- someone archived or
			// removed it a moment ago -- rather than the visit itself vanishing:
			// this action cannot even be reached without that having already
			// loaded.
			if (result.reason === 'not_found') {
				return fail(400, {
					error: 'One of the links no longer matches a person you can see. Reload and try again.'
				});
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
	},

	// Three actions rather than one parameterised by a hidden `kind` field: the
	// `kind` each writes is then a fact about which button was pressed, not
	// something a tampered form could redirect -- `createPerson` (collections.ts)
	// is the same "add a new one" the /people list already uses, so this is
	// only ever wiring it in, never reimplementing it. The new row is not
	// automatically linked: it lands in the picker above once the page
	// revalidates, and saving the link is still the Details form's own action,
	// so there is exactly one place a link is ever written.
	addProvider: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const result = await createPerson(sql, viewer, { name: form.get('name'), kind: 'person' });
		if (!result.ok) {
			return fail(result.reason === 'invalid' ? 400 : 403, {
				action: 'addProvider',
				error: result.reason === 'invalid' ? result.message : 'Could not add that person.'
			});
		}
		return { action: 'addProvider', addedId: result.record.id };
	},

	addPlace: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const result = await createPerson(sql, viewer, { name: form.get('name'), kind: 'place' });
		if (!result.ok) {
			return fail(result.reason === 'invalid' ? 400 : 403, {
				action: 'addPlace',
				error: result.reason === 'invalid' ? result.message : 'Could not add that place.'
			});
		}
		return { action: 'addPlace', addedId: result.record.id };
	},

	addPet: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const result = await createPerson(sql, viewer, { name: form.get('name'), kind: 'pet' });
		if (!result.ok) {
			return fail(result.reason === 'invalid' ? 400 : 403, {
				action: 'addPet',
				error: result.reason === 'invalid' ? result.message : 'Could not add that pet.'
			});
		}
		return { action: 'addPet', addedId: result.record.id };
	}
};
