import { fail } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import {
	MEAL_SLOTS,
	addPlanToShoppingList,
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
	nearestPlannedDay,
	planMeal,
	setPrepTaskDone,
	undoPlanShopping,
	unplanMeal,
	updateIngredient,
	type MealSlot,
	type WriteFailure
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
	const nearest = empty ? await nearestPlannedDay(sql, viewer, from) : null;

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
		nearestPlan: nearest ? weekWindow(nearest).start : null,
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
	},

	/** Plans a recipe into one slot of one day, opening the day if it has no plan. */
	plan: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const date = String(form.get('date') ?? '');
		const slot = String(form.get('slot') ?? '');

		if (!isDay(date)) return fail(400, { error: 'Pick a day to plan.' });
		if (!isMealSlot(slot)) return fail(400, { error: 'Pick breakfast, lunch, dinner or a snack.' });

		const result = await planMeal(sql, viewer, date, slot, String(form.get('recipeId') ?? ''));
		if (!result.ok) {
			return fail(statusFor(result.reason), {
				error:
					result.reason === 'forbidden'
						? 'That day’s plan belongs to someone else, so it cannot be changed here.'
						: result.reason === 'invalid' && result.message
							? capitalise(result.message)
							: 'Could not plan that recipe.'
			});
		}
		return { planned: { date, slot, alreadyPlanned: result.record.alreadyPlanned } };
	},

	unplan: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const slot = String(form.get('slot') ?? '');
		if (!isMealSlot(slot)) return fail(400, { error: 'Could not remove that meal.' });

		const result = await unplanMeal(
			sql,
			viewer,
			String(form.get('mealPlanId') ?? ''),
			slot,
			String(form.get('recipeId') ?? '')
		);
		if (!result.ok) return fail(statusFor(result.reason), { error: 'Could not remove that meal.' });
		return { unplanned: true };
	},

	/**
	 * Puts the ingredients of the week being viewed on the shopping list. The
	 * week is recomputed from `from` rather than trusted as a range, so a
	 * crafted form cannot sweep a year of plans into the list.
	 */
	shopWeek: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const requested = String(form.get('from') ?? '');
		if (!isDay(requested)) return fail(400, { error: 'Which week? That is not a date.' });

		const week = weekWindow(requested);
		const result = await addPlanToShoppingList(sql, viewer, week.start, week.end);
		if (!result.ok) {
			return fail(statusFor(result.reason), { error: 'Could not add the week to the list.' });
		}
		return { shopped: { from: week.start, ...result.record } };
	},

	/** Takes back exactly what `shopWeek` added, while it is still on the list. */
	undoShopWeek: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const ids = form.getAll('id').map(String);

		const result = await undoPlanShopping(sql, viewer, ids);
		if (!result.ok) return fail(statusFor(result.reason), { error: 'Could not undo that.' });
		return { unshopped: result.record };
	}
};

const isMealSlot = (value: string): value is MealSlot =>
	(MEAL_SLOTS as readonly string[]).includes(value);

/** A refusal's HTTP status; `not_found` also covers "not yours to see". */
const statusFor = (reason: WriteFailure): number =>
	reason === 'invalid' ? 400 : reason === 'forbidden' ? 403 : reason === 'conflict' ? 409 : 404;

/** Repository messages are sentence fragments; the page shows sentences. */
const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1) + '.';
