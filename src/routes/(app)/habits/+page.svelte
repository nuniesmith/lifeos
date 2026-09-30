<script lang="ts">
	import { enhance } from '$app/forms';
	import {
		Badge,
		Button,
		Card,
		EmptyState,
		Input,
		List,
		ListRow,
		PageHeader,
		Select
	} from '$lib/components';

	let { data, form } = $props();

	const PERIODS = [
		{ value: 'day', label: 'Per day' },
		{ value: 'week', label: 'Per week' },
		{ value: 'month', label: 'Per month' }
	];

	const WHEN: Record<string, string> = {
		day: 'today',
		week: 'this week',
		month: 'this month'
	};

	type Row = (typeof data.active)[number];

	/**
	 * The progress line under a habit's name.
	 *
	 * A once-a-day habit says whether it is done, because a count of "1 of 1"
	 * is noise. Anything with a real target says how far through the period it
	 * is, which is the number the target was set for.
	 */
	function progress(habit: Row): string {
		if (habit.targetPeriod === 'day' && habit.targetCount === 1) {
			return habit.doneToday ? 'Done today' : 'Not yet today';
		}
		return `${habit.periodCompleted} of ${habit.targetCount} ${WHEN[habit.targetPeriod] ?? ''}`.trim();
	}

	const streakLabel = (habit: Row) =>
		`${habit.streak} ${habit.targetPeriod}${habit.streak === 1 ? '' : 's'}`;

	const doneCount = $derived(data.active.filter((habit) => habit.doneToday).length);
</script>

<svelte:head><title>Habits · LifeOS</title></svelte:head>

<PageHeader title="Habits" description="One tap each. The streak looks after itself.">
	{#snippet meta()}
		{#if data.active.length > 0}
			<Badge tone={doneCount === data.active.length ? 'ok' : 'neutral'} dot>
				{doneCount}/{data.active.length} done today
			</Badge>
		{/if}
	{/snippet}
</PageHeader>

{#if form?.error}
	<p class="notice error" role="alert">{form.error}</p>
{/if}

<div class="stack">
	<Card title="Today" flush>
		{#if data.active.length === 0}
			<EmptyState
				title="No habits yet"
				description="Add the first one below. One a day is plenty to start."
				icon="habits"
			/>
		{:else}
			<List label="Habits for today">
				{#each data.active as habit (habit.id)}
					<!-- Not `muted` when done: a habit that is ticked today is not
					     finished, and striking its name through says it is. -->
					<ListRow title={habit.name} meta={progress(habit)} href={`/habits/${habit.id}`}>
						{#snippet lead()}
							<!-- The one control that matters on this page: a 44px
							     target that toggles today, and nothing else. -->
							<form method="POST" action="?/toggle" use:enhance>
								<input type="hidden" name="id" value={habit.id} />
								<input type="hidden" name="day" value={data.today} />
								<input type="hidden" name="done" value={habit.doneToday ? 'false' : 'true'} />
								<button
									class="tick"
									type="submit"
									aria-pressed={habit.doneToday}
									aria-label={habit.doneToday ? `Undo ${habit.name}` : `Log ${habit.name}`}
									>{habit.doneToday ? '✓' : ''}</button
								>
							</form>
						{/snippet}
						{#snippet trail()}
							{#if habit.streak > 0}
								<Badge tone={habit.periodMet ? 'ok' : 'accent'}>{streakLabel(habit)}</Badge>
							{/if}
						{/snippet}
					</ListRow>
				{/each}
			</List>
		{/if}
	</Card>

	{#if data.paused.length > 0}
		<Card title="Paused" subtitle="Not counted, not deleted" flush>
			<List label="Paused habits">
				{#each data.paused as habit (habit.id)}
					<ListRow title={habit.name} href={`/habits/${habit.id}`} muted>
						{#snippet trail()}
							<form method="POST" action="?/resume" use:enhance>
								<input type="hidden" name="id" value={habit.id} />
								<input type="hidden" name="updatedAt" value={habit.updatedAt} />
								<Button type="submit" size="sm">Resume</Button>
							</form>
						{/snippet}
					</ListRow>
				{/each}
			</List>
		</Card>
	{/if}

	<Card title="Add a habit">
		<form method="POST" action="?/create" class="add" use:enhance>
			<Input label="Name" name="name" placeholder="Walk after dinner" required autocomplete="off" />
			<div class="target">
				<Input label="How many" name="targetCount" type="number" value="1" min={1} max={99} />
				<Select label="How often" name="targetPeriod" options={PERIODS} value="day" />
			</div>
			<Button type="submit" variant="primary" full>Add habit</Button>
		</form>
	</Card>

	<!-- The source's "Habits & Routines" is two databases; this is the other
	     one -- a step-by-step sequence rather than a single daily tick. -->
	<Card title="Routines">
		<p class="muted">Morning, evening, or any sequence of steps done at a time of day.</p>
		<Button href="/routines" size="sm" variant="ghost">Open</Button>
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

	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}

	.add {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}
	.muted {
		margin: 0 0 var(--sp-3);
		color: var(--c-text-muted);
	}
	/* Two short fields sit side by side even on a phone: "3" and "per week"
	   are one thought and splitting them over two rows reads as two. */
	.target {
		display: grid;
		grid-template-columns: 6.5rem 1fr;
		gap: var(--sp-3);
	}

	/* The row is a link to the habit; the tick sits above it and stays a
	   thumb-sized target without making every row that tall. */
	.tick {
		width: var(--tap);
		height: var(--tap);
		min-height: var(--tap);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-sm);
		background: var(--c-surface);
		cursor: pointer;
		font-size: var(--fs-lg);
		line-height: 1;
		color: var(--c-ok);
	}
</style>
