import { listAuthors } from '$lib/server/repositories';
import { sql } from '$lib/server/db';
import { requireViewer } from '$lib/server/viewer';
import type { PageServerLoad } from './$types';

/**
 * The author directory (Reading Tracker R1).
 *
 * No "new author" form here: an author is born from typing a name into a
 * book, the same way a topic is born from the library's entry form rather
 * than from a picker of its own (see reading.ts's `findOrCreateAuthor`).
 */

export const load: PageServerLoad = async ({ locals }) => {
	const viewer = await requireViewer(locals.user);
	const authors = await listAuthors(sql, viewer, { limit: 300 });
	return { authors };
};
