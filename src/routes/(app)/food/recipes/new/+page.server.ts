import { fail, redirect } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import { createRecipe } from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * A new recipe.
 *
 * Its own page rather than a form on /food: Food HQ is the week, the shopping
 * list and the prep, and a recipe's method is too long a thing to type into a
 * corner of that. Only the name is required — a recipe is often saved as a
 * name and a link first, and written up the first time it is cooked.
 *
 * Household-wide, like every recipe: dinner is a household fact. The form
 * offers no privacy control and the action accepts none.
 */

export const load: PageServerLoad = async ({ locals }) => {
	await requireViewer(locals.user);
	return {};
};

export const actions: Actions = {
	default: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const values = {
			name: String(form.get('name') ?? ''),
			servings: String(form.get('servings') ?? ''),
			prepMinutes: String(form.get('prepMinutes') ?? ''),
			cookMinutes: String(form.get('cookMinutes') ?? ''),
			url: String(form.get('url') ?? ''),
			notes: String(form.get('notes') ?? '')
		};

		const result = await createRecipe(sql, viewer, values);
		if (!result.ok) {
			// The values go back so a refused save does not cost the method
			// someone just typed out.
			return fail(400, {
				error: result.reason === 'invalid' ? result.message : 'Could not save that recipe.',
				values
			});
		}

		redirect(303, `/food/recipes/${result.record.id}`);
	}
};
