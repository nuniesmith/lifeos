<script lang="ts">
	import { resolve } from '$app/paths';
	import { Badge, Card, EmptyState, PageHeader, appPath } from '$lib/components';
	import type { TimelineEntry } from './+page.server';

	let { data } = $props();

	const at = (day: string) => new Date(`${day}T00:00:00Z`);
	const longDate = $derived(
		at(data.date).toLocaleDateString(undefined, {
			weekday: 'long',
			day: 'numeric',
			month: 'long',
			year: data.date.slice(0, 4) === data.today.slice(0, 4) ? undefined : 'numeric',
			timeZone: 'UTC'
		})
	);

	/** The journal's own words for its 1–5 energy scale. */
	const ENERGY_LABELS: Record<number, string> = {
		1: 'Drained',
		2: 'Low',
		3: 'Steady',
		4: 'Good',
		5: 'Buzzing'
	};

	const KIND_LABELS: Record<TimelineEntry['kind'], string> = {
		reading: 'Reading',
		dose: 'Dose',
		visit: 'Visit',
		lab: 'Lab result'
	};

	const empty = $derived(
		data.timed.length === 0 &&
			data.allDay.length === 0 &&
			data.journal.mood === null &&
			data.journal.energyLevel === null &&
			data.journal.words.length === 0
	);
</script>

<svelte:head><title>Health on {longDate} · LifeOS</title></svelte:head>

<PageHeader title="Health on this day" description={longDate}>
	{#snippet meta()}
		{#if data.date === data.today}<Badge tone="accent">Today</Badge>{/if}
	{/snippet}
</PageHeader>

<nav class="steps" aria-label="Other days">
	<a class="step" href={resolve(appPath(`/health/day/${data.previous}`))} rel="prev">
		← Previous day
	</a>
	<a class="step" href={resolve(appPath(`/journal/${data.date}`))}>Journal</a>
	{#if data.next}
		<a class="step" href={resolve(appPath(`/health/day/${data.next}`))} rel="next"> Next day → </a>
	{/if}
</nav>

{#snippet entryRow(entry: TimelineEntry)}
	<li class="entry">
		<span class="time">{entry.time ?? ''}</span>
		<div class="body">
			<span class="kind">{KIND_LABELS[entry.kind]}</span>
			{#if entry.href}
				<a class="title" href={resolve(appPath(entry.href))}>{entry.title}</a>
			{:else}
				<span class="title">{entry.title}</span>
			{/if}
			{#if entry.detail}
				<span class="detail">
					{entry.detail}
					{#if entry.flag}<Badge tone="warn">{entry.flag === 'high' ? 'High' : 'Low'}</Badge>{/if}
				</span>
			{/if}
		</div>
	</li>
{/snippet}

<div class="stack">
	{#if empty}
		<EmptyState
			title="Nothing recorded on this day"
			description="Readings, doses, visits and lab results land here, with what the journal noted."
		/>
	{/if}

	{#if data.timed.length > 0}
		<Card title="Through the day">
			<ol class="timeline" aria-label="Through the day">
				{#each data.timed as entry (entry.key)}
					{@render entryRow(entry)}
				{/each}
			</ol>
		</Card>
	{/if}

	{#if data.allDay.length > 0}
		<Card title="All day" subtitle="No time recorded">
			<ul class="timeline" aria-label="All day">
				{#each data.allDay as entry (entry.key)}
					{@render entryRow(entry)}
				{/each}
			</ul>
		</Card>
	{/if}

	{#if data.journal.mood !== null || data.journal.energyLevel !== null || data.journal.words.length > 0}
		<Card title="From your journal">
			<dl class="journal">
				{#if data.journal.mood !== null}
					<div>
						<dt>Mood</dt>
						<dd>{data.journal.mood}</dd>
					</div>
				{/if}
				{#if data.journal.energyLevel !== null}
					<div>
						<dt>Energy</dt>
						<dd>{ENERGY_LABELS[data.journal.energyLevel] ?? data.journal.energyLevel}</dd>
					</div>
				{/if}
				{#each data.journal.words as group (group.label)}
					<div>
						<dt>{group.label}</dt>
						<dd>{group.names.join(', ')}</dd>
					</div>
				{/each}
			</dl>
		</Card>
	{/if}
</div>

<style>
	.steps {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-2);
		margin-bottom: var(--sp-4);
	}
	.step {
		display: inline-flex;
		align-items: center;
		min-height: var(--tap);
		padding: 0 var(--sp-3);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-pill);
		background: var(--c-surface);
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
		text-decoration: none;
		white-space: nowrap;
	}
	.step:hover {
		border-color: var(--c-accent);
		color: var(--c-text);
	}
	.step[rel='next'] {
		margin-left: auto;
	}

	.stack {
		display: grid;
		gap: var(--sp-4);
	}

	.timeline {
		display: grid;
		gap: var(--sp-3);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.entry {
		display: grid;
		grid-template-columns: 3.25rem 1fr;
		gap: var(--sp-3);
		align-items: baseline;
	}
	.time {
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
		font-variant-numeric: tabular-nums;
	}
	.body {
		display: grid;
		gap: 0.1rem;
		min-width: 0;
	}
	.kind {
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.title {
		font-weight: 600;
		color: var(--c-text);
		overflow-wrap: anywhere;
	}
	a.title {
		text-decoration: none;
	}
	a.title:hover {
		text-decoration: underline;
	}
	.detail {
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
		overflow-wrap: anywhere;
	}

	.journal {
		display: grid;
		gap: var(--sp-2);
		margin: 0;
	}
	.journal > div {
		display: grid;
		grid-template-columns: 6rem 1fr;
		gap: var(--sp-3);
	}
	dt {
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}
	dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
</style>
