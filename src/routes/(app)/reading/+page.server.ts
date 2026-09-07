import { fail } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import { touchLibraryItem, updateLibraryItem } from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import { loadShelf } from '../library/shelf';
import type { Actions, PageServerLoad } from './$types';

/**
 * Reading Tracker.
 *
 * The reading list is a status on the library, not a table: something moves
 * off the list by changing status, so a book can never be simultaneously
 * "finished" here and "to read" there.
 */

export const load: PageServerLoad = async ({ locals }) => {
	const viewer = await requireViewer(locals.user);

	const [current, finished] = await Promise.all([
		loadShelf(viewer, { status: 'reading_list', order: 'author' }),
		loadShelf(viewer, { status: 'archived_read', order: 'recent', limit: 20 })
	]);

	return { items: current.items, finished: finished.items, summary: current.summary };
};

export const actions: Actions = {
	finish: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const result = await updateLibraryItem(sql, viewer, String(form.get('id') ?? ''), {
			status: 'archived_read'
		});
		if (!result.ok) return fail(404, { error: 'Could not update that entry.' });
		return { finished: result.record.id };
	},

	touch: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const result = await touchLibraryItem(sql, viewer, String(form.get('id') ?? ''));
		if (!result.ok) return fail(404, { error: 'Could not find that entry.' });
		return { touched: result.record.id };
	}
};
