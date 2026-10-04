import { fail } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import {
	createReadingChallenge,
	householdToday,
	listReadingChallenges
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * Every reading challenge the viewer may see (Reading Tracker R3), plus the
 * quick-add form for a new one. This year's first, older years below — the
 * page itself partitions the one list by year rather than the repository
 * taking a year filter nothing else needs, the same trade-off `/reading`'s
 * own "Up next" vs "Recently read" split makes with one `listBooks` call.
 *
 * The add form only ever sends title, year, kind and (for a count challenge)
 * a target — everything else a challenge can carry (notes, and a count
 * challenge's category/format/genre filters) is edited afterwards on its own
 * detail page, the same "add the one thing, fill in the rest later"
 * shortcut `/reading`'s own add-a-book form takes.
 */

export const load: PageServerLoad = async ({ locals }) => {
	const viewer = await requireViewer(locals.user);
	const [challenges, today] = await Promise.all([
		listReadingChallenges(sql, viewer, { limit: 300 }),
		householdToday(sql, viewer.householdId)
	]);
	return { challenges, currentYear: Number(today.slice(0, 4)) };
};

export const actions: Actions = {
	add: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await createReadingChallenge(sql, viewer, {
			title: form.get('title'),
			year: form.get('year'),
			kind: form.get('kind'),
			targetCount: form.get('targetCount')
		});
		if (!result.ok) {
			return fail(400, {
				action: 'add',
				error: result.message ?? 'That challenge could not be added.'
			});
		}
		return { action: 'add', added: result.record.id };
	}
};
