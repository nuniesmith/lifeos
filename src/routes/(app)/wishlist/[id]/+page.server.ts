import { error, fail } from '@sveltejs/kit';
import { canWrite } from '$lib/server/auth/authz';
import { sql } from '$lib/server/db';
import { safeLinkUrl } from '$lib/server/markdown';
import {
	getWishlistItem,
	listPeople,
	setWishlistItemStatus,
	updateWishlistItem,
	type WriteResult
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * One wishlist item: editing what /wishlist and a person's own page can only
 * list (PACK1-002 / PACK5-002, the wishlist-editing slice of PACK5-002).
 *
 * "Mark bought" and "mark given" are their own one-shot actions rather than a
 * status field on the general edit form, the same reasoning as a recipe's
 * "made it today": stating a fact outright is harmless to repeat and needs no
 * version to conflict over.
 */

export const load: PageServerLoad = async ({ locals, params }) => {
	const viewer = await requireViewer(locals.user);

	const item = await getWishlistItem(sql, viewer, params.id);
	// 404 rather than 403 for someone else's private item: saying that it
	// exists at all is itself the disclosure.
	if (!item) error(404, 'Not found');

	const people = await listPeople(sql, viewer, { kind: ['me', 'person'], limit: 200 });

	// The source link is checked on the way out as well as on the way in: an
	// imported value never went through the repository's validation.
	const href = safeLinkUrl(item.url);
	const source = item.url ? { href, label: href ?? item.url } : null;

	return {
		item,
		people: people.map((p) => ({ id: p.id, name: p.name })),
		source,
		// Presentation only: every action below is refused in SQL for someone
		// who may read this item but not write it, whatever the page offered.
		canEdit: canWrite(item, viewer)
	};
};

type Action = 'save' | 'status' | 'favourite';

/** One refusal wording per reason, so every action explains itself the same way. */
function refused(action: Action, result: Extract<WriteResult<unknown>, { ok: false }>) {
	switch (result.reason) {
		case 'conflict':
			return fail(409, {
				action,
				error: 'This item changed somewhere else. Reload to see the current version.'
			});
		case 'invalid':
			return fail(400, { action, error: result.message ?? 'That change is not valid.' });
		case 'forbidden':
			return fail(403, { action, error: 'You cannot change this item.' });
		default:
			return fail(404, { action, error: 'Could not find that item.' });
	}
}

export const actions: Actions = {
	save: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await updateWishlistItem(
			sql,
			viewer,
			params.id,
			{
				name: form.get('name'),
				itemType: form.get('itemType'),
				priceRange: form.get('priceRange'),
				purpose: form.get('purpose'),
				shopSource: form.get('shopSource'),
				url: form.get('url'),
				occasion: form.get('occasion'),
				forPersonId: form.get('forPersonId') || null
			},
			// The version the form was rendered from: a save from a stale tab is
			// refused rather than overwriting what the other person changed.
			String(form.get('updatedAt') ?? '')
		);
		if (!result.ok) return refused('save', result);
		return { action: 'save', saved: true };
	},

	status: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await setWishlistItemStatus(sql, viewer, params.id, form.get('status'));
		if (!result.ok) return refused('status', result);
		return { action: 'status', status: result.record.status };
	},

	favourite: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await updateWishlistItem(sql, viewer, params.id, {
			isFavourite: form.get('favourite') === 'true'
		});
		if (!result.ok) return refused('favourite', result);
		return { action: 'favourite', favourite: result.record.isFavourite };
	}
};
