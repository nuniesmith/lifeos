import { sql } from '$lib/server/db';
import {
	librarySummary,
	listLibrary,
	type LibraryFilters,
	type Viewer
} from '$lib/server/repositories';

/**
 * The load shared by Library, Reading and the Knowledge Hub.
 *
 * They are three questions about one table, not three collections, so they
 * share a loader and differ only in the filter they pass. Keeping that in one
 * place is what stops the three pages slowly disagreeing about what counts as
 * "in the library".
 */

export { SHELF_LABELS } from './shelf-labels';

export async function loadShelf(viewer: Viewer, filters: LibraryFilters) {
	const [items, summary] = await Promise.all([
		listLibrary(sql, viewer, { limit: 200, ...filters }),
		librarySummary(sql, viewer)
	]);
	return { items, summary };
}
