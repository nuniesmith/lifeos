<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { BookList, Button, Card, EmptyState, PageHeader, Select } from '$lib/components';
	import { FORMAT_LABELS } from '../books/form';

	let { data, form } = $props();

	const genreOptions = $derived(data.genres.map((g) => ({ value: g.id, label: g.name })));
	const formatOptions = $derived(data.formats.map((f) => ({ value: f, label: FORMAT_LABELS[f] })));

	const hasFilters = $derived(
		Boolean(data.filters.genreId || data.filters.format || data.filters.owned)
	);

	// The action's own result once "Another" has been pressed at least once,
	// falling back to the load function's first pick under the page's own
	// query-param filters — the same fallback /entertainment/pick's own
	// suggestion uses, and for the same reason: something to show without
	// waiting for a click, and "Another" keeps showing the latest roll.
	const suggestion = $derived(form?.suggestion !== undefined ? form.suggestion : data.suggestion);
	const suggestionFilters = $derived(form?.suggestionFilters ?? data.suggestionFilters);

	const suggestionMeta = $derived(
		suggestion
			? [
					suggestion.authorNames,
					suggestion.seriesName
						? `${suggestion.seriesName}${suggestion.seriesPosition !== null ? ` #${suggestion.seriesPosition}` : ''}`
						: null,
					suggestion.pages ? `${suggestion.pages} pages` : null
				]
					.filter(Boolean)
					.join(' · ')
			: ''
	);
</script>

<svelte:head><title>TBR pile · Reading Tracker · LifeOS</title></svelte:head>

<PageHeader
	title="TBR pile"
	description="What you mean to get to, oldest added first."
	back={{ href: '/reading', label: 'Reading Tracker' }}
>
	{#snippet meta()}
		<span>{data.books.length} book{data.books.length === 1 ? '' : 's'}</span>
	{/snippet}
</PageHeader>

<div class="stack">
	<Card title="Pick my next read">
		<form
			method="POST"
			action="?/roll"
			class="pick-form"
			use:enhance={() =>
				async ({ update }) =>
					// The form stays on screen and its two <Select>s must keep
					// showing the filters just used, not the option the page was
					// first served with (hard rule 6) — see /entertainment/pick's
					// own roll form for the same note.
					update({ reset: false })}
		>
			<div class="grid">
				<Select
					label="Genre"
					name="genreId"
					options={genreOptions}
					placeholder="Any genre"
					value={suggestionFilters.genreId}
				/>
				<Select
					label="Format"
					name="format"
					options={formatOptions}
					placeholder="Any format"
					value={suggestionFilters.format}
				/>
			</div>
			<label class="owned">
				<input type="checkbox" name="owned" value="1" checked={suggestionFilters.owned === '1'} />
				<span>Owned only</span>
			</label>
			<div class="row-end">
				<Button type="submit" variant="primary">Another</Button>
			</div>
		</form>

		{#if suggestion}
			<div class="suggestion">
				<p class="name">{suggestion.title}</p>
				{#if suggestionMeta}<p class="meta">{suggestionMeta}</p>{/if}
				<div class="row-end">
					<Button href="/reading/books/{suggestion.id}" variant="primary">Open book</Button>
				</div>
			</div>
		{:else}
			<EmptyState
				title="Nothing matches"
				description="Everything on the TBR has been started, or no book fits these filters."
				icon="journal"
			/>
		{/if}
	</Card>

	<Card>
		<!-- A plain GET form: the filter is the URL, so a reload or a shared
		     link reproduces the same list — the same reason /reading/books's
		     filter form is one. -->
		<form method="GET" class="filters">
			<div class="grid">
				<Select
					label="Genre"
					name="genre"
					options={genreOptions}
					placeholder="Any genre"
					value={data.filters.genreId}
				/>
				<Select
					label="Format"
					name="format"
					options={formatOptions}
					placeholder="Any format"
					value={data.filters.format}
				/>
			</div>
			<label class="owned">
				<input type="checkbox" name="owned" value="1" checked={data.filters.owned} />
				<span>Owned only</span>
			</label>
			<div class="actions">
				{#if hasFilters}<Button href="/reading/tbr" variant="ghost">Clear</Button>{/if}
				<Button type="submit" variant="primary">Filter</Button>
			</div>
		</form>
	</Card>

	{#if data.activeGenre}
		<p class="active-filter">
			Filtered by genre <strong>{data.activeGenre.name}</strong>
			— <a href={resolve('/reading/tbr')}>clear</a>
		</p>
	{/if}

	<BookList
		books={data.books}
		emptyTitle={hasFilters ? 'No TBR books match those filters' : 'Nothing on the TBR yet'}
		emptyDescription={hasFilters ? undefined : 'Add a book from the catalogue and it lands here.'}
	/>
</div>

<style>
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}
	.pick-form,
	.filters {
		display: flex;
		flex-direction: column;
		gap: var(--sp-3);
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 10rem), 1fr));
		gap: var(--sp-3);
	}
	.owned {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		font-size: var(--fs-sm);
	}
	.row-end,
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--sp-2);
	}
	.suggestion {
		display: flex;
		flex-direction: column;
		gap: var(--sp-2);
		padding-top: var(--sp-4);
		margin-top: var(--sp-4);
		border-top: 1px solid var(--c-border);
	}
	.name {
		margin: 0;
		font-size: var(--fs-lg);
		font-weight: 650;
	}
	.meta {
		margin: 0;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}
	.active-filter {
		margin: 0;
		font-size: var(--fs-sm);
		color: var(--c-text-muted);
	}
</style>
