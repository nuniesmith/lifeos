<script lang="ts">
	import { Card, EmptyState, List, ListRow, PageHeader } from '$lib/components';

	let { data } = $props();

	// "3 of 5 read" is the viewer's own progress (Reading Tracker R2's
	// finishedCount); plannedCount only earns a place beside it when the
	// series is expected to run longer than what is catalogued so far.
	const metaOf = (s: (typeof data.series)[number]): string => {
		const read = `${s.finishedCount} of ${s.bookCount} read`;
		return s.plannedCount !== null && s.plannedCount !== s.bookCount
			? `${read} · ${s.plannedCount} planned`
			: read;
	};
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
