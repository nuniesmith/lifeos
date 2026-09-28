<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import type { SubmitFunction } from '@sveltejs/kit';
	import {
		Badge,
		Button,
		Card,
		CoverThumb,
		EmptyState,
		List,
		ListRow,
		PageHeader
	} from '$lib/components';
	import { appPath } from '$lib/components/nav';
	import { formatFoodAmount } from '$lib/food-units';
	import PlanMealSheet from './PlanMealSheet.svelte';
	import { describePlanShopping, describeUndo } from './shopping-summary';

	let { data, form } = $props();

	type Day = (typeof data.days)[number];

	/** The structured quantity when there is one, else the free text — same
	 *  display preference the recipe page applies to an ingredient's amount. */
	const displayQuantity = (item: (typeof data.shopping)[number]): string | null =>
		formatFoodAmount(item.quantityValue, item.quantityUnit) ?? item.quantity;

	/**
	 * "Aug 31 – Sep 6", so a week away from today still says where it is.
	 *
	 * Built by arithmetic on the timestamp rather than by mutating a Date: the
	 * lint rule against mutable Date instances in components is right, and a
	 * seven-day offset does not need one.
	 */
	const DAY_MS = 86_400_000;
	const weekLabel = (from: string) => {
		const startMs = Date.parse(`${from}T00:00:00Z`);
		const fmt = (ms: number) =>
			new Date(ms).toLocaleDateString(undefined, {
				day: 'numeric',
				month: 'short',
				timeZone: 'UTC'
			});
		return `${fmt(startMs)} – ${fmt(startMs + 6 * DAY_MS)}`;
	};
	type Slot = 'breakfast' | 'lunch' | 'dinner' | 'snack';

	const SLOTS: Slot[] = ['breakfast', 'lunch', 'dinner', 'snack'];
	const SLOT_LABELS: Record<Slot, string> = {
		breakfast: 'Breakfast',
		lunch: 'Lunch',
		dinner: 'Dinner',
		snack: 'Snacks'
	};

	const weekday = (date: string): string =>
		new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
			weekday: 'short',
			timeZone: 'UTC'
		});

	const dayNumber = (date: string): string =>
		new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
			day: 'numeric',
			month: 'short',
			timeZone: 'UTC'
		});

	const mealsIn = (day: Day, slot: Slot) => day.day?.meals.filter((m) => m.slot === slot) ?? [];

	// ─── planning ─────────────────────────────────────────────────────────────

	/** "Monday 28 September", for the names of the controls on a day. */
	const longDay = (date: string): string =>
		new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
			weekday: 'long',
			day: 'numeric',
			month: 'long',
			timeZone: 'UTC'
		});

	let planOpen = $state(false);
	let planDate = $state<string | null>(null);

	function planFor(date: string) {
		planDate = date;
		planOpen = true;
	}

	const planning = $derived(data.days.find((d) => d.date === planDate)?.day ?? null);
	const pickable = $derived(
		data.recipes.map((r) => ({
			id: r.id,
			name: r.name,
			courses: r.courses,
			totalMinutes: r.totalMinutes
		}))
	);

	const plannedThisWeek = $derived(
		data.days.reduce((total, d) => total + (d.day?.meals.length ?? 0), 0)
	);

	/**
	 * Removing a meal removes the button that did it, which would drop a
	 * keyboard user's focus to the top of the document. It goes to the day's
	 * own "plan a meal" button instead.
	 */
	const unplanned =
		(date: string): SubmitFunction =>
		() =>
		async ({ update }) => {
			await update();
			document.getElementById(`plan-${date}`)?.focus();
		};

	// The report belongs to the week it was made for; moving to another week
	// must not leave it describing this one.
	const shopped = $derived(form?.shopped && form.shopped.from === data.from ? form.shopped : null);
	const shopLabel = $derived(
		data.isThisWeek
			? 'Add this week’s ingredients to the shopping list'
			: `Add the ingredients for ${weekLabel(data.from)} to the shopping list`
	);

	/**
	 * The shopping list walked in shop order, which is what an aisle is for.
	 *
	 * A plain object rather than a Map: the lint rule steers mutable built-ins
	 * towards their reactive equivalents, and this is derived and thrown away.
	 */
	const byAisle = $derived.by(() => {
		const groups: Record<string, typeof data.shopping> = {};
		for (const item of data.shopping) {
			const key = item.aisle ?? 'Anywhere else';
			(groups[key] ??= []).push(item);
		}
		return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
	});
</script>

<svelte:head><title>Food HQ · LifeOS</title></svelte:head>

