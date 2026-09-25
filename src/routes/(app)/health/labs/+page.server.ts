import { fail } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import { createLabMarker, labResultCounts, listLabMarkers } from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * Lab markers: the vocabulary a result is drawn against (migration 0020).
 *
 * Each marker's own chart and result table live on its detail page
 * (`[id]`); this page is the list, plus where a new marker is defined --
 * the same split as Health's own vocabulary page, one level deeper because
 * a marker also carries a reference range and a history worth its own view.
 */

export const load: PageServerLoad = async ({ locals }) => {
	const viewer = await requireViewer(locals.user);

	const [markers, counts] = await Promise.all([
		listLabMarkers(sql, viewer, { limit: 300 }),
		labResultCounts(sql, viewer)
	]);

	return {
		markers: markers.map((marker) => ({ ...marker, resultCount: counts[marker.id] ?? 0 }))
	};
};

export const actions: Actions = {
	addMarker: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await createLabMarker(sql, viewer, {
			name: form.get('name'),
			units: form.get('units'),
			referenceLow: form.get('referenceLow'),
			referenceHigh: form.get('referenceHigh')
		});

		if (!result.ok) {
			return fail(result.reason === 'invalid' ? 400 : 403, {
				error: result.reason === 'invalid' ? result.message : 'Not allowed.'
			});
		}
		return { added: result.record.id };
	}
};
