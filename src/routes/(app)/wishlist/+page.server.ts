import { fail } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import { createWishlistItem, listPeople, listWishlist } from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/** Wishlist — what people want, and who it is for. */

export const load: PageServerLoad = async ({ locals }) => {
	const viewer = await requireViewer(locals.user);
	const [wanted, settled, people] = await Promise.all([
		listWishlist(sql, viewer, { status: 'wanted', limit: 200 }),
		listWishlist(sql, viewer, { status: ['bought', 'given'], limit: 50 }),
		listPeople(sql, viewer, { kind: ['me', 'person'], limit: 200 })
	]);
	return {
		wanted,
		settled,
		people: people.map((p) => ({ id: p.id, name: p.name }))
	};
};

export const actions: Actions = {
	add: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const result = await createWishlistItem(sql, viewer, {
			name: form.get('name'),
			occasion: form.get('occasion'),
			forPersonId: form.get('forPersonId') || null
		});
		if (!result.ok) {
			return fail(result.reason === 'invalid' ? 400 : 403, {
				error: result.reason === 'invalid' ? result.message : 'Not allowed.'
			});
		}
		return { added: result.record.id };
	}
};
