import { fail } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import {
	addDays,
	createFoodLogEntry,
	deleteFoodLogEntry,
	householdToday,
	isDay,
	listFoodLogEntriesForDay,
	listFoods,
	listRecipes,
	mealTotals,
	nutritionTotals,
	proteinByMonth,
	updateFoodLogEntry,
	type WriteFailure
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * The food log: one day at a time, grouped by meal, with a quick way to log
 * a food, a recipe, or a one-off, and the totals a household actually reviews
 * — per meal, for the day, the last week, and this month's protein.
 */

/** A food/recipe picker with hundreds of rows would need paging; this
 *  household's library and recipe box are nowhere near that. */
const PICKER_LIMIT = 500;

export const load: PageServerLoad = async ({ locals, url }) => {
	const viewer = await requireViewer(locals.user);
	const today = await householdToday(sql, viewer.householdId);
	const requested = url.searchParams.get('date');
	const date = requested && isDay(requested) ? requested : today;
	const shared = url.searchParams.get('shared') === '1';
	const weekStart = addDays(today, -6);

	const [entries, dayTotals, meals, foods, recipes, week, months] = await Promise.all([
		listFoodLogEntriesForDay(sql, viewer, date, { includeHousehold: shared }),
		nutritionTotals(sql, viewer, date, date),
		mealTotals(sql, viewer, date),
		listFoods(sql, viewer, { limit: PICKER_LIMIT }),
		listRecipes(sql, viewer, { limit: PICKER_LIMIT }),
		nutritionTotals(sql, viewer, weekStart, today),
		proteinByMonth(sql, viewer, 1)
	]);

	// Zero-filled so a day with nothing logged still gets a row in the table
	// ("nothing logged" is different information from "0 kcal logged").
	const byDay = new Map(week.map((t) => [t.day, t]));
	const lastSevenDays = Array.from({ length: 7 }, (_, i) => {
		const day = addDays(weekStart, i);
		return byDay.get(day) ?? { day, kcal: null, proteinG: null };
	});

	return {
		date,
		today,
		shared,
		viewerId: viewer.userId,
		previousDate: addDays(date, -1),
		nextDate: addDays(date, 1),
		entries,
		dayTotal: dayTotals[0] ?? null,
		meals,
		lastSevenDays,
		monthProtein: months[0] ?? null,
		// Trimmed to what the picker and its serving hint need — nothing here
		// is server-only data the browser should not already have.
		foods: foods.map((f) => ({
			id: f.id,
			name: f.name,
			serving: f.serving,
			kcalPerServing: f.kcalPerServing,
			proteinG: f.proteinG
		})),
		recipes: recipes.map((r) => ({
			id: r.id,
			name: r.name,
			servings: r.servings,
			kcalPerServing: r.kcalPerServing,
			proteinG: r.proteinG
		}))
	};
};

/**
 * The picker is one `<select name="source">` posting `food:<id>`,
 * `recipe:<id>`, or empty for a custom entry — parsed here rather than on
 * the client, so the form needs no reactive mirror of "which one is picked"
 * just to fill in two hidden fields.
 */
function parseSource(value: FormDataEntryValue | null): { foodId: string; recipeId: string } {
	const text = typeof value === 'string' ? value : '';
	if (text.startsWith('food:')) return { foodId: text.slice(5), recipeId: '' };
	if (text.startsWith('recipe:')) return { recipeId: text.slice(7), foodId: '' };
	return { foodId: '', recipeId: '' };
}

const entryFields = (form: FormData) => ({
	eatenOn: form.get('eatenOn'),
	meal: form.get('meal'),
	...parseSource(form.get('source')),
	name: form.get('name'),
	servings: form.get('servings'),
	kcalOverride: form.get('kcalOverride'),
	proteinGOverride: form.get('proteinGOverride'),
	carbsGOverride: form.get('carbsGOverride'),
	fibreGOverride: form.get('fibreGOverride'),
	sugarGOverride: form.get('sugarGOverride'),
	totalFatGOverride: form.get('totalFatGOverride'),
	sodiumMgOverride: form.get('sodiumMgOverride'),
	notes: form.get('notes')
});

/** `not_found` also covers "not yours to see" (base.ts). */
const statusFor = (reason: WriteFailure): number =>
	reason === 'invalid' ? 400 : reason === 'forbidden' ? 403 : reason === 'conflict' ? 409 : 404;

export const actions: Actions = {
	create: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await createFoodLogEntry(sql, viewer, entryFields(form));
		if (!result.ok) {
			const error =
				result.reason === 'invalid'
					? result.message
					: result.reason === 'not_found'
						? (result.message ?? 'Could not find that food or recipe.')
						: 'Could not log that entry.';
			return fail(statusFor(result.reason), { action: 'create' as const, error });
		}
		return { action: 'create' as const, savedId: result.record.id };
	},

	update: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const expected = form.get('expectedUpdatedAt');

		const result = await updateFoodLogEntry(
			sql,
			viewer,
			id,
			entryFields(form),
			expected ? String(expected) : undefined
		);
		if (!result.ok) {
			const error =
				result.reason === 'invalid'
					? result.message
					: result.reason === 'conflict'
						? 'This entry changed elsewhere — reload and try again.'
						: result.reason === 'forbidden'
							? 'You cannot change this entry.'
							: (result.message ?? 'Could not find that entry.');
			return fail(statusFor(result.reason), { action: 'update' as const, error });
		}
		return { action: 'update' as const, savedId: result.record.id };
	},

	delete: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const removed = await deleteFoodLogEntry(sql, viewer, String(form.get('id') ?? ''));
		if (!removed) {
			return fail(404, { action: 'delete' as const, error: 'Could not delete that entry.' });
		}
		return { action: 'delete' as const };
	}
};
