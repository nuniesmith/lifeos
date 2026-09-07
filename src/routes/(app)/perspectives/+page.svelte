<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { Badge, Button, Card, EmptyState, Input, PageHeader, appPath } from '$lib/components';

	let { data, form } = $props();

	/** Low scores are the point, so they are the ones that get the colour. */
	const tone = (rating: number): 'crit' | 'warn' | 'ok' =>
		rating <= 3 ? 'crit' : rating <= 6 ? 'warn' : 'ok';
</script>

<svelte:head><title>Perspectives · LifeOS</title></svelte:head>

<PageHeader
	title="Perspectives"
	description="How each part of life is actually going, in your own words."
>
	{#snippet meta()}
		{#if data.average !== null}<span>Average {data.average} / 10</span>{/if}
	{/snippet}
</PageHeader>

{#if form?.error}<p class="notice error" role="alert">{form.error}</p>{/if}

<div class="stack">
	{#if data.periods.length > 1}
		<div class="filters">
			<a class="chip" class:on={!data.year} href={resolve(appPath('/perspectives'))}>All</a>
			{#each data.periods as p (String(p.year) + p.period)}
				{#if p.year}
					<a
						class="chip"
						class:on={data.year === p.year}
						href={resolve(appPath(`/perspectives?year=${p.year}`))}
					>
						{p.year}
						{p.period ?? ''} <span class="tally">{p.count}</span>
					</a>
				{/if}
			{/each}
		</div>
	{/if}

	<Card>
		<form method="POST" action="?/add" class="add" use:enhance>
			<div class="grow">
				<Input label="Focus" name="focus" placeholder="What are you rating?" required />
			</div>
			<div class="narrow">
				<Input label="Out of 10" name="rating" type="number" min="1" max="10" required />
			</div>
			<div class="narrow"><Input label="When" name="period" placeholder="Start of Year" /></div>
			<div class="narrow"><Input label="Year" name="year" type="number" /></div>
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

	{#if data.assessments.length === 0}
		<Card>
			<EmptyState
				title="Nothing rated yet"
				description="Score each part of life out of ten and the lowest rise to the top."
				icon="goals"
			/>
		</Card>
	{:else}
		<ul class="wheel">
			{#each data.assessments as a (a.id)}
				<li>
					<div class="row">
						<span class="focus">{a.focus}</span>
						<Badge tone={tone(a.rating)}>{a.rating}/10</Badge>
					</div>
					<!-- The bar repeats the number rather than replacing it: the
					     score is the fact, the length is the comparison. -->
					<div class="track" aria-hidden="true">
						<div class="fill" class:low={a.rating <= 3} style:--w={`${a.rating * 10}%`}></div>
					</div>
					<p class="meta">
						{[a.areaName, a.period, a.year ? String(a.year) : null].filter(Boolean).join(' · ')}
					</p>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
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
	.tally {
		font-variant-numeric: tabular-nums;
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
	.add .narrow {
		width: 7rem;
	}
	.who {
		display: grid;
		gap: 0.3rem;
	}
	.label {
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
	.wheel {
		display: grid;
		gap: var(--sp-4);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.wheel li {
		padding: var(--sp-4);
		border: 1px solid var(--c-border);
		border-radius: var(--radius);
		background: var(--c-surface);
	}
	.row {
		display: flex;
		gap: var(--sp-3);
		align-items: center;
		justify-content: space-between;
	}
	.focus {
		font-size: var(--fs-base);
		font-weight: 620;
	}
	.track {
		height: 6px;
		margin-top: var(--sp-3);
		border-radius: 3px;
		background: var(--c-surface-alt);
		overflow: hidden;
	}
	.fill {
		width: var(--w);
		height: 100%;
		border-radius: 3px;
		background: var(--c-accent);
	}
	.fill.low {
		background: var(--c-crit);
	}
	.meta {
		margin: var(--sp-2) 0 0;
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
