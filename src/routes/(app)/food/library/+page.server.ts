import { fail } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import {
	createFood,
	listFoods,
	setFoodArchived,
	updateFood,
	type WriteFailure
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * The Food Library: every food's per-serving nutrients, the source `/food/log`
 * draws on alongside recipes. Its own page rather than a form on `/food`, the
 * same reasoning `/food/ingredients` gives for its own: setting up a food
 * properly is a rarer task than logging one already there.
 *
 * `?archived=1` shows what has been taken off the library instead of what is
 * in it, the same convention `/food/ingredients` uses.
 */

const HISTORY_LIMIT = 500;

export const load: PageServerLoad = async ({ locals, url }) => {
	const viewer = await requireViewer(locals.user);
	const archived = url.searchParams.get('archived') === '1';

	const all = await listFoods(sql, viewer, { limit: HISTORY_LIMIT, includeArchived: true });
	const foods = all.filter((f) => (f.archivedAt !== null) === archived);

	return { foods, archived };
};

const foodFields = (form: FormData) => ({
	name: form.get('name'),
	brand: form.get('brand'),
	serving: form.get('serving'),
	kcalPerServing: form.get('kcalPerServing'),
	proteinG: form.get('proteinG'),
	carbsG: form.get('carbsG'),
	fibreG: form.get('fibreG'),
	sugarG: form.get('sugarG'),
	totalFatG: form.get('totalFatG'),
	sodiumMg: form.get('sodiumMg'),
	notes: form.get('notes'),
	isFavourite: form.get('isFavourite')
});

/** `not_found` also covers "not yours to see" (base.ts). */
const statusFor = (reason: WriteFailure): number =>
	reason === 'invalid' ? 400 : reason === 'forbidden' ? 403 : reason === 'conflict' ? 409 : 404;

export const actions: Actions = {
	create: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await createFood(sql, viewer, foodFields(form));
		if (!result.ok) {
			return fail(statusFor(result.reason), {
				action: 'create' as const,
				error: result.reason === 'invalid' ? result.message : 'Could not add that food.'
			});
		}
		return { action: 'create' as const, savedId: result.record.id };
	},

	update: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const expected = form.get('expectedUpdatedAt');

		const result = await updateFood(
			sql,
			viewer,
			id,
			foodFields(form),
			expected ? String(expected) : undefined
		);
		if (!result.ok) {
			const error =
				result.reason === 'invalid'
					? result.message
					: result.reason === 'conflict'
						? 'This food changed elsewhere — reload and try again.'
						: result.reason === 'forbidden'
							? 'You cannot change this food.'
							: 'Could not find that food.';
			return fail(statusFor(result.reason), { action: 'update' as const, error });
		}
		return { action: 'update' as const, savedId: result.record.id };
	},

	archive: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const archived = form.get('archived') === 'true';

		const result = await setFoodArchived(sql, viewer, String(form.get('id') ?? ''), archived);
		if (!result.ok) {
			return fail(statusFor(result.reason), {
				action: 'archive' as const,
				error: archived ? 'Could not archive that food.' : 'Could not restore that food.'
			});
		}
		return { action: 'archive' as const, archived };
	}
};