<PageHeader title="Food HQ" description="What is planned, what needs buying, what can be made.">
	{#snippet meta()}
		<span>
			{data.summary.recipes} recipe{data.summary.recipes === 1 ? '' : 's'} ·
			{data.summary.shoppingList} to buy ·
			{data.summary.openPrep} to prep
		</span>
	{/snippet}
</PageHeader>

{#if form?.error}
	<p class="notice error" role="alert">{form.error}</p>
{/if}

<div class="stack">
	<section aria-labelledby="plan-heading">
		<div class="plan-head">
			<h2 id="plan-heading" class="section-title">
				{data.isThisWeek ? 'This week' : weekLabel(data.from)}
			</h2>
			<nav class="weeks" aria-label="Move the meal plan">
				<a class="step" href={resolve(appPath(`/food?from=${data.previous}`))} rel="prev">
					<span aria-hidden="true">‹</span> Earlier
				</a>
				{#if !data.isThisWeek}
					<a class="step" href={resolve(appPath('/food'))}>This week</a>
				{/if}
				<a class="step" href={resolve(appPath(`/food?from=${data.next}`))} rel="next">
					Later <span aria-hidden="true">›</span>
				</a>
			</nav>
		</div>
		{#if data.nearestPlan}
			<p class="notice">
				Nothing planned this week.
				<a href={resolve(appPath(`/food?from=${data.nearestPlan}`))}>
					Go to the week of {weekLabel(data.nearestPlan)}
				</a>
			</p>
		{/if}
		<div class="week">
			{#each data.days as { date, day } (date)}
				<article
					class="day"
					class:today={date === data.today}
					aria-labelledby={`day-${date}`}
					aria-current={date === data.today ? 'date' : undefined}
				>
					<header>
						<h3 class="when" id={`day-${date}`}>
							<span class="weekday">{weekday(date)}</span>
							<span class="date">{dayNumber(date)}</span>
							<!-- Today is said in words; the border is only a second cue. -->
							{#if date === data.today}<span class="today-mark">Today</span>{/if}
						</h3>
						<Button
							id={`plan-${date}`}
							icon="plus"
							iconOnly
							variant="secondary"
							onclick={() => planFor(date)}
						>
							Plan a meal for {longDay(date)}
						</Button>
					</header>
					{#if day && day.meals.length > 0}
						<ul>
							{#each SLOTS as slot (slot)}
								{#each mealsIn({ date, day }, slot) as meal (slot + meal.recipeId)}
									<li>
										<div class="meal-text">
											<span class="slot">{SLOT_LABELS[slot]}</span>
											<span class="meal">{meal.recipeName}</span>
										</div>
										<form method="POST" action="?/unplan" use:enhance={unplanned(date)}>
											<input type="hidden" name="mealPlanId" value={day.id} />
											<input type="hidden" name="slot" value={slot} />
											<input type="hidden" name="recipeId" value={meal.recipeId} />
											<Button type="submit" icon="close" iconOnly variant="ghost">
												{`Remove ${meal.recipeName} from ${SLOT_LABELS[slot].toLowerCase()} on ${longDay(date)}`}
											</Button>
										</form>
									</li>
								{/each}
							{/each}
						</ul>
					{:else}
						<!-- An empty day is the most useful thing a meal plan can say. -->
						<p class="nothing">Nothing planned</p>
					{/if}
				</article>
			{/each}
		</div>

		{#if plannedThisWeek > 0}
			<form method="POST" action="?/shopWeek" class="shop-week" use:enhance>
				<input type="hidden" name="from" value={data.from} />
				<Button type="submit" icon="plus">{shopLabel}</Button>
			</form>
		{/if}
		<!--
			Always in the document, so a screen reader announces the report when
			it arrives; empty, it takes no space.
		-->
		<p class="shop-report" role="status">
			{#if shopped}
				{describePlanShopping(shopped)}
			{:else if form?.unshopped}
				{describeUndo(form.unshopped)}
			{/if}
		</p>
		{#if shopped && shopped.added.length > 0}
			<div class="shop-added">
				<p class="added-names">{shopped.added.map((item) => item.name).join(', ')}</p>
				<!-- Undo carries back exactly what was moved, nothing else. -->
				<form method="POST" action="?/undoShopWeek" use:enhance>
					{#each shopped.added as item (item.id)}
						<input type="hidden" name="id" value={item.id} />
					{/each}
					<Button type="submit" variant="secondary">Undo</Button>
				</form>
			</div>
		{/if}
	</section>

	<PlanMealSheet
		bind:open={planOpen}
		date={planDate}
		planned={planning?.meals ?? []}
		recipes={pickable}
	/>

	<div class="columns">
		<section aria-labelledby="shopping-heading">
			<div class="shopping-head">
				<h2 id="shopping-heading" class="section-title">Shopping list</h2>
				<Button href="/food/ingredients" variant="secondary" size="sm">Ingredients</Button>
			</div>
			<Card flush>
				{#if data.shopping.length === 0}
					<EmptyState
						title="Nothing to buy"
						description="Add a week’s planned ingredients from the meal plan and they appear here, grouped by aisle."
						icon="check"
					/>
				{:else}
					{#each byAisle as [aisle, items] (aisle)}
						<div class="aisle">
							<h3>{aisle}</h3>
							<List label={`${aisle} items`}>
								{#each items as item (item.id)}
									<ListRow title={item.name} meta={displayQuantity(item) ?? undefined}>
										{#snippet trail()}
											<div class="row-actions">
												{#if item.isStaple}<Badge tone="neutral">Staple</Badge>{/if}
												<form method="POST" action="?/setStatus" use:enhance>
													<input type="hidden" name="id" value={item.id} />
													<input type="hidden" name="status" value="in_stock" />
													<!-- Full size: a thumb target in a shop aisle. -->
													<Button
														type="submit"
														variant="ghost"
														aria-label={`Mark ${item.name} as bought`}
													>
														Got it
													</Button>
												</form>
											</div>
										{/snippet}
									</ListRow>
								{/each}
							</List>
						</div>
					{/each}
				{/if}
			</Card>
		</section>

		<div class="side">
			<section aria-labelledby="prep-heading">
				<h2 id="prep-heading" class="section-title">Prep</h2>
				<Card flush>
					{#if data.prep.length === 0}
						<EmptyState title="Nothing to prep" icon="check" />
					{:else}
						<List label="Prep tasks">
							{#each data.prep as task (task.id)}
								<ListRow
									title={task.name}
									meta={task.whenToDo ? task.whenToDo.replace(/_/g, ' ') : undefined}
								>
									{#snippet trail()}
										<form method="POST" action="?/togglePrep" use:enhance>
											<input type="hidden" name="id" value={task.id} />
											<input type="hidden" name="done" value="true" />
											<Button
												type="submit"
												size="sm"
												variant="ghost"
												aria-label={`Mark ${task.name} done`}
											>
												Done
											</Button>
										</form>
									{/snippet}
								</ListRow>
							{/each}
						</List>
					{/if}
				</Card>
			</section>

			<section aria-labelledby="recipes-heading">
				<div class="recipes-head">
					<h2 id="recipes-heading" class="section-title">Recipes</h2>
					<Button href="/food/recipes/new" icon="plus">New recipe</Button>
				</div>
				<Card flush>
					{#if data.recipes.length === 0}
						<EmptyState
							title="No recipes yet"
							description="Recipes carry their times, macros and the ingredients they call for."
							icon="journal"
						/>
					{:else}
						<List label="Recipes">
							{#each data.recipes.slice(0, 12) as recipe (recipe.id)}
								<ListRow
									title={recipe.name}
									href={`/food/recipes/${recipe.id}`}
									meta={[
										recipe.totalMinutes !== null ? `${recipe.totalMinutes} min` : null,
										recipe.servings !== null ? `serves ${recipe.servings}` : null,
										recipe.kcalPerServing !== null ? `${recipe.kcalPerServing} kcal` : null
									]
										.filter(Boolean)
										.join(' · ')}
								>
									{#snippet lead()}
										<CoverThumb cover={recipe.cover} />
									{/snippet}
									{#snippet trail()}
										{#if recipe.isFavourite}<Badge tone="accent">Favourite</Badge>{/if}
									{/snippet}
									{#if recipe.courses.length > 0}
										<ul class="courses">
											{#each recipe.courses as course (course)}
												<li>{course}</li>
											{/each}
										</ul>
									{/if}
								</ListRow>
							{/each}
						</List>
						{#if data.recipes.length > 12}
							<p class="footnote">
								{data.recipes.length - 12} more not shown.
								<a href={resolve(appPath('/food/recipes'))}>All recipes</a>
							</p>
						{/if}
					{/if}
				</Card>
			</section>
		</div>
	</div>
</div>

<style>
	.plan-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.5rem 1rem;
	}

	.weeks {
		display: flex;
		gap: 0.75rem;
	}

	.weeks .step {
		font-size: 0.875rem;
		text-decoration: none;
	}

	.weeks .step:hover {
		text-decoration: underline;
	}

	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-6);
	}

	.section-title {
		margin: 0 0 var(--sp-3);
		font-size: var(--fs-lg);
		font-weight: 650;
	}

	.week {
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
		gap: var(--sp-2);
	}
	.day {
		display: flex;
		flex-direction: column;
		gap: var(--sp-2);
		min-height: 7rem;
		padding: var(--sp-3);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-sm);
		background: var(--c-surface);
	}
	.day.today {
		border-color: var(--c-accent);
		background: color-mix(in srgb, var(--c-accent) 6%, var(--c-surface));
	}
	.day header {
		display: flex;
		gap: var(--sp-1);
		align-items: center;
		justify-content: space-between;
	}
	/* A heading so each day is a landmark to a screen reader; it keeps the
	   look of the plain label it replaced, and wraps in a narrow column. */
	.when {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		column-gap: var(--sp-2);
		min-width: 0;
		margin: 0;
		font-size: inherit;
		font-weight: inherit;
	}
	.weekday {
		font-size: var(--fs-sm);
		font-weight: 650;
	}
	.date {
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
	}
	.today-mark {
		color: var(--c-accent);
		font-size: var(--fs-xs);
		font-weight: 650;
	}
	.day ul {
		display: grid;
		gap: var(--sp-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.day li {
		display: flex;
		align-items: center;
		gap: var(--sp-1);
	}
	.meal-text {
		display: grid;
		flex: 1;
		gap: 0.05rem;
		min-width: 0;
	}
	.day li form {
		flex: none;
		/* The remove button keeps its full 44px target; pulling it into the
		   card's padding gives the recipe name that much more room. */
		margin-right: calc(-1 * var(--sp-2));
	}
	.slot {
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
		letter-spacing: 0.03em;
		text-transform: uppercase;
	}
	.meal {
		font-size: var(--fs-sm);
		line-height: 1.25;
		/* Seven columns leave a desktop day narrow; a long word breaks at a
		   hyphen rather than at an arbitrary letter. */
		overflow-wrap: anywhere;
		hyphens: auto;
	}

	.shop-week {
		margin-top: var(--sp-4);
	}
	.shop-report {
		margin: 0;
	}
	.shop-report:not(:empty) {
		margin-top: var(--sp-3);
	}
	.shop-added {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--sp-2) var(--sp-4);
		margin-top: var(--sp-2);
	}
	.added-names {
		flex: 1 1 14rem;
		margin: 0;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
		overflow-wrap: anywhere;
	}
	.nothing {
		margin: auto 0;
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
	}

	.columns {
		display: grid;
		grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);
		gap: var(--sp-5);
		align-items: start;
	}
	.side {
		display: flex;
		flex-direction: column;
		gap: var(--sp-5);
	}

	.aisle + .aisle {
		border-top: 1px solid var(--c-border);
	}
	.aisle h3 {
		margin: 0;
		padding: var(--sp-3) var(--sp-4) 0;
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
		font-weight: 650;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.row-actions {
		display: flex;
		gap: var(--sp-2);
		align-items: center;
	}

	.courses {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-1);
		margin: 0.2rem 0 0;
		padding: 0;
		list-style: none;
	}
	.courses li {
		padding: 0.05rem var(--sp-2);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-pill);
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
	}

	.shopping-head,
	.recipes-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--sp-2);
		margin-bottom: var(--sp-3);
	}
	.recipes-head .section-title {
		margin: 0;
	}
	.footnote a {
		display: inline-flex;
		align-items: center;
		min-height: var(--tap);
	}

	.footnote {
		margin: 0;
		padding: var(--sp-3) var(--sp-4);
		border-top: 1px solid var(--c-border);
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
	}

	.notice {
		padding: var(--sp-2) var(--sp-3);
		border-radius: var(--radius-sm);
		margin-bottom: var(--sp-4);
	}
	.notice.error {
		color: var(--c-crit);
		border: 1px solid color-mix(in srgb, var(--c-crit) 25%, transparent);
		background: color-mix(in srgb, var(--c-crit) 8%, transparent);
	}

	@media (max-width: 70rem) {
		.week {
			grid-template-columns: repeat(4, minmax(0, 1fr));
		}
	}
	@media (max-width: 60rem) {
		.columns {
			grid-template-columns: 1fr;
		}
	}
	/* One day per row on a phone. Two columns left each day about 150px, and
	   with a 44px control beside every meal the recipe names were squeezed
	   into a word per line. */
	@media (max-width: 40rem) {
		.week {
			grid-template-columns: minmax(0, 1fr);
		}
		.day {
			min-height: 0;
		}
	}
</style>
