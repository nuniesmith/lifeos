<script lang="ts">
	import { enhance } from '$app/forms';
	import {
		Badge,
		Button,
		Card,
		Input,
		List,
		ListRow,
		PageHeader,
		Select,
		Textarea
	} from '$lib/components';

	let { data, form } = $props();

	const PERIODS = [
		{ value: 'day', label: 'Per day' },
		{ value: 'week', label: 'Per week' },
		{ value: 'month', label: 'Per month' }
	];

	const PER: Record<string, string> = {
		day: 'a day',
		week: 'a week',
		month: 'a month'
	};

	/** Midday, so no timezone can pull a label onto the day before. */
	const at = (day: string) => new Date(`${day}T12:00:00`);

	const dayName = (day: string) =>
		at(day).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

	const dayNumber = (day: string) => Number(day.slice(8, 10));

	/** The heading row of the grid, taken from the grid's own first week. */
	const weekdays = $derived(
		data.days
			.slice(0, 7)
			.map((day) => at(day.date).toLocaleDateString(undefined, { weekday: 'narrow' }))
	);

	/** A period's identity, said the way the period is spoken about. */
	function periodName(key: string): string {
		if (data.habit.targetPeriod === 'month') {
			return at(key).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
		}
		if (data.habit.targetPeriod === 'week') {
			return `Week of ${at(key).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
		}
		return dayName(key);
	}

	const paused = $derived(!data.habit.active);
	const rate = $derived(Math.round(data.progress.completionRate * 100));
	const target = $derived(
		`${data.habit.targetCount}× ${PER[data.habit.targetPeriod] ?? data.habit.targetPeriod}`
	);

	// Oldest first reads as history; the current period is the one at the end.
	const periods = $derived([...data.progress.periods].reverse());
</script>

<svelte:head><title>{data.habit.name} · LifeOS</title></svelte:head>

<PageHeader title={data.habit.name} back={{ href: '/habits', label: 'Habits' }}>
	{#snippet meta()}
		{#if paused}<Badge tone="neutral">Paused</Badge>{/if}
		<Badge tone="accent">{target}</Badge>
		{#if data.habit.description}<span>{data.habit.description}</span>{/if}
	{/snippet}
</PageHeader>

{#if form?.error}
	<p class="notice error" role="alert">{form.error}</p>
{:else if form?.saved}
	<p class="notice ok" role="status">Saved.</p>
{/if}

<div class="stack">
	<Card title="Progress">
		<dl class="stats">
			<div>
				<dt>This {data.habit.targetPeriod}</dt>
				<dd class="numeric">
					{data.progress.current.completed}<span class="unit"
						>of {data.progress.current.target}</span
					>
				</dd>
			</div>
			<div>
				<dt>Completed</dt>
				<dd class="numeric">{rate}<span class="unit">%</span></dd>
			</div>
		</dl>
		<!-- Opportunity-based, not a streak (Kayla's own framing): what shows is
		     when the habit was last logged, and — only once a whole period has
		     actually gone by with nothing logged — a gentle nudge, never a
		     broken-streak number. -->
		<p class="last-logged">
			{data.progress.lastLoggedOn
				? `Last logged ${dayName(data.progress.lastLoggedOn)}`
				: 'Not logged yet'}
		</p>
		{#if data.progress.planTheReturn}
			<p class="plan-the-return">
				Plan the return. Missing once is normal. The important behaviour is returning.
			</p>
		{/if}
	</Card>

	<!-- The grid starts on a Monday, so it runs four whole weeks plus however
	     much of this one has happened: between 28 and 34 days, never a fixed
	     "four weeks" the title could promise and then not show. -->
	<Card title="Check-ins" subtitle="The last few weeks. Tap any day to correct it." flush>
		<div class="grid-pad">
			<div class="weekdays" aria-hidden="true">
				{#each weekdays as label, i (i)}
					<span>{label}</span>
				{/each}
			</div>
			<div class="grid">
				{#each data.days as day (day.date)}
					<!-- Every cell is its own form: a check-in carries no version,
					     so there is nothing to keep in step across the grid. -->
					<form method="POST" action="?/toggle" use:enhance>
						<input type="hidden" name="id" value={data.habit.id} />
						<input type="hidden" name="day" value={day.date} />
						<input type="hidden" name="done" value={day.done ? 'false' : 'true'} />
						<button
							class="cell"
							class:done={day.done}
							class:is-today={day.isToday}
							type="submit"
							aria-pressed={day.done}
							aria-label={`${dayName(day.date)}${day.done ? ', done' : ', not done'}`}
						>
							{dayNumber(day.date)}
						</button>
					</form>
				{/each}
			</div>
		</div>
	</Card>

	{#if data.habit.targetPeriod !== 'day'}
		<Card title="Against the target" flush>
			<List label="Progress by period">
				{#each periods as period (period.key)}
					<ListRow title={periodName(period.key)} meta={`${period.completed} of ${period.target}`}>
						{#snippet trail()}
							<Badge tone={period.met ? 'ok' : 'neutral'}>{period.met ? 'Met' : 'Short'}</Badge>
						{/snippet}
					</ListRow>
				{/each}
			</List>
		</Card>
	{/if}

	<Card title="Details">
		<form method="POST" action="?/save" class="edit" use:enhance>
			<!-- The version this form was rendered from, so a save from a stale
			     tab is refused rather than overwriting silently. -->
			<input type="hidden" name="updatedAt" value={data.habit.updatedAt} />

			<Input label="Name" name="name" value={data.habit.name} required />
			<Textarea
				label="Description"
				name="description"
				rows={2}
				value={data.habit.description ?? ''}
			/>
			<div class="target">
				<Input
					label="How many"
					name="targetCount"
					type="number"
					value={String(data.habit.targetCount)}
					min={1}
					max={99}
				/>
				<Select
					label="How often"
					name="targetPeriod"
					options={PERIODS}
					value={data.habit.targetPeriod}
				/>
			</div>
			<Select
				label="Life area"
				name="areaId"
				options={data.areas}
				value={data.habit.areaId ?? ''}
				placeholder="No area"
			/>
			<Button type="submit" variant="primary" full>Save habit</Button>
		</form>
	</Card>

	<Card title={paused ? 'Resume' : 'Pause'}>
		<p class="muted">
			{paused
				? 'This habit is paused. Resuming puts it back on today’s list; every past check-in is still there.'
				: 'Pausing takes this off today’s list without losing a single check-in.'}
		</p>
		<form method="POST" action="?/setActive" use:enhance>
			<input type="hidden" name="updatedAt" value={data.habit.updatedAt} />
			<input type="hidden" name="active" value={paused ? 'true' : 'false'} />
			<Button type="submit" variant={paused ? 'primary' : 'ghost'}>
				{paused ? 'Resume habit' : 'Pause habit'}
			</Button>
		</form>
	</Card>
</div>

<style>
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

	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}

	.stats {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: var(--sp-3);
		margin: 0;
	}
	.stats dt {
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.stats dd {
		margin: var(--sp-1) 0 0;
		font-size: var(--fs-xl);
		font-weight: 650;
	}
	.unit {
		font-size: var(--fs-sm);
		font-weight: 500;
		color: var(--c-text-muted);
	}
	.last-logged {
		margin: var(--sp-3) 0 0;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}
	.plan-the-return {
		margin: var(--sp-2) 0 0;
		padding: var(--sp-2) var(--sp-3);
		border-radius: var(--radius-sm);
		background: var(--c-accent-soft);
		color: var(--c-accent);
		font-size: var(--fs-sm);
	}

	/* A flush card so the grid can use the full width: seven 44px targets plus
	   their gaps do not fit inside the usual body padding on a 390px phone. */
	.grid-pad {
		padding: var(--sp-3);
	}
	.weekdays,
	.grid {
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
		gap: var(--sp-1);
	}
	.weekdays {
		margin-bottom: var(--sp-1);
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
		text-align: center;
	}
	.cell {
		display: flex;
		width: 100%;
		align-items: center;
		justify-content: center;
		min-height: var(--tap);
		padding: 0;
		border: 1px solid var(--c-border);
		border-radius: var(--radius-sm);
		background: var(--c-surface);
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
		font-variant-numeric: tabular-nums;
		cursor: pointer;
	}
	.cell.done {
		background: color-mix(in srgb, var(--c-ok) 16%, transparent);
		border-color: color-mix(in srgb, var(--c-ok) 45%, transparent);
		color: var(--c-ok);
		font-weight: 650;
	}
	.cell.is-today {
		border-color: var(--c-accent);
		border-width: 2px;
	}

	.edit {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}
	.target {
		display: grid;
		grid-template-columns: 6.5rem 1fr;
		gap: var(--sp-3);
	}

	.muted {
		margin: 0 0 var(--sp-3);
		color: var(--c-text-muted);
	}
</style>
