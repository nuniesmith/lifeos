import { sql } from '$lib/server/db';
import { countTasks, listLibrary } from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { PageServerLoad } from './$types';

/**
 * Content Creation.
 *
 * The source page is an empty shell — `Databases: No`, a body containing only
 * the navigation bar, and no records anywhere in the export. There is nothing
 * to connect, and inventing a drafts pipeline to fill the space would be
 * claiming a feature that does not exist.
 *
 * What it can honestly do is point at the two places creative work already
 * lives in this application: things captured but not yet decided about, and
 * the library of things worth drawing on.
 */
export const load: PageServerLoad = async ({ locals }) => {
	const viewer = await requireViewer(locals.user);
	const [waiting, references] = await Promise.all([
		countTasks(sql, viewer, { status: 'inbox' }),
		listLibrary(sql, viewer, { withHighlights: true, order: 'recent', limit: 5 })
	]);
	return {
		waiting,
		references: references.map((r) => ({ id: r.id, title: r.title, author: r.author }))
	};
};
