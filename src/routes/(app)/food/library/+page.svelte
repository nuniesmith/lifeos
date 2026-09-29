<script lang="ts">
	import { resolve } from '$app/paths';
	import { Badge, Button, Card, EmptyState, List, ListRow, PageHeader } from '$lib/components';
	import { appPath } from '$lib/components/nav';
	import FoodSheet from './FoodSheet.svelte';

	let { data } = $props();

	type Row = (typeof data.foods)[number];

	const metaOf = (item: Row) =>
		[
			item.brand,
			item.serving,
			item.kcalPerServing !== null ? `${item.kcalPerServing} kcal` : null,
			item.proteinG !== null ? `${item.proteinG} g protein` : null
		]
			.filter((part): part is string => Boolean(part))
			.join(' · ');

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

<svelte:head><title>Food Library · LifeOS</title></svelte:head>

<PageHeader
	title={data.archived ? 'Archived foods' : 'Food Library'}
	description="Foods with their per-serving nutrients, for logging and for recipes."
	back={{ href: '/food', label: 'Food HQ' }}
>
	{#snippet meta()}
		<span>{data.foods.length} {data.archived ? 'archived' : 'tracked'}</span>
		{#if data.archived}
			<a href={resolve(appPath('/food/library'))}>Back to the library</a>
		{:else}
			<a href={resolve(appPath('/food/library?archived=1'))}>View archived</a>
		{/if}
	{/snippet}
	{#snippet actions()}
		{#if !data.archived}
			<Button variant="primary" icon="plus" onclick={openAdd}>Add food</Button>
		{/if}
	{/snippet}
</PageHeader>

<Card flush>
	{#if data.foods.length === 0}
		<EmptyState
			title={data.archived ? 'Nothing archived' : 'No foods yet'}
			description={data.archived
				? undefined
				: 'Add one with its per-serving nutrients, and it is ready to log or to pick as an ingredient.'}
			icon="check"
		/>
	{:else}
		<List label={data.archived ? 'Archived foods' : 'Foods'}>
			{#each data.foods as item (item.id)}
				<ListRow title={item.name} meta={metaOf(item) || undefined} muted={data.archived}>
					{#snippet trail()}
						{#if item.isFavourite}<Badge tone="accent">Favourite</Badge>{/if}
						<Button size="sm" variant="ghost" onclick={() => openEdit(item)}>Edit</Button>
					{/snippet}
				</ListRow>
			{/each}
		</List>
	{/if}
</Card>

<FoodSheet bind:open={sheetOpen} food={editing} />
