import { fail } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import {
	coversForPages,
	foodSummary,
	householdToday,
	isDay,
	weekWindow,
	ingredientAisles,
	ingredientStatusCounts,
	listIngredients,
	listPrepTasks,
	listRecipes,
	mealPlan,
	setPrepTaskDone,
	updateIngredient
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * Food HQ.
 *
 * What is planned, what needs buying, and what can be made. The shopping list
 * is not a list of its own — it is the ingredients whose status says so, which
 * is why a "buy this" can never drift out of sync with the pantry.
 */

/** A week is the unit a meal plan is actually made in. */
const PLAN_DAYS = 7;

/*
 * The window used to begin at today, which quietly made every plan already
 * eaten this week invisible — and on a freshly imported workspace it made the
 * whole planner look empty, because an import carries the weeks you have lived,
 * not the ones you have not. 14 imported plans, none of them shown.
 *
 * Anchoring to the week start also matches how the plan is made: a week is the
 * unit, so the page shows the week rather than the next seven days from
 * wherever you happen to be standing in it. `weekWindow` is the repository's
 * own helper, so this agrees with everything else that talks about weeks.
 */

export const load: PageServerLoad = async ({ locals, url }) => {
	const viewer = await requireViewer(locals.user);
	const today = await householdToday(sql, viewer.householdId);

	// `?from=` moves the window. Validated rather than trusted: it reaches SQL
	// as a date bound, and an unparseable value should show this week rather
	// than fail the page.
	const requested = url.searchParams.get('from');
	const from = weekWindow(isDay(requested) ? requested : today).start;
	const until = addDays(from, PLAN_DAYS - 1);

	const [plan, shopping, aisles, statusCounts, recipes, prep, summary] = await Promise.all([
		mealPlan(sql, viewer, from, until),
		listIngredients(sql, viewer, { status: 'shopping_list', order: 'aisle', limit: 300 }),
		ingredientAisles(sql, viewer),
		ingredientStatusCounts(sql, viewer),
		listRecipes(sql, viewer, { order: 'name', limit: 100 }),
		listPrepTasks(sql, viewer, { openOnly: true, limit: 50 }),
		foodSummary(sql, viewer)
	]);

	// The plan is keyed by date so the page can render every day in the window,
	// including the ones with nothing on them — an empty Thursday is the most
	// useful thing a meal plan can tell you.
	// If this week has nothing on it, say where the nearest plan actually is.
	//
	// Without this, a freshly imported workspace opens on an empty week with no
	// indication that fourteen planned days exist one click away — the page is
	// correct and looks like the feature does not work. Only asked when the
	// window is empty, so the common case costs nothing.
	const empty = plan.every((day) => day.meals.length === 0);
	const [nearest] = empty
		? await sql<{ on_date: string }[]>`
				select mp.on_date::text as on_date
				from meal_plans mp
				join meal_plan_recipes mpr on mpr.meal_plan_id = mp.id
				where mp.household_id = ${viewer.householdId}::uuid
				order by abs(mp.on_date - ${from}::date)
				limit 1
			`
		: [];

	// Covers for the recipe list, in one query rather than one per card.
	const covers = await coversForPages(
		sql,
		viewer,
		recipes.map((recipe) => recipe.notionPageId)
	);
	const recipesWithCovers = recipes.map((recipe) => ({
		...recipe,
		cover: (recipe.notionPageId && covers.get(recipe.notionPageId)) || null
	}));

	const planned = new Map(plan.map((day) => [day.onDate, day]));
	const days = Array.from({ length: PLAN_DAYS }, (_, i) => {
		const date = addDays(from, i);
		return { date, day: planned.get(date) ?? null };
	});

	return {
		today,
		from,
		// The week to offer when this one is empty, or null when there is
		// genuinely nothing planned anywhere.
		nearestPlan: nearest ? weekWindow(nearest.on_date).start : null,
		previous: addDays(from, -PLAN_DAYS),
		next: addDays(from, PLAN_DAYS),
		// Whether the window is the one containing today, so the page can offer
		// a way back without having to work out the week itself.
		isThisWeek: from === weekWindow(today).start,
		days,
		shopping,
		aisles,
		statusCounts,
		recipes: recipesWithCovers,
		prep,
		summary
	};
};

/** Plain calendar arithmetic on a YYYY-MM-DD string, no timezone involved. */
function addDays(day: string, delta: number): string {
	const d = new Date(`${day}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + delta);
	return d.toISOString().slice(0, 10);
}

export const actions: Actions = {
	/** Moves an ingredient between the pantry and the shopping list. */
	setStatus: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await updateIngredient(sql, viewer, String(form.get('id') ?? ''), {
			status: form.get('status')
		});

		if (!result.ok) {
			return fail(result.reason === 'invalid' ? 400 : 404, {
				error: result.reason === 'invalid' ? result.message : 'Could not update that.'
			});
		}
		return { updated: result.record.id };
	},

	togglePrep: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const result = await setPrepTaskDone(
			sql,
			viewer,
			String(form.get('id') ?? ''),
			form.get('done') === 'true'
		);
		if (!result.ok) return fail(400, { error: 'Could not update that prep task.' });
		return { prepped: true };
	}
};
