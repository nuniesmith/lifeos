<script lang="ts">
	import { resolve } from '$app/paths';
	import { Badge, Card, EmptyState, List, ListRow, PageHeader, appPath } from '$lib/components';

	let { data } = $props();

	/** Taken from the load's own type so no server module is named here. */
	type Hit = (typeof data.hits)[number];
	type Kind = Hit['kind'];

	const LABELS: Record<Kind, string> = {
		task: 'Task',
		project: 'Project',
		goal: 'Goal',
		area: 'Area',
		important_date: 'Date',
		daily_log: 'Journal'
	};

	/**
	 * Splits `ts_headline`'s «…» markers into plain segments.
	 *
	 * The excerpt is user-written text that has been through PostgreSQL, so it
	 * is rendered as text and the highlight is structure, never `{@html}`. A
	 * marker is only special when it pairs, which also means a « someone typed
	 * into a note survives as itself.
	 */
	function segments(excerpt: string): { text: string; hit: boolean }[] {
		const out: { text: string; hit: boolean }[] = [];
		const marked = /«([^»]*)»/g;
		let last = 0;
		let match: RegExpExecArray | null;
		while ((match = marked.exec(excerpt)) !== null) {
			if (match.index > last) out.push({ text: excerpt.slice(last, match.index), hit: false });
			out.push({ text: match[1] ?? '', hit: true });
			last = match.index + match[0].length;
		}
		if (last < excerpt.length) out.push({ text: excerpt.slice(last), hit: false });
		return out;
	}

	/**
	 * The same query, narrowed to one kind — or widened back to all of them.
	 *
	 * Built by hand rather than with URLSearchParams: the lint rule steers
	 * mutable built-ins towards their reactive equivalents, and a throwaway
	 * query string wants neither.
	 */
	const filterHref = (kind: Kind | null): string =>
		`/search?q=${encodeURIComponent(data.term)}${kind ? `&kind=${kind}` : ''}`;

	const counts = $derived.by(() => {
		const tally: Partial<Record<Kind, number>> = {};
		for (const hit of data.hits) tally[hit.kind] = (tally[hit.kind] ?? 0) + 1;
		return tally;
	});
</script>

<svelte:head><title>Search · LifeOS</title></svelte:head>

<PageHeader title="Search" description="Everything you can see, in one place.">
	{#snippet meta()}
		{#if data.searched}
			<span
				>{data.hits.length}{data.hits.length === 60 ? '+' : ''} result{data.hits.length === 1
					? ''
					: 's'}</span
			>
		{/if}
	{/snippet}
</PageHeader>

<div class="stack">
	<Card>
		<!-- GET, so a search is a URL. `data-sveltekit-keepfocus` leaves the
		     caret in the box after the navigation, which is where someone
		     refining a query expects it. -->
		<form method="GET" class="search" data-sveltekit-keepfocus data-sveltekit-replacestate>
			<label class="field">
				<span class="label">Search</span>
				<input
					name="q"
					type="search"
					value={data.term}
					placeholder="A word from a task, project, goal or journal entry…"
					autocomplete="off"
					autocapitalize="none"
					spellcheck="false"
				/>
			</label>
			{#if data.kind}<input type="hidden" name="kind" value={data.kind} />{/if}
			<button type="submit">Search</button>
		</form>

		{#if data.searched}
			<div class="filters">
				<a class="chip" class:on={!data.kind} href={resolve(appPath(filterHref(null)))}>All</a>
				{#each data.kinds as kind (kind)}
					<a class="chip" class:on={data.kind === kind} href={resolve(appPath(filterHref(kind)))}>
						{LABELS[kind]}
						{#if !data.kind && counts[kind]}<span class="tally">{counts[kind]}</span>{/if}
					</a>
				{/each}
			</div>
		{/if}
	</Card>

	{#if data.tooShort}
		<Card><p class="hint">Two letters or more, please — one matches nearly everything.</p></Card>
	{:else if !data.searched}
		<Card>
			<EmptyState
				title="Search across your whole workspace"
				description="Tasks, projects, goals, areas, important dates and your own journal. Quote a phrase to match it exactly, or put a minus in front of a word to exclude it."
				icon="search"
			/>
		</Card>
	{:else if data.hits.length === 0}
		<Card>
			<EmptyState
				title={`Nothing matches “${data.term}”`}
				description="Try a shorter word, or drop the filter."
				icon="search"
			/>
		</Card>
	{:else}
		<Card flush>
			<List label={`Results for ${data.term}`}>
				{#each data.hits as hit (hit.kind + hit.id)}
					<ListRow title={hit.title} href={hit.path} muted={hit.archived}>
						{#snippet trail()}
							<Badge tone={hit.archived ? 'neutral' : 'accent'}>
								{hit.archived ? `${LABELS[hit.kind]} · archived` : LABELS[hit.kind]}
							</Badge>
						{/snippet}

						{#if hit.excerpt}
							<p class="excerpt">
								{#each segments(hit.excerpt) as part, i (i)}
									{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}
								{/each}
							</p>
						{/if}
					</ListRow>
				{/each}
			</List>
		</Card>
	{/if}
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
		opacity: 0.7;
	}

	.excerpt {
		margin: 0.2rem 0 0;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}
	mark {
		border-radius: 2px;
		background: color-mix(in srgb, var(--c-accent) 28%, transparent);
		color: inherit;
	}

	.hint {
		margin: 0;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}

	@media (max-width: 30rem) {
		.search {
			flex-direction: column;
			align-items: stretch;
		}
	}
</style>
