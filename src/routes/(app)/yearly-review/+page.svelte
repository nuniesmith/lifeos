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

	const stats = $derived([
		{ label: 'Days logged', value: data.review.daysLogged },
		{ label: 'Habits logged', value: data.review.habitsLogged },
		{ label: 'Goals achieved', value: data.review.goalsAchieved },
		{ label: 'Tasks completed', value: data.review.tasksCompleted },
		{ label: 'Projects finished', value: data.review.projectsCompleted },
		{ label: 'Moments kept', value: data.review.events }
	]);
</script>

<svelte:head><title>Reflect &amp; Reset · LifeOS</title></svelte:head>

<PageHeader title="Reflect & Reset" description="The year as it was actually lived.">
	{#snippet meta()}
		<span>
			{data.review.habitConsistency !== null
				? `${data.review.habitConsistency}% habit consistency`
				: 'No habit history yet'}
		</span>
	{/snippet}
</PageHeader>

{#if form?.error}<p class="notice error" role="alert">{form.error}</p>{/if}

<div class="stack">
	{#if data.years.length > 1}
		<div class="filters">
			{#each data.years as year (year)}
				<a
					class="chip"
					class:on={data.year === year}
					href={resolve(appPath(`/yearly-review?year=${year}`))}
				>
					{year}
				</a>
			{/each}
		</div>
	{/if}

	<div class="grid">
		{#each stats as stat (stat.label)}
			<div class="stat">
				<span class="value">{stat.value}</span>
				<span class="label">{stat.label}</span>
			</div>
		{/each}
	</div>

	{#if data.review.dominantMood}
		<Card>
			<p class="mood">
				Most days felt <strong>{data.review.dominantMood.name}</strong> —
				{data.review.dominantMood.days} of {data.review.daysLogged} logged.
			</p>
		</Card>
	{/if}

	<section aria-labelledby="events-heading">
		<h2 id="events-heading" class="section-title">What happened</h2>
		<Card>
			<form method="POST" action="?/addEvent" class="add" use:enhance>
				<div class="grow"><Input label="Something worth remembering" name="title" required /></div>
				<div><Input label="When" name="onDate" type="date" required /></div>
				<label class="who">
					<span class="label">Area</span>
					<select name="areaId">
						<option value="">No area</option>
						{#each data.areas as area (area.id)}<option value={area.id}>{area.name}</option>{/each}
					</select>
				</label>
				<Button type="submit">Add</Button>
			</form>
		</Card>
		<div class="spaced">
			<Card flush>
				{#if data.events.length === 0}
					<EmptyState
						title="Nothing recorded for {data.year}"
						description="The moments worth keeping, whenever you think of them."
						icon="journal"
					/>
				{:else}
					<List label="Significant events">
						{#each data.events as event (event.id)}
							<ListRow title={event.title} meta={event.onDate}>
								{#snippet trail()}
									{#if event.areaName}<Badge tone="neutral">{event.areaName}</Badge>{/if}
								{/snippet}
							</ListRow>
						{/each}
					</List>
				{/if}
			</Card>
		</div>
	</section>

	{#if data.assessments.length > 0}
		<section aria-labelledby="wheel-heading">
			<h2 id="wheel-heading" class="section-title">How it felt</h2>
			<Card flush>
				<List label="Ratings for the year">
					{#each data.assessments as a (a.id)}
						<ListRow title={a.focus} meta={[a.areaName, a.period].filter(Boolean).join(' · ')}>
							{#snippet trail()}
								<Badge tone={a.rating <= 3 ? 'crit' : a.rating <= 6 ? 'warn' : 'ok'}>
									{a.rating}/10
								</Badge>
							{/snippet}
						</ListRow>
					{/each}
				</List>
			</Card>
		</section>
	{/if}

	<p class="footnote">
		Every number here is counted from your logs, habits, goals and tasks when the page loads — not
		stored and refreshed, so it cannot fall behind what actually happened.
	</p>
</div>

<style>
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-5);
	}
	.section-title {
		margin: 0 0 var(--sp-3);
		font-size: var(--fs-lg);
		font-weight: 650;
	}
	.spaced {
		margin-top: var(--sp-3);
	}
	.filters {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-2);
	}
	.chip {
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
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
		gap: var(--sp-3);
	}
	.stat {
		display: grid;
		gap: 0.15rem;
		padding: var(--sp-4);
		border: 1px solid var(--c-border);
		border-radius: var(--radius);
		background: var(--c-surface);
	}
	.value {
		font-size: 1.9rem;
		font-weight: 650;
		font-variant-numeric: tabular-nums;
		line-height: 1.1;
	}
	.stat .label {
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}
	.mood {
		margin: 0;
		font-size: var(--fs-sm);
	}
	.add {
		display: flex;
		gap: var(--sp-3);
		align-items: flex-end;
		flex-wrap: wrap;
	}
	.add .grow {
		flex: 1;
		min-width: 12rem;
	}
	.who {
		display: grid;
		gap: 0.3rem;
	}
	.who .label {
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}
	select {
		min-height: var(--tap);
		padding: 0 var(--sp-2);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-sm);
		background: var(--c-surface);
		color: var(--c-text);
		font: inherit;
	}
	.footnote {
		margin: 0;
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
</style>
