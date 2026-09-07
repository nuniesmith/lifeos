<script lang="ts">
	import { resolve } from '$app/paths';
	import { Badge, Card, EmptyState, List, ListRow, PageHeader, appPath } from '$lib/components';

	let { data } = $props();

	type Area = (typeof data.areas)[number];

	/**
	 * How long past its cadence an area is, or null when it is not on one.
	 *
	 * Kept in the page rather than the load because it is presentation: the
	 * review page owns the authoritative queue, and this is a glance at it.
	 */
	const DAY_MS = 86_400_000;

	function overdueBy(area: Area): number | null {
		if (area.reviewEveryDays === null) return null;
		if (area.lastReviewedOn === null) return 0;
		// Parsed to timestamps rather than Date objects: both days are UTC
		// midnight, so the subtraction is exact and nothing is mutated.
		const last = Date.parse(`${area.lastReviewedOn}T00:00:00Z`);
		const today = Date.parse(`${data.today}T00:00:00Z`);
		return Math.round((today - last) / DAY_MS) - area.reviewEveryDays;
	}

	const neglected = $derived(
		data.areas
			.map((area) => ({ area, days: overdueBy(area) }))
			.filter((row): row is { area: Area; days: number } => row.days !== null && row.days >= 0)
			.sort((a, b) => b.days - a.days)
	);

	const headline = $derived([
		{ label: 'Waiting in the inbox', value: data.tasks.waiting, href: '/inbox', tone: 'accent' },
		{ label: 'Overdue', value: data.tasks.overdue, href: '/tasks?view=overdue', tone: 'crit' },
		{ label: 'Due today', value: data.tasks.dueToday, href: '/tasks?view=today', tone: 'accent' },
		{ label: 'Open in total', value: data.tasks.open, href: '/tasks?view=open', tone: 'neutral' }
	] as const);
</script>

<svelte:head><title>Master Dashboards · LifeOS</title></svelte:head>

<PageHeader
	title="Master Dashboards"
	description="Where the work is sitting, and what is quietly not moving."
/>

<div class="stack">
	<div class="headline">
		{#each headline as stat (stat.label)}
			<a class="stat" class:crit={stat.tone === 'crit'} href={resolve(appPath(stat.href))}>
				<span class="value">{stat.value}</span>
				<span class="label">{stat.label}</span>
			</a>
		{/each}
	</div>

	<div class="columns">
		<section aria-labelledby="areas-heading">
			<h2 id="areas-heading" class="section-title">Life areas</h2>
			<Card flush>
				{#if data.areas.length === 0}
					<EmptyState
						title="No areas yet"
						description="Areas are the standing parts of a life — Health, Finances, Home."
						icon="areas"
					/>
				{:else}
					<List label="Areas and their open work">
						{#each data.areas as area (area.id)}
							<ListRow
								title={area.name}
								href={`/areas/${area.id}`}
								meta={`${area.openTasks} open${area.overdueTasks > 0 ? ` · ${area.overdueTasks} overdue` : ''}`}
							>
								{#snippet trail()}
									{#if area.reviewEveryDays === null}
										<span class="quiet">No review cycle</span>
									{:else if area.lastReviewedOn === null}
										<Badge tone="warn" dot>Never reviewed</Badge>
									{:else}
										<span class="quiet">Reviewed {area.lastReviewedOn}</span>
									{/if}
								{/snippet}
							</ListRow>
						{/each}
					</List>
				{/if}
			</Card>
		</section>

		<div class="side">
			<section aria-labelledby="attention-heading">
				<h2 id="attention-heading" class="section-title">Wants attention</h2>
				<Card>
					<ul class="attention">
						<li>
							<a href={resolve(appPath('/review'))}>
								<strong>{data.reviewDue}</strong> due for review
							</a>
						</li>
						<li>
							<a href={resolve(appPath('/review'))}>
								<strong>{data.goals.needingSetup}</strong> goal{data.goals.needingSetup === 1
									? ''
									: 's'} with nothing behind them
							</a>
						</li>
						<li>
							<a href={resolve(appPath('/projects'))}>
								<strong>{data.projects.overdue}</strong> project{data.projects.overdue === 1
									? ''
									: 's'} past their end date
							</a>
						</li>
						<li>
							<a href={resolve(appPath('/tasks'))}>
								<strong>{data.tasks.unfiled}</strong> task{data.tasks.unfiled === 1 ? '' : 's'} with no
								project
							</a>
						</li>
					</ul>
				</Card>
			</section>

			<section aria-labelledby="goals-heading">
				<h2 id="goals-heading" class="section-title">Goals</h2>
				<Card>
					<ul class="counts">
						<li><span class="count">{data.goals.active}</span><span class="what">active</span></li>
						<li>
							<span class="count">{data.goals.later}</span><span class="what">for later</span>
						</li>
						<li><span class="count">{data.goals.total}</span><span class="what">in total</span></li>
					</ul>
				</Card>
			</section>

			{#if neglected.length > 0}
				<section aria-labelledby="neglected-heading">
					<h2 id="neglected-heading" class="section-title">Longest unreviewed</h2>
					<Card flush>
						<List label="Areas overdue for review">
							{#each neglected.slice(0, 5) as row (row.area.id)}
								<ListRow
									title={row.area.name}
									href={`/areas/${row.area.id}`}
									meta={row.area.lastReviewedOn === null
										? 'Never reviewed'
										: `${row.days} day${row.days === 1 ? '' : 's'} past due`}
								/>
							{/each}
						</List>
					</Card>
				</section>
			{/if}
		</div>
	</div>
</div>

<style>
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-6);
	}

	.headline {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
		gap: var(--sp-3);
	}
	.stat {
		display: grid;
		gap: 0.15rem;
		padding: var(--sp-4);
		border: 1px solid var(--c-border);
		border-radius: var(--radius);
		background: var(--c-surface);
		color: var(--c-text);
		text-decoration: none;
	}
	.stat:hover {
		border-color: var(--c-accent);
	}
	.stat.crit .value {
		color: var(--c-crit);
	}
	.value {
		font-size: 2rem;
		font-weight: 650;
		font-variant-numeric: tabular-nums;
		line-height: 1.1;
	}
	.label {
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}

	.columns {
		display: grid;
		grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr);
		gap: var(--sp-5);
		align-items: start;
	}
	.side {
		display: flex;
		flex-direction: column;
		gap: var(--sp-5);
	}

	.section-title {
		margin: 0 0 var(--sp-3);
		font-size: var(--fs-lg);
		font-weight: 650;
	}

	.attention {
		display: grid;
		gap: var(--sp-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.attention a {
		color: var(--c-text);
		font-size: var(--fs-sm);
		text-decoration: none;
	}
	.attention a:hover {
		text-decoration: underline;
	}
	.attention strong {
		font-variant-numeric: tabular-nums;
	}

	.counts {
		display: flex;
		gap: var(--sp-5);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.counts li {
		display: grid;
		gap: 0.1rem;
	}
	.count {
		font-size: var(--fs-xl);
		font-weight: 650;
		font-variant-numeric: tabular-nums;
	}
	.what {
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}

	.quiet {
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
	}

	@media (max-width: 60rem) {
		.columns {
			grid-template-columns: 1fr;
		}
	}
</style>
