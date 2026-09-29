import { error, fail } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import { getAuthor, listBooks, setAuthorArchived, updateAuthor } from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * One author: their books, a rename, notes, and archive (Reading Tracker R1).
 */

export const load: PageServerLoad = async ({ locals, params }) => {
	const viewer = await requireViewer(locals.user);

	const author = await getAuthor(sql, viewer, params.id);
	if (!author) error(404, 'Not found');

	const books = await listBooks(sql, viewer, { authorId: author.id, limit: 300 });
	return { author, books };
};

export const actions: Actions = {
	save: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await updateAuthor(
			sql,
			viewer,
			params.id,
			{ name: form.get('name'), notes: form.get('notes') },
			String(form.get('updatedAt') ?? '')
		);
		if (!result.ok) {
			return fail(result.reason === 'conflict' ? 409 : result.reason === 'invalid' ? 400 : 404, {
				action: 'save',
				error:
					result.reason === 'conflict'
						? 'This author changed somewhere else. Reload to see the current version.'
						: result.reason === 'invalid'
							? (result.message ?? 'That change is not valid.')
							: 'Could not find that.'
			});
		}
		return { action: 'save', saved: result.record.id };
	},

	archive: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const archived = form.get('archived') === 'true';

		const result = await setAuthorArchived(sql, viewer, params.id, archived);
		if (!result.ok) return fail(404, { action: 'archive', error: 'Could not find that.' });
		return { action: 'archive', restored: !archived ? true : undefined };
	}
};
