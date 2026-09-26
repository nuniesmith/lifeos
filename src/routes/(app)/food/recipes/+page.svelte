<script lang="ts">
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

	let { data } = $props();

	const metaOf = (recipe: (typeof data.recipes)[number]) =>
		[
			recipe.totalMinutes !== null ? `${recipe.totalMinutes} min` : null,
			recipe.servings !== null ? `serves ${recipe.servings}` : null,
			recipe.kcalPerServing !== null ? `${recipe.kcalPerServing} kcal` : null
		]
			.filter(Boolean)
			.join(' · ');
</script>

<svelte:head><title>Recipes · LifeOS</title></svelte:head>

<PageHeader title="Recipes" back={{ href: '/food', label: 'Food HQ' }}>
	{#snippet meta()}
		<span>{data.recipes.length} recipe{data.recipes.length === 1 ? '' : 's'}</span>
	{/snippet}
	{#snippet actions()}
		<Button href="/food/recipes/new" icon="plus">New recipe</Button>
	{/snippet}
</PageHeader>

<Card flush>
	{#if data.recipes.length === 0}
		<EmptyState
			title="No recipes yet"
			description="Add one with its method, and it can be planned into the week."
			icon="journal"
		/>
	{:else}
		<List label="Recipes">
			{#each data.recipes as recipe (recipe.id)}
				<ListRow title={recipe.name} href={`/food/recipes/${recipe.id}`} meta={metaOf(recipe)}>
					{#snippet lead()}
						<CoverThumb cover={recipe.cover} />
					{/snippet}
					{#snippet trail()}
						{#if recipe.isFavourite}
							<Badge tone="accent"><span aria-hidden="true">★</span> Favourite</Badge>
						{/if}
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
	{/if}
</Card>

<style>
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
</style>
