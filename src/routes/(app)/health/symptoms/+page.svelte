<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import {
		Badge,
		Button,
		Card,
		EmptyState,
		Input,
		List,
		ListRow,
		PageHeader,
		appPath
	} from '$lib/components';

	let { data, form } = $props();

	type Kind = (typeof data.kinds)[number];

	// No `vitamin`: vitamins are medications now (migration 0018), with a page
	// of their own, and the repository never returns that kind to this page.
	const LABELS: Record<Kind, string> = {
		symptom: 'Symptoms',
		mood: 'Mood',
		energy: 'Energy',
		activity: 'Activity',
		exercise: 'Exercise'
	};

	/** Singular, for the "add" control, which names one thing. */
	const SINGULAR: Record<Kind, string> = {
		symptom: 'symptom',
		mood: 'mood',
		energy: 'energy level',
		activity: 'activity',
		exercise: 'exercise'
	};

	const filterHref = (kind: Kind | null): string =>
		kind ? `/health/symptoms?kind=${kind}` : '/health/symptoms';

	/*
	 * Mood and energy words only ever arrive with a day imported from Notion.
	 * The journal records mood and energy in fields of its own, and its "What
	 * you noticed" card offers symptoms, activity and exercise only, so for
	 * these two "tag a day in your journal" would send someone looking for a
	 * control that does not exist.
	 */
	const IMPORTED_ONLY: Partial<Record<Kind, string>> = {
		mood: 'Mood words come only from days imported from Notion. The journal records your mood in a field of its own, so new days do not add to this list.',
		energy:
			'Energy words come only from days imported from Notion. The journal records your energy in a field of its own, so new days do not add to this list.'
	};
	const importedOnly = $derived(data.kind ? (IMPORTED_ONLY[data.kind] ?? null) : null);

	/** The busiest term sets the bar width; everything else is relative to it. */
	const busiest = $derived(Math.max(1, ...data.frequencies.map((f) => f.days)));
</script>

<svelte:head><title>Symptoms &amp; mood · LifeOS</title></svelte:head>

<PageHeader
	title="Symptoms & mood"
	description="What you have been noticing, and how often."
	back={{ href: '/health', label: 'Health' }}
