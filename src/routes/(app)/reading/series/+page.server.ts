import { listBookSeries } from '$lib/server/repositories';
import { sql } from '$lib/server/db';
import { requireViewer } from '$lib/server/viewer';
import type { PageServerLoad } from './$types';

/**
 * The series directory (Reading Tracker R1).
 *
 * No "new series" form: a series is born from a book's own page, the same as
 * an author — see reading.ts's `findOrCreateBookSeries`.
 */

export const load: PageServerLoad = async ({ locals }) => {
	const viewer = await requireViewer(locals.user);
	const series = await listBookSeries(sql, viewer, { limit: 300 });
	return { series };
};
