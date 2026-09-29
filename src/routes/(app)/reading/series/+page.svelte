<script lang="ts">
	import { Card, EmptyState, List, ListRow, PageHeader } from '$lib/components';

	let { data } = $props();

	const metaOf = (s: (typeof data.series)[number]): string =>
		s.plannedCount !== null
			? `${s.bookCount} of ${s.plannedCount} book${s.plannedCount === 1 ? '' : 's'}`
			: `${s.bookCount} book${s.bookCount === 1 ? '' : 's'}`;
</script>

<svelte:head><title>Series · Reading Tracker · LifeOS</title></svelte:head>

<PageHeader title="Series" back={{ href: '/reading', label: 'Reading Tracker' }}>
	{#snippet meta()}
		<span>{data.series.length} series</span>
	{/snippet}
</PageHeader>

<Card flush>
	{#if data.series.length === 0}
		<EmptyState
			title="No series yet"
			description="A series is added from a book's own page."
			icon="journal"
		/>
	{:else}
		<List label="Series">
			{#each data.series as s (s.id)}
				<ListRow title={s.name} href="/reading/series/{s.id}" meta={metaOf(s)} />
			{/each}
		</List>
	{/if}
</Card>