>
	{#snippet meta()}
		<span>Last {data.windowDays} days</span>
	{/snippet}
</PageHeader>

{#if form?.error}
	<p class="notice error" role="alert">{form.error}</p>
{/if}

<div class="stack">
	<div class="filters">
		<a class="chip" class:on={!data.kind} href={resolve(appPath(filterHref(null)))}>All</a>
		{#each data.kinds as kind (kind)}
			<a
				class="chip"
				class:on={data.kind === kind}
				class:empty={data.counts[kind] === 0}
				href={resolve(appPath(filterHref(kind)))}
			>
				{LABELS[kind]} <span class="tally">{data.counts[kind]}</span>
			</a>
		{/each}
	</div>

	<div class="columns">
		<section aria-labelledby="patterns-heading">
			<h2 id="patterns-heading" class="section-title">Patterns</h2>
			<Card flush>
				{#if data.frequencies.length === 0 && importedOnly}
					<EmptyState title="Nothing imported" description={importedOnly} icon="journal" />
				{:else if data.frequencies.length === 0}
					<EmptyState
						title="Nothing logged yet"
						description="Tag a day in your journal with what you noticed, and it will start showing up here."
						icon="journal"
					>
						{#snippet action()}
							<!-- A plain path: Button resolves its own href, and resolving it
								     twice throws while rendering on the server (the first call
								     returns a relative "../journal"), which took this page down. -->
							<Button href="/journal" size="sm">Open today’s journal</Button>
						{/snippet}
					</EmptyState>
				{:else}
					{#if importedOnly}<p class="patterns-note">{importedOnly}</p>{/if}
					<List label="How often each has come up">
						{#each data.frequencies as row (row.vocabularyId)}
							<ListRow
								title={row.name}
								meta={`${row.days} day${row.days === 1 ? '' : 's'}${
									row.lastLoggedOn ? ` · last ${row.lastLoggedOn}` : ''
								}`}
							>
								{#snippet lead()}
									<Badge tone="neutral">{LABELS[row.kind]}</Badge>
								{/snippet}
								<!-- The bar is redundant with the count on purpose: a
								     number tells you the value, a length tells you the
								     shape of the list at a glance. -->
								<div
									class="bar"
									style:--fill={`${Math.round((row.days / busiest) * 100)}%`}
									aria-hidden="true"
								></div>
							</ListRow>
						{/each}
					</List>
				{/if}
			</Card>
		</section>

		<section aria-labelledby="terms-heading">
			<h2 id="terms-heading" class="section-title">
				{data.kind ? LABELS[data.kind] : 'Everything you track'}
			</h2>
			<Card>
				<form method="POST" action="?/addTerm" class="add" use:enhance>
					<input type="hidden" name="kind" value={data.kind ?? 'symptom'} />
					<div class="grow">
						<Input
							label={`New ${data.kind ? SINGULAR[data.kind] : 'symptom'}`}
							name="name"
							placeholder="What do you want to start noticing?"
							required
						/>
					</div>
					<Button type="submit">Add</Button>
				</form>

				{#if data.terms.length > 0}
					<ul class="terms">
						{#each data.terms as term (term.id)}
							<li>
								<span class="term-name">{term.name}</span>
								<form method="POST" action="?/archiveTerm" use:enhance>
									<input type="hidden" name="id" value={term.id} />
									<input type="hidden" name="archived" value="true" />
									<button type="submit" aria-label={`Archive ${term.name}`}>×</button>
								</form>
							</li>
						{/each}
					</ul>
					<p class="footnote">
						Archiving a word stops it being offered. The days that already used it keep it.
					</p>
				{/if}
			</Card>
		</section>
	</div>
</div>

<style>
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-5);
	}

	.patterns-note {
		margin: 0;
		padding: var(--sp-3) var(--sp-4) 0;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}

	.filters {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-2);
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
	.chip.empty {
		opacity: 0.55;
	}
	.tally {
		font-variant-numeric: tabular-nums;
	}

	.columns {
		display: grid;
		grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
		gap: var(--sp-5);
		align-items: start;
	}

	.section-title {
		margin: 0 0 var(--sp-3);
		font-size: var(--fs-lg);
		font-weight: 650;
	}

	.bar {
		width: var(--fill);
		height: 3px;
		min-width: 2px;
		margin-top: 0.4rem;
		border-radius: 2px;
		background: color-mix(in srgb, var(--c-accent) 55%, transparent);
	}

	.add {
		display: flex;
		gap: var(--sp-3);
		align-items: flex-end;
	}
	.add .grow {
		flex: 1;
		min-width: 0;
	}

	.terms {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-2);
		margin: var(--sp-4) 0 0;
		padding: 0;
		list-style: none;
	}
	.terms li {
		display: inline-flex;
		gap: var(--sp-1);
		align-items: center;
		padding: 0.1rem 0.3rem 0.1rem var(--sp-3);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-pill);
		background: var(--c-surface-alt);
		font-size: var(--fs-xs);
	}
	.terms button {
		width: 1.4rem;
		height: 1.4rem;
		padding: 0;
		border: 0;
		border-radius: 50%;
		background: transparent;
		color: var(--c-text-muted);
		font-size: 1rem;
		line-height: 1;
		cursor: pointer;
	}
	.terms button:hover {
		background: var(--c-surface);
		color: var(--c-crit);
	}

	.footnote {
		margin: var(--sp-3) 0 0;
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
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

	@media (max-width: 60rem) {
		.columns {
			grid-template-columns: 1fr;
		}
	}
</style>
