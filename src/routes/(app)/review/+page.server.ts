import { fail } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import {
	REVIEW_KINDS,
	goalsNeedingSetup,
	householdToday,
	markReviewed,
	reviewQueue,
	type ReviewKind
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * For Review.
 *
 * Two questions, which the source workspace asks on the same page: what is due
 * to be looked at, and what has been set up in a way that will not survive
 * being looked at — a goal with no project and no habit behind it.
 */

const isKind = (value: unknown): value is ReviewKind =>
	REVIEW_KINDS.includes(String(value) as ReviewKind);

export const load: PageServerLoad = async ({ locals, url }) => {
	const viewer = await requireViewer(locals.user);
	const today = await householdToday(sql, viewer.householdId);
	const showUpcoming = url.searchParams.get('view') === 'all';

	const [queue, unsupported] = await Promise.all([
		reviewQueue(sql, viewer, today, { includeUpcoming: showUpcoming, limit: 200 }),
		goalsNeedingSetup(sql, viewer)
	]);

	return {
		today,
		showUpcoming,
		due: queue.filter((item) => item.overdueDays >= 0),
		upcoming: queue.filter((item) => item.overdueDays < 0),
		unsupported
	};
};

export const actions: Actions = {
	markReviewed: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const kind = form.get('kind');

		if (!isKind(kind)) return fail(400, { error: 'Not something that can be reviewed.' });

		const today = await householdToday(sql, viewer.householdId);
		const result = await markReviewed(sql, viewer, kind, String(form.get('id') ?? ''), today);

		if (!result.ok) {
			return fail(result.reason === 'not_found' ? 404 : 400, {
				error: 'Could not mark that as reviewed.'
			});
		}
		return { reviewed: result.record.id };
	}
};
