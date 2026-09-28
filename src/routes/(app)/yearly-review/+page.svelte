<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import {
		Badge,
		Button,
		Card,
		Checkbox,
		EmptyState,
		Input,
		List,
		ListRow,
		PageHeader,
		Sheet,
		Textarea,
		appPath
	} from '$lib/components';

	let { data, form } = $props();

	type EventRow = (typeof data.events)[number];

	const stats = $derived([
		{ label: 'Days logged', value: data.review.daysLogged },
		{ label: 'Habits logged', value: data.review.habitsLogged },
		{ label: 'Goals achieved', value: data.review.goalsAchieved },
		{ label: 'Tasks completed', value: data.review.tasksCompleted },
		{ label: 'Projects finished', value: data.review.projectsCompleted },
		{ label: 'Moments kept', value: data.review.events }
	]);

	let editingEvent = $state<EventRow | null>(null);
	let eventSheetOpen = $state(false);
	// `Checkbox` has no `name` of its own (unlike Input/Select, it does not
	// spread HTML attributes) — see health/medications/+page.svelte's
	// `fRunningLow` for the same shape — so its checked state is mirrored into
	// a hidden input for the form to submit, and needs its own bound state
	// rather than reading `editingEvent.isFavourite` directly. The area select
	// is bound for the same reason a plain `value` was not trusted to pick the
	// right `<option>` on a native, unbound `<select>` — nothing else in this
	// codebase relies on that, so this does not either.
	let editFavourite = $state(false);
	let editAreaId = $state('');

	function startEditEvent(event: EventRow) {
		editingEvent = event;
		editFavourite = event.isFavourite;
		editAreaId = event.areaId ?? '';
		eventSheetOpen = true;
	}
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
									{#if event.isFavourite}<Badge tone="accent">Favourite</Badge>{/if}
									{#if event.areaName}<Badge tone="neutral">{event.areaName}</Badge>{/if}
									<Button size="sm" variant="ghost" onclick={() => startEditEvent(event)}>
										Edit
									</Button>
								{/snippet}
							</ListRow>
						{/each}
					</List>
				{/if}
			</Card>
		</div>

		{#if data.archivedEvents.length > 0}
			<div class="spaced">
				<h3 class="subsection-title">Archived events</h3>
				<Card flush>
					<List label="Archived events">
						{#each data.archivedEvents as event (event.id)}
							<ListRow title={event.title} meta={event.onDate} muted>
								{#snippet trail()}
									<form method="POST" action="?/archiveEvent" use:enhance>
										<input type="hidden" name="id" value={event.id} />
										<input type="hidden" name="archived" value="false" />
										<Button type="submit" size="sm" aria-label={`Restore ${event.title}`}>
											Restore
										</Button>
									</form>
								{/snippet}
							</ListRow>
						{/each}
					</List>
				</Card>
			</div>
		{/if}
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

<Sheet bind:open={eventSheetOpen} title="Edit event">
	{#if editingEvent}
		{@const ev = editingEvent}
		<form
			method="POST"
			action="?/updateEvent"
			class="edit-form"
			use:enhance={() => {
				return async ({ result, update }) => {
					await update();
					if (result.type === 'success') eventSheetOpen = false;
				};
			}}
		>
			<input type="hidden" name="id" value={ev.id} />
			<input type="hidden" name="expectedUpdatedAt" value={ev.updatedAt.toISOString()} />

			{#if form?.action === 'updateEvent' && form.error}
				<p class="notice error" role="alert">{form.error}</p>
			{/if}

			<Input label="Something worth remembering" name="title" required value={ev.title} />
			<Input label="When" name="onDate" type="date" required value={ev.onDate} />
			<label class="who">
				<span class="label">Area</span>
				<select name="areaId" bind:value={editAreaId}>
					<option value="">No area</option>
					{#each data.areas as area (area.id)}<option value={area.id}>{area.name}</option>{/each}
				</select>
			</label>
			<Checkbox label="Favourite" bind:checked={editFavourite} />
			<input type="hidden" name="isFavourite" value={editFavourite ? 'on' : ''} />
			<Textarea label="Notes" name="notes" rows={3} value={ev.notes ?? ''} />

			<div class="actions">
				<Button variant="ghost" type="button" onclick={() => (eventSheetOpen = false)}>
					Cancel
				</Button>
				<Button type="submit" variant="primary">Save changes</Button>
			</div>
		</form>

		<form
			method="POST"
			action="?/archiveEvent"
			class="archive-form"
			use:enhance={() => {
				return async ({ update }) => {
					await update();
					eventSheetOpen = false;
				};
			}}
		>
			<input type="hidden" name="id" value={ev.id} />
			<input type="hidden" name="archived" value="true" />
			<Button type="submit" variant="danger" size="sm">Archive this event</Button>
		</form>
	{/if}
</Sheet>

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
	.subsection-title {
		margin: 0 0 var(--sp-3);
		font-size: var(--fs-base);
		font-weight: 620;
		color: var(--c-text-muted);
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
	.edit-form {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--sp-2);
	}
	.archive-form {
		margin-top: var(--sp-2);
		padding-top: var(--sp-4);
		border-top: 1px solid var(--c-border);
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
