<script lang="ts">
	import { resolve } from '$app/paths';
	import { BookList, Button, Card, Input, PageHeader, Select } from '$lib/components';

	let { data } = $props();

	const STATUS_LABELS: Record<string, string> = {
		tbr: 'TBR',
		reading: 'Reading',
		paused: 'Paused',
		read: 'Read',
		dnf: 'DNF'
	};

	const statusOptions = $derived(
		data.statuses.map((s) => ({ value: s, label: STATUS_LABELS[s] ?? s }))
	);

	// Any filter beyond the plain page means the "clear" link is worth
	// showing — checked once here rather than per-chip below.
	const hasFilters = $derived(
		Boolean(
			data.filters.status ||
			data.filters.authorId ||
			data.filters.seriesId ||
			data.filters.genreId ||
			data.filters.owned ||
			data.filters.search
		)
	);
</script>

<svelte:head><title>Books · Reading Tracker · LifeOS</title></svelte:head>

<PageHeader
	title="Books"
	description="The catalogue."
	back={{ href: '/reading', label: 'Reading Tracker' }}
>
	{#snippet meta()}
		<span>{data.books.length} book{data.books.length === 1 ? '' : 's'}</span>
	{/snippet}
	{#snippet actions()}
		<Button href="/reading/books/new" variant="primary" icon="plus">New book</Button>
	{/snippet}
</PageHeader>

<div class="stack">
	{#if data.activeAuthor || data.activeSeries || data.activeGenre}
		<p class="active-filter">
			Filtered by
			{#if data.activeAuthor}author <strong>{data.activeAuthor.name}</strong>{/if}
			{#if data.activeSeries}series <strong>{data.activeSeries.name}</strong>{/if}
			{#if data.activeGenre}genre <strong>{data.activeGenre.name}</strong>{/if}
			— <a href={resolve('/reading/books')}>clear</a>
		</p>
	{/if}

	<Card>
		<!-- A plain GET form: the filter is the URL, so a reload or a shared
		     link reproduces the same list with no client-side state to lose. -->
		<form method="GET" class="filters">
			{#if data.filters.authorId}
				<input type="hidden" name="author" value={data.filters.authorId} />
			{/if}
			{#if data.filters.seriesId}
				<input type="hidden" name="series" value={data.filters.seriesId} />
			{/if}
			{#if data.filters.genreId}
				<input type="hidden" name="genre" value={data.filters.genreId} />
			{/if}

			<div class="row">
				<Input
					label="Search title"
					name="q"
					type="search"
					value={data.filters.search}
					placeholder="Title contains…"
				/>

				<Select
					label="Status"
					name="status"
					options={statusOptions}
					placeholder="Any status"
					value={data.filters.status}
				/>

				<label class="owned">
					<input type="checkbox" name="owned" value="1" checked={data.filters.owned} />
					<span>Owned only</span>
				</label>
			</div>

			<div class="actions">
				{#if hasFilters}<Button href="/reading/books" variant="ghost">Clear</Button>{/if}
				<Button type="submit" variant="primary">Filter</Button>
			</div>
		</form>
	</Card>

	<BookList
		books={data.books}
		emptyTitle={hasFilters ? 'No books match those filters' : 'No books yet'}
		emptyDescription={hasFilters ? undefined : 'Add one from "New book" above.'}
	/>
</div>

<style>
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}
	.active-filter {
		margin: 0;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}
	.filters {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}
	.row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 11rem), 1fr));
		gap: var(--sp-3);
		align-items: end;
	}
	.owned {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		min-height: var(--tap);
		font-size: var(--fs-sm);
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--sp-2);
	}
</style>
