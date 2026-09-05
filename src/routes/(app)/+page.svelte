<script lang="ts">
	import { enhance } from '$app/forms';
	import Badge from '$lib/components/Badge.svelte';
	import Button from '$lib/components/Button.svelte';
	import Card from '$lib/components/Card.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import List from '$lib/components/List.svelte';
	import ListRow from '$lib/components/ListRow.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';

	let { data, form } = $props();

	/**
	 * Today, from live derived queries.
	 *
	 * The date comes from the server as a plain `YYYY-MM-DD` in the household's
	 * timezone. Deriving it here from `new Date()` would give the browser's day,
	 * which is a different day for anyone up late — and would disagree with the
	 * dates the queries were run against.
	 */
	const longDate = $derived(
		new Date(`${data.today}T12:00:00`).toLocaleDateString(undefined, {
			weekday: 'long',
			day: 'numeric',
			month: 'long'
		})
	);

	// Midday avoids any chance of a DST shift moving the label a day.
	const dayAt = (key: string) => new Date(`${key}T12:00:00`);

	const week = $derived(
		Array.from({ length: 7 }, (_, i) => {
			const start = dayAt(data.week.start);
			const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
			const pad = (n: number) => String(n).padStart(2, '0');
			const key = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
			return {
				key,
				weekday: date.toLocaleDateString(undefined, { weekday: 'short' }),
				day: date.getDate(),
				isToday: key === data.today
			};
		})
	);

	const openToday = $derived(data.dueToday.filter((t) => t.status !== 'done').length);
	const habitsDone = $derived(data.habits.filter((h) => h.doneToday).length);
	const isDone = (status: string) => status === 'done' || status === 'dropped';

	/** A due date as a person reads it. */
	function due(task: { doOn: string | null; deadlineOn: string | null }): string {
		const day = task.doOn ?? task.deadlineOn;
		if (!day) return '';
		if (day === data.today) return 'Today';
		const delta = Math.round(
			(Date.parse(`${day}T00:00:00Z`) - Date.parse(`${data.today}T00:00:00Z`)) / 86_400_000
		);
		if (delta === -1) return 'Yesterday';
		if (delta < 0) return `${Math.abs(delta)} days ago`;
		if (delta === 1) return 'Tomorrow';
		return `in ${delta} days`;
	}
</script>

<svelte:head><title>Today · LifeOS</title></svelte:head>

<PageHeader title="Today" description={longDate}>
	{#snippet meta()}
		<Badge tone={openToday > 0 ? 'accent' : 'ok'} dot>
			{openToday} task{openToday === 1 ? '' : 's'} left
		</Badge>
		{#if data.habits.length > 0}
			<Badge tone={habitsDone === data.habits.length ? 'ok' : 'neutral'} dot>
				{habitsDone}/{data.habits.length} habits
			</Badge>
		{/if}
	{/snippet}
</PageHeader>

{#if form?.error}
	<p class="notice" role="alert">{form.error}</p>
{/if}

<!-- Seven day chips exceed a narrow phone; the strip scrolls, the page does not.
     These are labels rather than links until the journal route exists (UI-009);
     a chip that navigates to a 404 is worse than one that does nothing. -->
<div class="scroll-x week-strip">
	<ul class="week">
		{#each week as day (day.key)}
			<li>
				<span class="day" class:is-today={day.isToday}>
					<span class="weekday">{day.weekday}</span>
					<span class="date numeric">{day.day}</span>
				</span>
			</li>
		{/each}
	</ul>
</div>

<div class="stack">
	<Card title="Due today" subtitle="What the day actually asks of you" flush>
		{#snippet actions()}
			<Button size="sm" href="/tasks">All tasks</Button>
		{/snippet}

		{#if data.dueToday.length === 0}
			<EmptyState
				title="Nothing due today"
				description="Anything you schedule for today will appear here."
				icon="check"
			/>
		{:else}
			<List label="Tasks due today">
				{#each data.dueToday as task (task.id)}
					<ListRow
						title={task.title}
						meta={due(task)}
						href="/tasks/{task.id}"
						muted={isDone(task.status)}
					>
						{#snippet lead()}
							<form method="POST" action="?/toggleTask" use:enhance>
								<input type="hidden" name="id" value={task.id} />
								<input type="hidden" name="updatedAt" value={task.updatedAt} />
								<input type="hidden" name="done" value={isDone(task.status) ? 'false' : 'true'} />
								<button
									class="tick"
									type="submit"
									aria-pressed={isDone(task.status)}
									aria-label={isDone(task.status)
										? `Reopen ${task.title}`
										: `Complete ${task.title}`}>{isDone(task.status) ? '✓' : ''}</button
								>
							</form>
						{/snippet}
						{#snippet trail()}
							{#if task.isImportant && !isDone(task.status)}
								<Badge tone="warn">Important</Badge>
							{/if}
						{/snippet}
					</ListRow>
				{/each}
			</List>
		{/if}
	</Card>

	<Card title="Habits" subtitle="Tick them off as you go" flush>
		{#if data.habits.length === 0}
			<EmptyState title="No habits yet" description="Habits you track will show up here." />
		{:else}
			<List label="Habits for today">
				{#each data.habits as habit (habit.id)}
					<ListRow title={habit.name}>
						{#snippet lead()}
							<form method="POST" action="?/toggleHabit" use:enhance>
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
							<Badge tone={habit.doneToday ? 'ok' : 'neutral'}>
								{habit.streak} day{habit.streak === 1 ? '' : 's'}
							</Badge>
						{/snippet}
					</ListRow>
				{/each}
			</List>
		{/if}
	</Card>

	<Card title="Overdue" flush>
		{#if data.overdue.length === 0}
			<EmptyState
				title="Nothing is overdue"
				description="Anything you miss will show up here the next morning."
				icon="check"
			/>
		{:else}
			<List label="Overdue tasks">
				{#each data.overdue as task (task.id)}
					<ListRow title={task.title} meta={due(task)} href="/tasks/{task.id}">
						{#snippet trail()}<Badge tone="crit">Overdue</Badge>{/snippet}
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

	.week-strip {
		margin-bottom: var(--sp-5);
		/* Room for the focus ring of the first and last chip, which the
		   scroll container would otherwise clip. */
		padding: 3px;
	}

	.week {
		display: flex;
		gap: var(--sp-1);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	/*
	 * Sized so all seven chips fit a 390px phone without scrolling: today is
	 * the last of them, and a strip that opens with today off the right edge
	 * asks for a swipe before the page can even be read. Narrower phones do
	 * scroll, which is what the .scroll-x wrapper is for.
	 */
	.day {
		display: flex;
		flex: 0 0 auto;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2px;
		min-width: var(--tap);
		min-height: 3.4rem;
		padding: 0 var(--sp-1);
		border: 1px solid var(--c-border);
		border-radius: var(--radius);
		background: var(--c-surface);
		color: var(--c-text-muted);
		text-decoration: none;
	}
	.day:hover {
		border-color: var(--c-accent);
	}

	.weekday {
		font-size: var(--fs-xs);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.date {
		font-size: var(--fs-lg);
		font-weight: 650;
		color: var(--c-text);
	}

	.is-today {
		border-color: var(--c-accent);
		background: var(--c-accent-soft);
	}
	.is-today .date,
	.is-today .weekday {
		color: var(--c-accent);
	}
</style>
