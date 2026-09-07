import { fail } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import { listTags, touchLibraryItem } from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import { loadShelf } from '../library/shelf';
import type { Actions, PageServerLoad } from './$types';

/**
 * Knowledge Hub.
 *
 * Two questions the plain library view does not answer: what did I actually
 * keep something out of, and what have I not looked at in long enough to have
 * forgotten. The source computes a "Rediscover Age" for the second; here it is
 * an ordering rather than a stored number, so it cannot go stale.
 */

export const load: PageServerLoad = async ({ locals }) => {
	const viewer = await requireViewer(locals.user);

	const [kept, rediscover, tags] = await Promise.all([
		loadShelf(viewer, { status: 'live', withHighlights: true, order: 'recent', limit: 20 }),
		loadShelf(viewer, { status: ['live', 'archived_read'], order: 'stale', limit: 10 }),
		listTags(sql, viewer, { limit: 60 })
	]);

	return {
		kept: kept.items,
		rediscover: rediscover.items,
		summary: kept.summary,
		tags: tags.map((t) => ({ id: t.id, name: t.name }))
	};
};

export const actions: Actions = {
	touch: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const result = await touchLibraryItem(sql, viewer, String(form.get('id') ?? ''));
		if (!result.ok) return fail(404, { error: 'Could not find that entry.' });
		return { touched: result.record.id };
	}
};
