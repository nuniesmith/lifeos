<script lang="ts">
	import { resolve } from '$app/paths';
	import { Badge, Card, EmptyState, PageHeader, appPath } from '$lib/components';
	import { CATEGORY_LABELS, FORMAT_LABELS } from '../books/form';

	let { data } = $props();

	const MONTHS = [
		'Jan',
		'Feb',
		'Mar',
		'Apr',
		'May',
		'Jun',
		'Jul',
		'Aug',
		'Sep',
		'Oct',
		'Nov',
		'Dec'
	];

	const maxMonth = $derived(Math.max(1, ...data.insights.finishedPerMonth));
	const hasAnyReading = $derived(data.insights.finishedCount > 0 || data.insights.dnfCount > 0);

	const formatLabel = (format: string | null) =>
		format ? FORMAT_LABELS[format as 'print' | 'ebook' | 'audiobook'] : 'Not set';
	const categoryLabel = (category: string | null) =>
		category ? CATEGORY_LABELS[category as 'fiction' | 'nonfiction'] : 'Not set';
</script>

<svelte:head><title>Reading Insights · LifeOS</title></svelte:head>

<PageHeader
	title="Reading Insights"
	description="How your year of reading went."
	back={{ href: '/reading', label: 'Reading Tracker' }}
/>

