import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { viewerOf } from '$lib/server/auth/authz';
import { one } from '$lib/server/db/scalar';
import { createRecipe, planMeal } from '$lib/server/repositories';
import { load } from '../../src/routes/(app)/food/+page.server';
import type { Viewer } from '$lib/server/auth/authz';

/**
 * Which week the meal plan shows.
 *
 * The window used to run from today to today + 6. That is defensible in the
 * abstract and wrong in practice: an import carries the weeks you have lived,
 * not the ones you have not, so a freshly imported workspace opened on an empty
 * planner with fourteen planned days sitting one click away and nothing saying
 * so. The page was correct and looked broken.
 *
 * These cases pin the two decisions that fixed it — the window is the WEEK, and
 * an empty week says where the nearest plan is.
 */

const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });

let viewer: Viewer;
let householdId: string;
let recipeId: string;

async function reset() {
	await sql`truncate households, users restart identity cascade`;
	await sql`delete from auth_audit`;
}

/**
 * The loader's own return type, with the `void` arm of SvelteKit's PageData
 * union removed. The union exists because a load MAY return nothing; this one
 * always does, and narrowing here keeps every case below reading real fields
 * instead of casting one at a time.
 */
type FoodData = Exclude<Awaited<ReturnType<typeof load>>, void>;

/** The parts of a RequestEvent this loader reads. */
const eventFor = (from?: string) =>
	({
		locals: {
			user: {
				id: viewer.userId,
				username: 'admin',
				displayName: 'Admin',
				role: 'admin' as const,
				mustChangeCredentials: false,
				isBootstrap: true
			}
		},
		url: new URL(`http://localhost/food${from ? `?from=${from}` : ''}`)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	}) as any;

const loadFood = async (from?: string) => (await load(eventFor(from))) as FoodData;

beforeEach(async () => {
	await reset();
	await bootstrapIfEmpty(sql);
	householdId = one(await sql<{ id: string }[]>`select id from households limit 1`).id;
	const admin = one(await sql<{ id: string }[]>`select id from users limit 1`).id;
	viewer = viewerOf(
		{
			id: admin,
			username: 'admin',
			displayName: 'Admin',
			role: 'admin',
			mustChangeCredentials: false,
			isBootstrap: true
		},
		householdId
	);
	// The household's today is fixed by its timezone, so the tests pick dates
	// relative to whatever the loader computes rather than hard-coding one.
	const created = await createRecipe(sql, viewer, { name: 'Pancakes' });
	if (!created.ok) throw new Error('could not create the recipe');
	recipeId = created.record.id;
});

afterAll(async () => {
	await reset();
	await sql.end({ timeout: 5 });
});

describe('the meal plan window', () => {
	// NOTE: this case cannot discriminate on a Monday — "start at today" and
	// "start at the week's Monday" are then the same date, and the bug it guards
	// against passes. Confirmed by mutation: reverting the window to `today`
	// leaves this green every Monday and fails it the other six days. The
	// explicit-`?from` case below is the one that holds every day, and is the
	// real guard.
	it('starts on Monday, so days already eaten this week are still shown', async () => {
		const data = await loadFood();
		expect(data.days).toHaveLength(7);
		// Monday is 1 in getUTCDay.
		expect(new Date(`${data.from}T00:00:00Z`).getUTCDay()).toBe(1);
		// Today must be inside the window it renders.
		expect(data.days.map((day: { date: string }) => day.date)).toContain(data.today);
	});

	it('moves to the week containing an explicit ?from', async () => {
		const data = await loadFood('2026-08-27');
		// 27 Aug 2026 is a Thursday; the window is its Monday.
		expect(data.from).toBe('2026-08-24');
		expect(data.days[0]?.date).toBe('2026-08-24');
		expect(data.isThisWeek).toBe(false);
		expect(data.previous).toBe('2026-08-17');
		expect(data.next).toBe('2026-08-31');
	});

	it('shows this week rather than failing on a ?from that is not a date', async () => {
		const data = await loadFood('not-a-date');
		expect(data.isThisWeek).toBe(true);
	});

	it('points at the nearest planned week when this one is empty', async () => {
		const planned = await planMeal(sql, viewer, '2026-08-26', 'dinner', recipeId);
		expect(planned.ok).toBe(true);

		const data = await loadFood();
		// The bug this exists for: an empty week with plans elsewhere and no way
		// to know it.
		expect(data.nearestPlan).toBe('2026-08-24');
	});

	it('offers nothing when the week has meals of its own', async () => {
		const data = await loadFood();
		const planned = await planMeal(sql, viewer, data.today, 'dinner', recipeId);
		expect(planned.ok).toBe(true);

		const after = await loadFood();
		expect(after.nearestPlan).toBeNull();
	});

	it('offers nothing when there is genuinely no plan anywhere', async () => {
		const data = await loadFood();
		expect(data.nearestPlan).toBeNull();
	});
});
