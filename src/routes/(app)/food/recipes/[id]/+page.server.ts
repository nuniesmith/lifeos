import { error, fail, redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { canWrite } from '$lib/server/auth/authz';
import { sql } from '$lib/server/db';
import { renderMarkdown, safeLinkUrl } from '$lib/server/markdown';
import {
	addRecipeIngredient,
	attachNewIngredientToRecipe,
	bodyImagesForPage,
	coversForPages,
	getRecipe,
	householdToday,
	ingredientsForRecipe,
	listIngredients,
	removeRecipeIngredient,
	setRecipeArchived,
	updateRecipe,
	type WriteResult
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * One recipe: what it takes, what it makes, and how.
 *
 * Every recipe's method has been in the database since the first import — the
 * importer puts each Notion page body into `recipes.notes` — and until this
 * page nothing showed it: recipes were cards on /food and search results that
 * led back to the same cards. The body is Markdown, rendered here on the
 * server through `$lib/server/markdown`, and the page receives only the
 * sanitized HTML.
 */

export const load: PageServerLoad = async ({ locals, params }) => {
	const viewer = await requireViewer(locals.user);

	// Archived recipes load too: the Archive links here, and this page is
	// where one is looked at before it is brought back.
	const recipe = await getRecipe(sql, viewer, params.id);
	// 404 rather than 403 for someone else's private recipe: saying that it
	// exists is itself the disclosure.
	if (!recipe) error(404, 'Recipe not found');

	const [ingredients, allIngredients, covers, bodyImages, today] = await Promise.all([
		ingredientsForRecipe(sql, viewer, recipe.id),
		// For "attach an ingredient": every ingredient the household can see,
		// so picking one is a client-side filter rather than a query per
		// keystroke — the same trade-off the meal-plan sheet makes over recipes.
		listIngredients(sql, viewer, { order: 'name', limit: 500 }),
		// The display copy, not the list thumbnail: this one is drawn at card width.
		coversForPages(sql, viewer, [recipe.notionPageId], 'display'),
		bodyImagesForPage(sql, viewer, recipe.notionPageId),
		householdToday(sql, viewer.householdId)
	]);

	const cover = (recipe.notionPageId && covers.get(recipe.notionPageId)) || null;

	// The source link is checked on the way out as well as on the way in: an
	// imported value never went through the repository's validation.
	// A mailto or tel link is safe but is not a source; only a web page is linked.
	const href = safeLinkUrl(recipe.url);
	const web = href && /^https?:/.test(href) ? new URL(href) : null;
	const source = recipe.url
		? { href: web ? web.href : null, label: web ? web.hostname : recipe.url }
		: null;

	return {
		recipe,
		cover: cover ? { id: cover.id, width: cover.width, height: cover.height } : null,
		ingredients: ingredients.map(({ ingredient, amount, amountValue, amountUnit }) => ({
			id: ingredient.id,
			name: ingredient.name,
			amount: amount?.trim() || null,
			amountValue,
			amountUnit,
			status: ingredient.status
		})),
		// Ingredients not already on this recipe, for the "add" sheet's picker.
		// Filtered here rather than in the component so the sheet never has to
		// be told which ids are already attached.
		pickableIngredients: allIngredients
			.filter((i) => !ingredients.some((linked) => linked.ingredient.id === i.id))
			.map((i) => ({ id: i.id, name: i.name, aisle: i.aisle, status: i.status })),
		// Sanitized HTML, never Markdown: see $lib/server/markdown for what is
		// allowed through. `# Method` in a body lands as an <h3>, under the
		// card's own <h2>, rather than competing with the page's <h1>.
		instructions: renderMarkdown(recipe.notes, {
			images: bodyImages,
			mediaUrl: (id) => resolve('/api/media/[id]', { id }),
			headingOffset: 2
		}),
		source,
		today,
		// Presentation only: every action below is refused in SQL for someone
		// who may not write this recipe, whatever the page offered them.
		canEdit: canWrite(recipe, viewer)
	};
};

type Action = 'save' | 'favourite' | 'made' | 'archive' | 'attachNew' | 'setAmount' | 'detach';

/**
 * One refusal wording per reason, so every action explains itself the same
 * way. `action` says which form it answers, so the page can put a failed
 * save's message beside the form it came from rather than at the top of a
 * long page.
 */
function refused(action: Action, result: Extract<WriteResult<unknown>, { ok: false }>) {
	switch (result.reason) {
		case 'conflict':
			return fail(409, {
				action,
				error: 'This recipe changed somewhere else. Reload to see the current version.'
			});
		case 'invalid':
			return fail(400, { action, error: result.message ?? 'That change is not valid.' });
		case 'forbidden':
			return fail(403, { action, error: 'You cannot change this recipe.' });
		default:
			return fail(404, { action, error: 'Could not find that recipe.' });
	}
}

/**
 * `addRecipeIngredient` / `removeRecipeIngredient` never return `forbidden` or
 * `conflict` — a pairing carries no version of its own, and the only scopes
 * involved are checked inside the one statement that writes — so this covers
 * just the two reasons they can actually give. `not_found` deliberately does
 * not say which side of the pairing was the problem: a recipe that does not
 * exist and an ingredient that is not the viewer's to see must read the same
 * from here, or the message itself would be the disclosure.
 */
function ingredientRefused(action: Action, result: Extract<WriteResult<unknown>, { ok: false }>) {
	if (result.reason === 'invalid') {
		return fail(400, { action, error: result.message ?? 'That amount is not valid.' });
	}
	return fail(404, { action, error: 'Could not find that recipe or ingredient.' });
}

export const actions: Actions = {
	save: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await updateRecipe(
			sql,
			viewer,
			params.id,
			{
				name: form.get('name'),
				servings: form.get('servings'),
				prepMinutes: form.get('prepMinutes'),
				cookMinutes: form.get('cookMinutes'),
				additionalMinutes: form.get('additionalMinutes'),
				url: form.get('url'),
				notes: form.get('notes')
			},
			// The version the form was rendered from: a save from a stale tab is
			// refused rather than overwriting what the other person changed.
			String(form.get('updatedAt') ?? '')
		);
		if (!result.ok) return refused('save', result);
		return { saved: true };
	},

	/*
	 * Favourite and "made today" each state one fact outright, rather than
	 * flipping one, so they carry no version: repeating either is harmless, and
	 * refusing a tap because the other person fixed a typo in the method would
	 * be a conflict the viewer cannot see the cause of.
	 */
	favourite: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const result = await updateRecipe(sql, viewer, params.id, {
			isFavourite: form.get('favourite') === 'true'
		});
		if (!result.ok) return refused('favourite', result);
		return { favourite: result.record.isFavourite };
	},

	made: async ({ locals, params }) => {
		const viewer = await requireViewer(locals.user);
		// Today on the household's clock: a dinner made at 11pm was made today,
		// whatever UTC says.
		const today = await householdToday(sql, viewer.householdId);
		const result = await updateRecipe(sql, viewer, params.id, { lastMadeOn: today });
		if (!result.ok) return refused('made', result);
		return { made: today };
	},

	archive: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const archived = form.get('archived') === 'true';

		const result = await setRecipeArchived(sql, viewer, params.id, archived);
		if (!result.ok) return refused('archive', result);

		// Archiving takes it out of view, so back to Food HQ, where the page's
		// own back link leads. Restoring leaves you on the recipe you just
		// brought back.
		if (archived) redirect(303, '/food');
		return { restored: true };
	},

	/**
	 * Creates a new ingredient and attaches it in one step, for "or add a new
	 * one" in the attach sheet. Only the name is required, matching how an
	 * ingredient can be added everywhere else in the pantry.
	 */
	attachNew: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await attachNewIngredientToRecipe(
			sql,
			viewer,
			params.id,
			{ name: form.get('name'), aisle: form.get('aisle') },
			{ text: form.get('amount'), value: form.get('amountValue'), unit: form.get('amountUnit') }
		);
		if (!result.ok) return ingredientRefused('attachNew', result);
		return { action: 'attachNew' as const };
	},

	/**
	 * Attaches an existing ingredient with an amount, or — sent for one
	 * already on the recipe — changes its amount: `addRecipeIngredient` is one
	 * UPSERT either way (respecting `recipe_ingredients`'s primary key), so
	 * "pick an ingredient" and "edit its amount" are the same action here.
	 */
	setAmount: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await addRecipeIngredient(
			sql,
			viewer,
			params.id,
			String(form.get('ingredientId') ?? ''),
			{ text: form.get('amount'), value: form.get('amountValue'), unit: form.get('amountUnit') }
		);
		if (!result.ok) return ingredientRefused('setAmount', result);
		return { action: 'setAmount' as const };
	},

	detach: async ({ locals, params, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await removeRecipeIngredient(
			sql,
			viewer,
			params.id,
			String(form.get('ingredientId') ?? '')
		);
		if (!result.ok) return ingredientRefused('detach', result);
		return { action: 'detach' as const };
	}
};
