import { fail } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import {
	createIngredient,
	listIngredients,
	setIngredientArchived,
	updateIngredient,
	type WriteFailure
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * Every ingredient — the pantry, not only what is on the shopping list — with
 * a sheet to add one and to edit one fully.
 *
 * Its own page rather than a form on /food: Food HQ's shopping list is
 * already the household's most-used view of the pantry, grouped by aisle for
 * walking a shop, and adding a second, longer form to that page for the rare
 * "set up a new ingredient properly" task would bury the thing people open
 * /food to do every day. This mirrors /food/recipes — a plain list leading to
 * the one place each record is edited.
 *
 * `?archived=1` shows what has been taken off the pantry instead of what is
 * on it, so restoring one does not require the general Archive.
 */

const HISTORY_LIMIT = 500;

export const load: PageServerLoad = async ({ locals, url }) => {
	const viewer = await requireViewer(locals.user);
	const archived = url.searchParams.get('archived') === '1';

	const all = await listIngredients(sql, viewer, {
		order: 'aisle',
		limit: HISTORY_LIMIT,
		includeArchived: true
	});
	const ingredients = all.filter((i) => (i.archivedAt !== null) === archived);

	return { ingredients, archived };
};

const ingredientFields = (form: FormData) => ({
	name: form.get('name'),
	aisle: form.get('aisle'),
	category: form.get('category'),
	status: form.get('status'),
	isStaple: form.get('isStaple'),
	store: form.get('store'),
	quantity: form.get('quantity'),
	quantityValue: form.get('quantityValue'),
	quantityUnit: form.get('quantityUnit'),
	preferredBrand: form.get('preferredBrand'),
	notes: form.get('notes')
});

/** `not_found` also covers "not yours to see" (base.ts). */
const statusFor = (reason: WriteFailure): number =>
	reason === 'invalid' ? 400 : reason === 'forbidden' ? 403 : reason === 'conflict' ? 409 : 404;

export const actions: Actions = {
	create: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await createIngredient(sql, viewer, ingredientFields(form));
		if (!result.ok) {
			return fail(statusFor(result.reason), {
				action: 'create' as const,
				error: result.reason === 'invalid' ? result.message : 'Could not add that ingredient.'
			});
		}
		return { action: 'create' as const, savedId: result.record.id };
	},

	update: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const expected = form.get('expectedUpdatedAt');

		const result = await updateIngredient(
			sql,
			viewer,
			id,
			ingredientFields(form),
			expected ? String(expected) : undefined
		);
		if (!result.ok) {
			const error =
				result.reason === 'invalid'
					? result.message
					: result.reason === 'conflict'
						? 'This ingredient changed elsewhere — reload and try again.'
						: result.reason === 'forbidden'
							? 'You cannot change this ingredient.'
							: 'Could not find that ingredient.';
			return fail(statusFor(result.reason), { action: 'update' as const, error });
		}
		return { action: 'update' as const, savedId: result.record.id };
	},

	archive: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const archived = form.get('archived') === 'true';

		const result = await setIngredientArchived(sql, viewer, String(form.get('id') ?? ''), archived);
		if (!result.ok) {
			return fail(statusFor(result.reason), {
				action: 'archive' as const,
				error: archived
					? 'Could not archive that ingredient.'
					: 'Could not restore that ingredient.'
			});
		}
		return { action: 'archive' as const, archived };
	}
};
