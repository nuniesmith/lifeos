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
		Textarea,
		appPath
	} from '$lib/components';
	import type { JournalData } from './entry';
	import HealthTags, { type TagResult } from './HealthTags.svelte';

	interface Props {
		data: JournalData;
		/** Whatever the last action returned; both routes post the same ones. */
		form?: ({ error?: string; saved?: boolean } & TagResult) | null;
	}

	let { data, form }: Props = $props();

	/**
	 * Whether anything has been written, as opposed to the day merely existing.
	 * Tagging a day before writing about it starts its entry (see entry.ts), and
	 * "Written" on a day that only carries a headache would be untrue.
	 */
	const written = $derived(
		data.entry !== null &&
			(data.entry.energyLevel !== null ||
				[data.entry.note, data.entry.mood, data.entry.gratitude, data.entry.highlight].some(
					(text) => text.trim() !== ''
				))
	);

	/**
	 * Dates are read at midday. The day itself arrives as `YYYY-MM-DD` from the
	 * server in the household's timezone; parsing it at midnight would let a
	 * browser an hour behind render the day before.
	 */
	const at = (day: string) => new Date(`${day}T12:00:00`);

	const longDate = $derived(
		at(data.date).toLocaleDateString(undefined, {
			weekday: 'long',
			day: 'numeric',
			month: 'long',
			year: data.date.slice(0, 4) === data.today.slice(0, 4) ? undefined : 'numeric'
		})
	);

	/** How a person says the day, when there is a shorter way to say it. */
	function relative(day: string): string {
		if (day === data.today) return 'Today';
		const delta = Math.round(
			(Date.parse(`${day}T00:00:00Z`) - Date.parse(`${data.today}T00:00:00Z`)) / 86_400_000
		);
		if (delta === -1) return 'Yesterday';
		if (delta === 1) return 'Tomorrow';
		return '';
	}

	const shortDate = (day: string) =>
		at(day).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

	const ENERGY = [1, 2, 3, 4, 5];
	const ENERGY_LABELS: Record<number, string> = {
		1: 'Drained',
		2: 'Low',
		3: 'Steady',
		4: 'Good',
		5: 'Buzzing'
	};

	const isToday = $derived(data.date === data.today);
</script>

<svelte:head><title>Journal · LifeOS</title></svelte:head>

