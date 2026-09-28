<script lang="ts">
	import { resolve } from '$app/paths';
	import { Badge, Button, Card, EmptyState, List, ListRow, PageHeader } from '$lib/components';
	import { appPath } from '$lib/components/nav';
	import { formatFoodAmount } from '$lib/food-units';
	import IngredientSheet from './IngredientSheet.svelte';

	let { data } = $props();

	type Row = (typeof data.ingredients)[number];

	const STATUS_LABELS: Record<Row['status'], string> = {
		in_stock: 'In stock',
		shopping_list: 'On the shopping list',
		use_up: 'Use up',
		not_needed: "Don't need"
	};

	/** The structured quantity when there is one, else the free text — the
	 *  same display preference the recipe page applies to an amount. */
	const displayQuantity = (item: Row): string | null =>
		formatFoodAmount(item.quantityValue, item.quantityUnit) ?? item.quantity;

	const metaOf = (item: Row) =>
		[STATUS_LABELS[item.status], displayQuantity(item), item.store]
			.filter((part): part is string => Boolean(part))
			.join(' · ');

	// Walked in the same shop order as the shopping list on /food.
	const byAisle = $derived.by(() => {
		const groups: Record<string, Row[]> = {};
		for (const item of data.ingredients) {
			(groups[item.aisle ?? 'No aisle set'] ??= []).push(item);
		}
		return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
	});

	let sheetOpen = $state(false);
	let editing = $state<Row | null>(null);

	function openAdd() {
		editing = null;
		sheetOpen = true;
	}
	function openEdit(item: Row) {
		editing = item;
		sheetOpen = true;
	}
</script>

<svelte:head><title>Ingredients · LifeOS</title></svelte:head>

<PageHeader
	title={data.archived ? 'Archived ingredients' : 'Ingredients'}
	description="Every ingredient in the pantry, not only what is on the shopping list."
	back={{ href: '/food', label: 'Food HQ' }}
>
	{#snippet meta()}
		<span>{data.ingredients.length} {data.archived ? 'archived' : 'tracked'}</span>
		{#if data.archived}
			<a href={resolve(appPath('/food/ingredients'))}>Back to ingredients</a>
		{:else}
			<a href={resolve(appPath('/food/ingredients?archived=1'))}>View archived</a>
		{/if}
	{/snippet}
	{#snippet actions()}
		{#if !data.archived}
			<Button variant="primary" icon="plus" onclick={openAdd}>Add ingredient</Button>
		{/if}
	{/snippet}
</PageHeader>

<Card flush>
	{#if data.ingredients.length === 0}
		<EmptyState
			title={data.archived ? 'Nothing archived' : 'No ingredients yet'}
			description={data.archived
				? undefined
				: 'Add one to the pantry, and it can be linked to a recipe and appear on the shopping list.'}
			icon="check"
		/>
	{:else}
		{#each byAisle as [aisle, items] (aisle)}
			<div class="aisle">
				<h2>{aisle}</h2>
				<List label={`${aisle} ingredients`}>
					{#each items as item (item.id)}
						<ListRow title={item.name} meta={metaOf(item) || undefined} muted={data.archived}>
							{#snippet trail()}
								{#if item.isStaple}<Badge tone="neutral">Staple</Badge>{/if}
								<Button size="sm" variant="ghost" onclick={() => openEdit(item)}>Edit</Button>
							{/snippet}
						</ListRow>
					{/each}
				</List>
			</div>
		{/each}
	{/if}
</Card>

<IngredientSheet bind:open={sheetOpen} ingredient={editing} />

<style>
	.aisle + .aisle {
		border-top: 1px solid var(--c-border);
	}
	.aisle h2 {
		margin: 0;
		padding: var(--sp-3) var(--sp-4) 0;
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
		font-weight: 650;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}
</style>