<div class="stack">
	<div class="year-nav">
		<a class="year-step" href={resolve(appPath(`/reading/insights?year=${data.year - 1}`))}>
			‹ {data.year - 1}
		</a>
		<span class="year-current">{data.year}</span>
		{#if data.year < data.currentYear}
			<a class="year-step" href={resolve(appPath(`/reading/insights?year=${data.year + 1}`))}>
				{data.year + 1} ›
			</a>
		{/if}
	</div>

	{#if data.years.length > 0}
		<nav class="year-picker" aria-label="Years with finished reads">
			{#each data.years as y (y)}
				<a
					class="year-pill"
					class:active={y === data.year}
					href={resolve(appPath(`/reading/insights?year=${y}`))}
					aria-current={y === data.year ? 'true' : undefined}
				>
					{y}
				</a>
			{/each}
		</nav>
	{/if}

	{#if !hasAnyReading}
		<Card>
			<EmptyState
				title="Nothing finished in {data.year}"
				description="Finish or DNF a read in the reading log and it shows up here."
				icon="journal"
			/>
		</Card>
	{:else}
		<div class="tiles">
			<Card>
				<p class="tile-value">{data.insights.finishedCount}</p>
				<p class="tile-label">Finished</p>
			</Card>
			<Card>
				<p class="tile-value">{data.insights.dnfCount}</p>
				<p class="tile-label">DNF</p>
			</Card>
			<Card>
				<p class="tile-value">{data.insights.pagesRead.toLocaleString()}</p>
				<p class="tile-label">Pages read</p>
				{#if data.insights.pagesUnknownCount > 0}
					<p class="tile-note">+{data.insights.pagesUnknownCount} of unknown length</p>
				{/if}
			</Card>
			<Card>
				<p class="tile-value">{data.insights.audiobookHours.toFixed(1)}</p>
				<p class="tile-label">Audiobook hours</p>
				{#if data.insights.audiobookUnknownCount > 0}
					<p class="tile-note">+{data.insights.audiobookUnknownCount} of unknown length</p>
				{/if}
			</Card>
			<Card>
				<p class="tile-value">
					{data.insights.averageRating !== null ? data.insights.averageRating.toFixed(2) : '—'}
				</p>
				<p class="tile-label">Average rating</p>
			</Card>
		</div>

		<Card title="Finished per month">
			<div class="month-chart" role="img" aria-label="Books finished each month of {data.year}">
				{#each data.insights.finishedPerMonth as count, index (index)}
					<div class="month-bar">
						<div class="bar-track">
							<div
								class="bar-fill"
								style:height="{count > 0 ? Math.max(6, (count / maxMonth) * 100) : 0}%"
								title="{MONTHS[index]}: {count} finished"
							></div>
						</div>
						<span class="month-label">{MONTHS[index]}</span>
					</div>
				{/each}
			</div>
			{#if data.insights.finishedMonthUnknown > 0}
				<p class="chart-note">
					{data.insights.finishedMonthUnknown} more finished in {data.year}, month not recorded.
				</p>
			{/if}
		</Card>

		{#if data.insights.longestBook || data.insights.shortestBook}
			<div class="tiles">
				{#if data.insights.longestBook}
					<Card>
						<p class="tile-value">{data.insights.longestBook.pages}</p>
						<p class="tile-label">Longest: {data.insights.longestBook.title}</p>
					</Card>
				{/if}
				{#if data.insights.shortestBook}
					<Card>
						<p class="tile-value">{data.insights.shortestBook.pages}</p>
						<p class="tile-label">Shortest: {data.insights.shortestBook.title}</p>
					</Card>
				{/if}
			</div>
		{/if}

		<Card title="By format">
			<div class="badge-row">
				{#each data.insights.byFormat as row (row.format ?? 'none')}
					<Badge tone="neutral">{formatLabel(row.format)}: {row.count}</Badge>
				{/each}
			</div>
		</Card>

		<Card title="By category">
			<div class="badge-row">
				{#each data.insights.byCategory as row (row.category ?? 'none')}
					<Badge tone="neutral">{categoryLabel(row.category)}: {row.count}</Badge>
				{/each}
			</div>
		</Card>

		{#if data.insights.topGenres.length > 0}
			<Card title="Top genres">
				<ol class="rank-list">
					{#each data.insights.topGenres as genre (genre.id)}
						<li>
							<span class="rank-name">{genre.name}</span><span class="rank-count"
								>{genre.count}</span
							>
						</li>
					{/each}
				</ol>
			</Card>
		{/if}

		{#if data.insights.topAuthors.length > 0}
			<Card title="Top authors">
				<ol class="rank-list">
					{#each data.insights.topAuthors as author (author.id)}
						<li>
							<span class="rank-name">{author.name}</span><span class="rank-count"
								>{author.count}</span
							>
						</li>
					{/each}
				</ol>
			</Card>
		{/if}
	{/if}
</div>

<style>
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}

	.year-nav {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--sp-4);
	}
	.year-step {
		color: var(--c-accent);
		font-weight: 600;
		text-decoration: none;
	}
	.year-current {
		font-size: var(--fs-lg);
		font-weight: 650;
	}

	.year-picker {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-2);
		justify-content: center;
	}
	.year-pill {
		padding: var(--sp-1) var(--sp-3);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-pill);
		background: var(--c-surface);
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
		font-weight: 600;
		text-decoration: none;
	}
	.year-pill.active {
		border-color: var(--c-accent);
		background: color-mix(in srgb, var(--c-accent) 14%, transparent);
		color: var(--c-text);
	}

	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 9rem), 1fr));
		gap: var(--sp-3);
	}
	.tile-value {
		margin: 0;
		font-size: var(--fs-xl, 1.5rem);
		font-weight: 700;
		color: var(--c-text);
	}
	.tile-label {
		margin: var(--sp-1) 0 0;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}
	.tile-note {
		margin: var(--sp-1) 0 0;
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
	}

	/* A single series (this year's finished count), so one hue and no legend
	   -- the card's own title already names what it shows. Rounded tops,
	   anchored to a shared baseline, each bar's own native title standing in
	   for a hover tooltip, the same device MeasurementChart.svelte's points
	   use. */
	.month-chart {
		display: flex;
		align-items: flex-end;
		gap: var(--sp-1);
		height: 8rem;
	}
	.month-bar {
		display: flex;
		flex: 1;
		flex-direction: column;
		align-items: center;
		gap: var(--sp-1);
		height: 100%;
	}
	.bar-track {
		display: flex;
		align-items: flex-end;
		flex: 1;
		width: 100%;
		border-bottom: 1px solid var(--c-border);
	}
	.bar-fill {
		width: 100%;
		min-height: 0;
		border-radius: 4px 4px 0 0;
		background: var(--c-accent);
	}
	.chart-note {
		margin: var(--sp-3) 0 0;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}
	.month-label {
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
	}

	.badge-row {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-2);
	}

	.rank-list {
		display: flex;
		flex-direction: column;
		gap: var(--sp-2);
		margin: 0;
		padding: 0;
		list-style: none;
		counter-reset: rank;
	}
	.rank-list li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--sp-2);
		counter-increment: rank;
	}
	.rank-list li::before {
		content: counter(rank) '.';
		flex: none;
		width: 1.4rem;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}
	.rank-name {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.rank-count {
		flex: none;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}
</style>