<PageHeader title="Journal" description={longDate}>
	{#snippet meta()}
		{#if relative(data.date)}<Badge tone="accent">{relative(data.date)}</Badge>{/if}
		<!-- Stated, not offered as a setting: daily logs are private by design
		     and this page has no control that could widen one. -->
		<Badge tone="neutral" dot>Private to you</Badge>
		{#if written}<Badge tone="ok">Written</Badge>{/if}
	{/snippet}
</PageHeader>

{#if form?.error}
	<p class="notice error" role="alert">{form.error}</p>
{:else if form?.saved}
	<p class="notice ok" role="status">Saved.</p>
{/if}

<nav class="days" aria-label="Choose a day">
	<a class="step" href={resolve(appPath(`/journal/${data.previous}`))} rel="prev">
		<span aria-hidden="true">‹</span> Previous day
	</a>

	{#if isToday}
		<span class="step current" aria-current="page">Today</span>
	{:else}
		<a class="step" href={resolve(appPath('/journal'))}>Today</a>
	{/if}

	{#if data.next}
		<a class="step" href={resolve(appPath(`/journal/${data.next}`))} rel="next">
			Next day <span aria-hidden="true">›</span>
		</a>
	{:else}
		<!-- No forward step from today. A journal is written about a day that
		     has happened, so a control to open tomorrow would do nothing
		     useful with the entry it created. -->
		<span class="step spacer" aria-hidden="true"></span>
	{/if}
</nav>

<div class="stack">
	<Card title={isToday ? 'How was today?' : 'How was the day?'}>
		<form method="POST" action="?/save" class="edit" use:enhance>
			<!-- The day travels with the form, so an editor left open across
			     midnight still writes to the day it is showing. -->
			<input type="hidden" name="date" value={data.date} />
			{#if data.entry}
				<!-- The version this form was rendered from, so a save from a
				     stale tab is refused rather than overwriting silently. -->
				<input type="hidden" name="updatedAt" value={data.entry.updatedAt} />
			{/if}

			<fieldset class="energy">
				<legend>Energy</legend>
				<div class="scale">
					<label class="level">
						<input
							type="radio"
							name="energyLevel"
							value=""
							checked={data.entry?.energyLevel == null}
						/>
						<span class="pip">–</span>
						<span class="sr-only">Not recorded</span>
					</label>
					{#each ENERGY as level (level)}
						<label class="level">
							<input
								type="radio"
								name="energyLevel"
								value={String(level)}
								checked={data.entry?.energyLevel === level}
							/>
							<span class="pip">{level}</span>
							<span class="sr-only">{ENERGY_LABELS[level]}</span>
						</label>
					{/each}
				</div>
			</fieldset>

			<Input
				label="Mood"
				name="mood"
				value={data.entry?.mood ?? ''}
				maxlength={100}
				placeholder="A word or two"
				autocomplete="off"
			/>
			<Input
				label="Highlight"
				name="highlight"
				value={data.entry?.highlight ?? ''}
				placeholder="The best bit"
				autocomplete="off"
			/>
			<Textarea
				label="Grateful for"
				name="gratitude"
				rows={2}
				value={data.entry?.gratitude ?? ''}
			/>
			<Textarea
				label="Notes"
				name="note"
				rows={6}
				value={data.entry?.note ?? ''}
				placeholder="Anything worth keeping."
			/>

			<Button type="submit" variant="primary" full>
				{data.entry ? 'Save entry' : 'Write entry'}
			</Button>
		</form>
	</Card>

	<HealthTags date={data.date} tags={data.tags} result={form} />

	{#if data.images.length > 0}
		<Card title="From this day" subtitle="Imported with the page">
			<ul class="images">
				{#each data.images as image (image.id)}
					<li>
						<img
							src={resolve(appPath(`/api/media/${image.id}`))}
							alt={image.alt}
							width={image.width ?? undefined}
							height={image.height ?? undefined}
							loading="lazy"
							decoding="async"
						/>
					</li>
				{/each}
			</ul>
		</Card>
	{/if}

	<Card title="Go to a day">
		<form method="POST" action="?/go" class="jump" use:enhance>
			<Input label="Date" name="date" type="date" value={data.date} max={data.today} required />
			<Button type="submit">Open</Button>
		</form>
	</Card>

	<Card title="Earlier entries" subtitle="Only your own" flush>
		{#if data.history.length === 0}
			<EmptyState
				title="Nothing written yet"
				description="Days you write about will collect here."
				icon="journal"
			/>
		{:else}
			<List label="Journal history">
				{#each data.history as item (item.id)}
					<ListRow
						title={relative(item.date) || shortDate(item.date)}
						meta={item.summary}
						href={`/journal/${item.date}`}
					>
						{#snippet trail()}
							{#if item.date === data.date}<Badge tone="accent">Open</Badge>{/if}
						{/snippet}
					</ListRow>
				{/each}
			</List>
		{/if}
	</Card>
</div>

<style>
	/*
	 * Notion page images, at whatever size they arrived. Intrinsic width and
	 * height are set on the element from the stored dimensions so the page does
	 * not jump as they load; the rule below keeps them inside the card.
	 */
	.images {
		display: grid;
		gap: 0.75rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.images img {
		display: block;
		width: 100%;
		height: auto;
		border-radius: 0.5rem;
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
	.notice.ok {
		color: var(--c-ok);
		border: 1px solid color-mix(in srgb, var(--c-ok) 25%, transparent);
		background: color-mix(in srgb, var(--c-ok) 8%, transparent);
	}

	/* Previous / Today / Next, spread to the edges so both thumbs-reachable
	   corners carry a step and the middle stays the anchor. */
	.days {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--sp-2);
		margin-bottom: var(--sp-4);
	}
	.step {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-1);
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
	.step.current {
		background: var(--c-accent-soft);
		border-color: var(--c-accent);
		color: var(--c-accent);
		font-weight: 600;
	}
	/* Holds the row's shape when there is no next day, so Today does not jump
	   sideways as you step back and forward. */
	.step.spacer {
		border-color: transparent;
		background: none;
		width: 6.5rem;
	}

	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}

	.edit {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}

	.energy {
		margin: 0;
		padding: 0;
		border: 0;
	}
	.energy legend {
		padding: 0;
		margin-bottom: var(--sp-1);
		font-size: var(--fs-sm);
		font-weight: 600;
		color: var(--c-text-muted);
	}
	/* Six one-tap targets rather than a picker: choosing a number should not
	   cost a wheel spin and a confirm on a phone. */
	.scale {
		display: flex;
		gap: var(--sp-2);
	}
	.level {
		position: relative;
		flex: 1 1 0;
		display: flex;
		cursor: pointer;
	}
	/*
	 * The radio keeps the full size of the chip it draws and is merely
	 * transparent over it. Collapsing it to 0×0 — the usual trick — takes the
	 * control out of reach of anything that drives the page by hit-testing,
	 * automation included, and leaves the chip as the only real target.
	 */
	.level input {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		min-height: 0;
		margin: 0;
		opacity: 0;
		cursor: pointer;
	}
	.pip {
		display: flex;
		flex: 1 1 auto;
		align-items: center;
		justify-content: center;
		min-width: var(--tap);
		min-height: var(--tap);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-sm);
		background: var(--c-surface);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		color: var(--c-text-muted);
	}
	.level input:checked + .pip {
		background: var(--c-accent-soft);
		border-color: var(--c-accent);
		color: var(--c-accent);
	}
	/* The input is transparent, so the ring has to be drawn on what is not. */
	.level input:focus-visible + .pip {
		outline: 2px solid var(--c-accent);
		outline-offset: 2px;
	}

	.jump {
		display: flex;
		gap: var(--sp-3);
		align-items: flex-end;
	}
	.jump :global(.field) {
		flex: 1;
	}
</style>
