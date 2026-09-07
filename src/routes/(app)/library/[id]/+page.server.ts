import { error, fail } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import {
	ENTRY_TYPES,
	LIBRARY_STATUSES,
	getLibraryItem,
	tagsForEntity,
	touchLibraryItem,
	updateLibraryItem
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * One library entry.
 *
 * This route exists because search generates `/library/<id>` for every library
 * hit, and without it every one of those results was a 404 — the link looked
 * right and went nowhere. A page that is only reachable from search still has
 * to be a real page, so it carries what the entry actually holds: the summary,
 * the notes taken out of it, its topics, and the controls to move it along.
 */

export const load: PageServerLoad = async ({ locals, params }) => {
	const viewer = await requireViewer(locals.user);

	const item = await getLibraryItem(sql, viewer, params.id);
	// 404 rather than 403 for a record in another household: telling someone a
	// thing exists but is not theirs is itself a disclosure.
	if (!item) error(404, 'Not found');

	const tags = await tagsForEntity(sql, viewer, 'library_item', item.id);

	return {
		item,
		tags: tags.map((t) => ({ id: t.id, name: t.name })),
		statuses: LIBRARY_STATUSES,
		entryTypes: ENTRY_TYPES
	};
};

export const actions: Actions = {
	save: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await updateLibraryItem(
			sql,
			viewer,
			params.id,
			{
				title: form.get('title'),
				author: form.get('author'),
				summary: form.get('summary'),
				notes: form.get('notes'),
				status: form.get('status'),
				entryType: form.get('entryType'),
				isFavourite: form.get('isFavourite') === 'on'
			},
			String(form.get('updatedAt') ?? '')
		);

		if (!result.ok) {
			return fail(result.reason === 'conflict' ? 409 : 400, {
				error:
					result.reason === 'conflict'
						? 'That entry changed elsewhere. Reload to see the current version.'
						: (result.message ?? 'Could not save that.')
			});
		}
		return { saved: result.record.id };
	},

	touch: async ({ locals, params }) => {
		const viewer = await requireViewer(locals.user);
		const result = await touchLibraryItem(sql, viewer, params.id);
		if (!result.ok) return fail(404, { error: 'Could not find that entry.' });
		return { touched: result.record.id };
	}
};
