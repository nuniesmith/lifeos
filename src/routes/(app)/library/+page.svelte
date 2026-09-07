<script lang="ts">
	import { resolve } from '$app/paths';
	import { Card, LibraryList, PageHeader, appPath } from '$lib/components';

	let { data, form } = $props();

	const TYPE_LABELS: Record<string, string> = {
		book: 'Books',
		note: 'Notes',
		reference: 'References'
	};

	const href = (type: string | null): string => {
		const q = data.search ? `q=${encodeURIComponent(data.search)}` : '';
		const t = type ? `type=${type}` : '';
		const parts = [t, q].filter(Boolean).join('&');
		return parts ? `/library?${parts}` : '/library';
	};
</script>

<svelte:head><title>Library · LifeOS</title></svelte:head>

<PageHeader title="Library" description="Everything worth keeping, in one place.">
	{#snippet meta()}
		<span>{data.summary.total} entries · {data.summary.highlights} highlights</span>
	{/snippet}
</PageHeader>

{#if form?.error}<p class="notice error" role="alert">{form.error}</p>{/if}

<div class="stack">
	<Card>
		<form method="GET" class="search" data-sveltekit-keepfocus>
			<label class="field">
				<span class="label">Search the library</span>
				<input
					name="q"
					type="search"
					value={data.search}
					placeholder="Title or author"
					autocomplete="off"
				/>
			</label>
			{#if data.entryType}<input type="hidden" name="type" value={data.entryType} />{/if}
			<button type="submit">Search</button>
		</form>

		<div class="filters">
			<a class="chip" class:on={!data.entryType} href={resolve(appPath(href(null)))}>
				All <span class="tally">{data.summary.total}</span>
			</a>
			{#each data.types as type (type)}
				<a class="chip" class:on={data.entryType === type} href={resolve(appPath(href(type)))}>
					{TYPE_LABELS[type]} <span class="tally">{data.summary.byType[type]}</span>
				</a>
			{/each}
		</div>
	</Card>

	<LibraryList
		items={data.items}
		emptyTitle={data.search || data.entryType ? 'Nothing matches' : 'The library is empty'}
		emptyDescription="Books, articles, podcasts and notes all live here."
	/>
</div>

<style>
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}
	.search {
		display: flex;
		gap: var(--sp-3);
		align-items: flex-end;
	}
	.field {
		display: grid;
		flex: 1;
		gap: 0.3rem;
		min-width: 0;
	}
	.label {
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}
	.search input {
		width: 100%;
		min-height: var(--tap);
		padding: 0 var(--sp-3);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-sm);
		background: var(--c-surface);
		color: var(--c-text);
		font: inherit;
	}
	.search input:focus-visible {
		outline: 2px solid var(--c-accent);
		outline-offset: 1px;
	}
	.search button {
		min-height: var(--tap);
		padding: 0 var(--sp-4);
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		background: var(--c-accent);
		color: var(--c-on-accent, #fff);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}
	.filters {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-2);
		margin-top: var(--sp-3);
	}
	.chip {
		display: inline-flex;
		gap: var(--sp-1);
		align-items: center;
		padding: 0.15rem var(--sp-3);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-pill);
		background: var(--c-surface-alt);
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
		text-decoration: none;
	}
	.chip.on {
		border-color: var(--c-accent);
		background: color-mix(in srgb, var(--c-accent) 12%, transparent);
		color: var(--c-text);
	}
	.tally {
		font-variant-numeric: tabular-nums;
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
	@media (max-width: 30rem) {
		.search {
			flex-direction: column;
			align-items: stretch;
		}
	}
</style>
