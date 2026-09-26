import { sql } from '$lib/server/db';
import { coversForPages, listRecipes } from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { PageServerLoad } from './$types';

/**
 * Every recipe, each leading to its own page.
 *
 * Food HQ shows the first dozen beside the week and says how many more there
 * are; without this page those were reachable only by searching for them by
 * name, which assumes you remember what you have.
 */
export const load: PageServerLoad = async ({ locals }) => {
	const viewer = await requireViewer(locals.user);

	const recipes = await listRecipes(sql, viewer, { order: 'name', limit: 500 });
	// One query for every card's cover rather than one per card.
	const covers = await coversForPages(
		sql,
		viewer,
		recipes.map((recipe) => recipe.notionPageId)
	);

	return {
		recipes: recipes.map((recipe) => ({
			id: recipe.id,
			name: recipe.name,
			totalMinutes: recipe.totalMinutes,
			servings: recipe.servings,
			kcalPerServing: recipe.kcalPerServing,
			courses: recipe.courses,
			isFavourite: recipe.isFavourite,
			cover: (recipe.notionPageId && covers.get(recipe.notionPageId)) || null
		}))
	};
};
