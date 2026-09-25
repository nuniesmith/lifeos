import { error, fail, redirect } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import {
	createLabResult,
	getLabMarker,
	listLabResults,
	rangeStatus,
	setLabMarkerArchived,
	setLabResultArchived,
	updateLabMarker
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * One lab marker: its history, chart, and the form that adds to it
 * (migration 0020).
 *
 * `status` is computed here, once, from the marker's own reference range,
 * and handed to both the table and the chart -- neither the route nor
 * `LabChart.svelte` re-derives it, and the chart in particular cannot: it is
 * plain markup with no access to `$lib/server`.
 */
export const load: PageServerLoad = async ({ locals, params }) => {
	const viewer = await requireViewer(locals.user);

	const marker = await getLabMarker(sql, viewer, params.id);
	if (!marker) error(404, 'Marker not found');

	const results = await listLabResults(sql, viewer, {
		markerId: marker.id,
		order: 'asc',
		limit: 500
	});

	return {
		marker,
		results: results.map((result) => ({
			...result,
			status: rangeStatus(result.value, marker.referenceLow, marker.referenceHigh)
		}))
	};
};

export const actions: Actions = {
	addResult: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await createLabResult(sql, viewer, {
			markerId: params.id,
			resultDate: form.get('resultDate'),
			value: form.get('value'),
			notes: form.get('notes')
		});

		if (!result.ok) {
			return fail(result.reason === 'invalid' ? 400 : result.reason === 'not_found' ? 404 : 403, {
				error: result.reason === 'invalid' ? result.message : 'Could not add that result.'
			});
		}
		return { added: result.record.id };
	},

	saveMarker: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await updateLabMarker(
			sql,
			viewer,
			params.id,
			{
				name: form.get('name'),
				units: form.get('units'),
				referenceLow: form.get('referenceLow'),
				referenceHigh: form.get('referenceHigh'),
				notes: form.get('notes')
			},
			String(form.get('updatedAt') ?? '')
		);

		if (!result.ok) {
			if (result.reason === 'conflict') {
				return fail(409, {
					error: 'This marker changed elsewhere. Reload to see the current version.'
				});
			}
			if (result.reason === 'invalid') {
				return fail(400, { error: result.message ?? 'That change is not valid.' });
			}
			return fail(403, { error: 'You cannot change this marker.' });
		}
		return { saved: true };
	},

	removeResult: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const result = await setLabResultArchived(sql, viewer, String(form.get('id') ?? ''), true);
		if (!result.ok) return fail(400, { error: 'Could not remove that result.' });
		return { removedResult: true };
	},

	archiveMarker: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const archived = form.get('archived') === 'true';

		const result = await setLabMarkerArchived(sql, viewer, params.id, archived);
		if (!result.ok) return fail(400, { error: 'Could not update that marker.' });

		if (archived) redirect(303, '/health/labs');
		return { restored: true };
	}
};
