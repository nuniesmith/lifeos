<script lang="ts">
	import { enhance } from '$app/forms';
	import { Badge, Button, Card, EmptyState, List, ListRow, PageHeader } from '$lib/components';

	let { data, form } = $props();

	type Day = (typeof data.days)[number];
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
		<h2 id="plan-heading" class="section-title">The week ahead</h2>
		<div class="week">
			{#each data.days as { date, day } (date)}
				<article class="day" class:today={date === data.today}>
					<header>
						<span class="weekday">{weekday(date)}</span>
						<span class="date">{dayNumber(date)}</span>
					</header>
					{#if day && day.meals.length > 0}
						<ul>
							{#each SLOTS as slot (slot)}
								{#each mealsIn({ date, day }, slot) as meal (slot + meal.recipeId)}
									<li>
										<span class="slot">{SLOT_LABELS[slot]}</span>
										<span class="meal">{meal.recipeName}</span>
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
	</section>

	<div class="columns">
		<section aria-labelledby="shopping-heading">
			<h2 id="shopping-heading" class="section-title">Shopping list</h2>
			<Card flush>
				{#if data.shopping.length === 0}
					<EmptyState
						title="Nothing to buy"
						description="Mark an ingredient as needed and it appears here, grouped by aisle."
						icon="check"
					/>
				{:else}
					{#each byAisle as [aisle, items] (aisle)}
						<div class="aisle">
							<h3>{aisle}</h3>
							<List label={`${aisle} items`}>
								{#each items as item (item.id)}
									<ListRow title={item.name} meta={item.quantity ?? undefined}>
										{#snippet trail()}
											<div class="row-actions">
												{#if item.isStaple}<Badge tone="neutral">Staple</Badge>{/if}
												<form method="POST" action="?/setStatus" use:enhance>
													<input type="hidden" name="id" value={item.id} />
													<input type="hidden" name="status" value="in_stock" />
													<Button
														type="submit"
														size="sm"
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
				<h2 id="recipes-heading" class="section-title">Recipes</h2>
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
									meta={[
										recipe.totalMinutes !== null ? `${recipe.totalMinutes} min` : null,
										recipe.servings !== null ? `serves ${recipe.servings}` : null,
										recipe.kcalPerServing !== null ? `${recipe.kcalPerServing} kcal` : null
									]
										.filter(Boolean)
										.join(' · ')}
								>
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
							<p class="footnote">{data.recipes.length - 12} more not shown.</p>
						{/if}
					{/if}
				</Card>
			</section>
		</div>
	</div>
</div>

<style>
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
		align-items: baseline;
		justify-content: space-between;
	}
	.weekday {
		font-size: var(--fs-sm);
		font-weight: 650;
	}
	.date {
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
	}
	.day ul {
		display: grid;
		gap: var(--sp-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.day li {
		display: grid;
		gap: 0.05rem;
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
	@media (max-width: 40rem) {
		.week {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
</style>
