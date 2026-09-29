import { fail } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import {
	createBook,
	listBooks,
	touchLibraryItem,
	updateLibraryItem
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import { loadShelf } from '../library/shelf';
import type { Actions, PageServerLoad } from './$types';

/**
 * Reading Tracker home (Reading Tracker R1).
 *
 * Two catalogues live on this one page: the book catalogue this pack adds
 * (currently reading, up next, recently read — all `books`), and the
 * pre-existing "reading list" carved out of the library, which is a status on
 * `library_items`, not a table of its own — something moves off it by
 * changing status, so a book can never be simultaneously "finished" here and
 * "to read" there. The two are kept visibly separate below rather than
 * merged, because merging them would mean deciding which table wins when
 * both eventually describe the same physical book, and that decision belongs
 * to R2's reading log, not to this page.
 */

export const load: PageServerLoad = async ({ locals }) => {
	const viewer = await requireViewer(locals.user);

	const [currentlyReading, upNext, recentlyRead, current, finished] = await Promise.all([
		listBooks(sql, viewer, { status: 'reading', order: 'updated', limit: 20 }),
		listBooks(sql, viewer, { status: 'tbr', order: 'tbr_added', limit: 10 }),
		listBooks(sql, viewer, { status: 'read', order: 'updated', limit: 10 }),
		loadShelf(viewer, { status: 'reading_list', order: 'author' }),
		loadShelf(viewer, { status: 'archived_read', order: 'recent', limit: 20 })
	]);

	return {
		currentlyReading,
		upNext,
		recentlyRead,
		items: current.items,
		finished: finished.items,
		summary: current.summary
	};
};

export const actions: Actions = {
	finish: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const result = await updateLibraryItem(sql, viewer, String(form.get('id') ?? ''), {
			status: 'archived_read'
		});
		if (!result.ok) return fail(404, { action: 'finish', error: 'Could not update that entry.' });
		return { action: 'finish', finished: result.record.id };
	},

	touch: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const result = await touchLibraryItem(sql, viewer, String(form.get('id') ?? ''));
		if (!result.ok) return fail(404, { action: 'touch', error: 'Could not find that entry.' });
		return { action: 'touch', touched: result.record.id };
	},

	/** Title + author, straight onto the TBR — the fast path for "I heard
	 *  about a book and don't want to lose it", with everything else filled
	 *  in later from the book's own page. */
	addBook: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const result = await createBook(sql, viewer, {
			title: form.get('title'),
			authorNames: form.get('author')
		});
		if (!result.ok) {
			return fail(400, {
				action: 'addBook',
				error: result.message ?? 'That book could not be added.'
			});
		}
		return { action: 'addBook', added: result.record.id };
	}
};
