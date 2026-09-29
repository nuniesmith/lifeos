<script lang="ts">
	import { Card, EmptyState, List, ListRow, PageHeader } from '$lib/components';

	let { data } = $props();
</script>

<svelte:head><title>Authors · Reading Tracker · LifeOS</title></svelte:head>

<PageHeader title="Authors" back={{ href: '/reading', label: 'Reading Tracker' }}>
	{#snippet meta()}
		<span>{data.authors.length} author{data.authors.length === 1 ? '' : 's'}</span>
	{/snippet}
</PageHeader>

<Card flush>
	{#if data.authors.length === 0}
		<EmptyState
			title="No authors yet"
			description="Authors are added from a book's own page."
			icon="journal"
		/>
	{:else}
		<List label="Authors">
			{#each data.authors as author (author.id)}
				<ListRow
					title={author.name}
					href="/reading/authors/{author.id}"
					meta="{author.bookCount} book{author.bookCount === 1 ? '' : 's'}"
				/>
			{/each}
		</List>
	{/if}
</Card>
