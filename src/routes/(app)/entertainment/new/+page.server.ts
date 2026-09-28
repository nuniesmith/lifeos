import { fail, redirect } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import { MEDIA_STATUSES, MEDIA_TYPES, createMediaItem } from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * A new title on the watchlist (plan §13, feature 1).
 *
 * Only a name is required. Everything else here is what a title is usually
 * saved with -- type, where it started, streaming service, genre, release
 * year, how many seasons -- while progress, rating, favourite, watch again
 * and why saved wait for the title's own page, once it is actually being
 * watched (feature 2).
 */

export const load: PageServerLoad = async ({ locals }) => {
	await requireViewer(locals.user);
	return { mediaTypes: MEDIA_TYPES, statuses: MEDIA_STATUSES };
};

export const actions: Actions = {
	default: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const values = {
			name: String(form.get('name') ?? ''),
			mediaType: String(form.get('mediaType') ?? ''),
			status: String(form.get('status') ?? ''),
			streamingService: String(form.get('streamingService') ?? ''),
			genre: String(form.get('genre') ?? ''),
			releaseYear: String(form.get('releaseYear') ?? ''),
			totalSeasons: String(form.get('totalSeasons') ?? '')
		};

		const result = await createMediaItem(sql, viewer, values);
		if (!result.ok) {
			// The values go back so a refused save does not cost what was typed.
			return fail(400, {
				error: result.reason === 'invalid' ? result.message : 'Could not save that title.',
				values
			});
		}

		redirect(303, `/entertainment/${result.record.id}`);
	}
};
