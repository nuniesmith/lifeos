<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import {
		Badge,
		Button,
		Card,
		EmptyState,
		List,
		ListRow,
		PageHeader,
		appPath
	} from '$lib/components';

	let { data, form } = $props();

	type Kind = (typeof data.kinds)[number];

	const LABELS: Record<Kind, string> = {
		task: 'Task',
		project: 'Project',
		goal: 'Goal',
		area: 'Area',
		habit: 'Habit',
		tag: 'Tag',
		daily_log: 'Journal',
		important_date: 'Date',
		significant_event: 'Event',
		life_assessment: 'Assessment',
		medication: 'Medication',
		medical_visit: 'Visit',
		lab_marker: 'Lab marker',
		lab_result: 'Lab result',
		health_measurement: 'Reading',
		health_term: 'Health term',
		recipe: 'Recipe',
		ingredient: 'Ingredient',
		meal_plan: 'Meal plan',
		prep_task: 'Prep',
		food: 'Food',
		library_item: 'Library',
		person: 'Person',
		wishlist_item: 'Wishlist',
		media_item: 'Watchlist',
		bill: 'Bill',
		income_entry: 'Income',
		routine: 'Routine',
		savings_contribution: 'Savings',
		book: 'Book',
		author: 'Author',
		book_series: 'Series',
		genre: 'Genre',
		reading_challenge: 'Challenge'
	};

	/**
	 * A chip for each kind that has something archived, and for the one being
	 * filtered by even when it has nothing (so /bin still shows "Task 0").
	 * With six kinds a dimmed zero was information; with two dozen, a chip for
	 * every one wrapped to half a phone screen of zeros before the first record.
	 */
	const chips = $derived(data.kinds.filter((kind) => data.counts[kind] > 0 || data.kind === kind));

	const filterHref = (kind: Kind | null): string => {
		const query = data.search ? `q=${encodeURIComponent(data.search)}` : '';
		const k = kind ? `kind=${kind}` : '';
		const parts = [k, query].filter(Boolean).join('&');
		return parts ? `/archive?${parts}` : '/archive';
	};

	/** "3 August 2026" — the day it left, which is what people remember. */
	const when = (date: Date): string =>
		date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
</script>

<svelte:head><title>Archive · LifeOS</title></svelte:head>

<PageHeader
	title="Archive"
	description="Nothing here was deleted. Everything can go back where it came from."
>
	{#snippet meta()}
		<span>{data.total} archived</span>
	{/snippet}
</PageHeader>

{#if form?.error}
	<p class="notice error" role="alert">{form.error}</p>
{/if}

<div class="stack">
	<Card>
		<form method="GET" class="search" data-sveltekit-keepfocus>
			<label class="field">
				<span class="label">Search the archive</span>
				<input
					name="q"
					type="search"
					value={data.search}
					placeholder="Part of a name"
					autocomplete="off"
				/>
			</label>
			{#if data.kind}<input type="hidden" name="kind" value={data.kind} />{/if}
			<button type="submit">Search</button>
		</form>

		<div class="filters">
			<a class="chip" class:on={!data.kind} href={resolve(appPath(filterHref(null)))}>
				All <span class="tally">{data.total}</span>
			</a>
			{#each chips as kind (kind)}
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
	</Card>

	<Card flush>
		{#if data.records.length === 0}
			<EmptyState
				title={data.search || data.kind ? 'Nothing matches' : 'The archive is empty'}
				description={data.search || data.kind
					? 'Try a different filter, or clear the search.'
					: 'Anything you archive lands here, and can be restored from here.'}
				icon="projects"
			/>
		{:else}
			<List label="Archived records">
				{#each data.records as record (record.kind + record.id)}
					<ListRow
						title={record.title}
						href={record.path ?? undefined}
						meta={`Archived ${when(record.archivedAt)}`}
						muted
					>
						<!-- Under the title, not beside it: with the Restore button on
						     the right, a "Medication" badge on the left left a phone
						     too narrow a column to fit a name without breaking it. -->
						<Badge tone="neutral">{LABELS[record.kind]}</Badge>
						{#snippet trail()}
							<form method="POST" action="?/restore" use:enhance>
								<input type="hidden" name="kind" value={record.kind} />
								<input type="hidden" name="id" value={record.id} />
								<Button type="submit" size="sm" aria-label={`Restore ${record.title}`}>
									Restore
								</Button>
							</form>
						{/snippet}
					</ListRow>
				{/each}
			</List>
		{/if}
	</Card>
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
		/* A two-word label wraps as a whole chip, never inside one. */
		white-space: nowrap;
	}
	.chip.on {
		border-color: var(--c-accent);
		background: color-mix(in srgb, var(--c-accent) 12%, transparent);
		color: var(--c-text);
	}
	/* Only the kind being filtered by can be empty; it stays, dimmed. */
	.chip.empty {
		opacity: 0.55;
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
