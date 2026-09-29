import { fail } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import { listGenres, setGenreArchived, updateGenre } from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * The genre directory (Reading Tracker R1).
 *
 * No page of its own per genre — rename and archive both happen inline here,
 * which is also why this is the one kind in the archive whose link points
 * back at this list rather than at a detail page (archive.ts).
 */

export const load: PageServerLoad = async ({ locals }) => {
	const viewer = await requireViewer(locals.user);
	const genres = await listGenres(sql, viewer, { limit: 300 });
	return { genres };
};

export const actions: Actions = {
	rename: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const id = String(form.get('id') ?? '');

		const result = await updateGenre(
			sql,
			viewer,
			id,
			{ name: form.get('name') },
			String(form.get('updatedAt') ?? '')
		);
		if (!result.ok) {
			return fail(result.reason === 'conflict' ? 409 : result.reason === 'invalid' ? 400 : 404, {
				action: 'rename',
				id,
				error:
					result.reason === 'conflict'
						? 'This genre changed somewhere else. Reload and try again.'
						: result.reason === 'invalid'
							? (result.message ?? 'That name is not valid.')
							: 'Could not find that.'
			});
		}
		return { action: 'rename', id, saved: true };
	},

	archive: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const archived = form.get('archived') === 'true';

		const result = await setGenreArchived(sql, viewer, id, archived);
		if (!result.ok) return fail(404, { action: 'archive', id, error: 'Could not find that.' });
		return { action: 'archive', id, restored: !archived ? true : undefined };
	}
};
