import { fail } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import {
	foodSummary,
	householdToday,
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

export const load: PageServerLoad = async ({ locals }) => {
	const viewer = await requireViewer(locals.user);
	const today = await householdToday(sql, viewer.householdId);
	const until = addDays(today, PLAN_DAYS - 1);

	const [plan, shopping, aisles, statusCounts, recipes, prep, summary] = await Promise.all([
		mealPlan(sql, viewer, today, until),
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
	const planned = new Map(plan.map((day) => [day.onDate, day]));
	const days = Array.from({ length: PLAN_DAYS }, (_, i) => {
		const date = addDays(today, i);
		return { date, day: planned.get(date) ?? null };
	});

	return { today, days, shopping, aisles, statusCounts, recipes, prep, summary };
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
