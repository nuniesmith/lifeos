import { fail } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import { createPerson, listPeople, listWishlist, personGroups } from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * People & Places.
 *
 * The wishlist is shown against each person because that is the question this
 * page is actually opened to answer — what do I get them — and a gift list
 * kept somewhere else is a gift list nobody looks at.
 */

export const load: PageServerLoad = async ({ locals, url }) => {
	const viewer = await requireViewer(locals.user);
	const group = url.searchParams.get('group')?.trim() || undefined;

	const [people, groups, wishlist] = await Promise.all([
		listPeople(sql, viewer, { ...(group ? { group } : {}), limit: 200 }),
		personGroups(sql, viewer),
		listWishlist(sql, viewer, { status: 'wanted', limit: 300 })
	]);

	const giftsFor: Record<string, { id: string; name: string; occasion: string | null }[]> = {};
	for (const item of wishlist) {
		if (!item.forPersonId) continue;
		(giftsFor[item.forPersonId] ??= []).push({
			id: item.id,
			name: item.name,
			occasion: item.occasion
		});
	}

	return { people, groups, group: group ?? null, giftsFor };
};

export const actions: Actions = {
	add: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const result = await createPerson(sql, viewer, {
			name: form.get('name'),
			kind: form.get('kind'),
			groups: form.get('groups')
		});
		if (!result.ok) {
			return fail(result.reason === 'invalid' ? 400 : 403, {
				error: result.reason === 'invalid' ? result.message : 'Not allowed.'
			});
		}
		return { added: result.record.id };
	}
};
