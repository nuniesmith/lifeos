<script lang="ts">
	import { resolve } from '$app/paths';
	import Badge from '$lib/components/Badge.svelte';
	import Button from '$lib/components/Button.svelte';
	import Card from '$lib/components/Card.svelte';
	import Checkbox from '$lib/components/Checkbox.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import List from '$lib/components/List.svelte';
	import ListRow from '$lib/components/ListRow.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Tag from '$lib/components/Tag.svelte';
	import Textarea from '$lib/components/Textarea.svelte';
	import { appPath } from '$lib/components/nav';

	/**
	 * Today — layout only.
	 *
	 * ─────────────────────────────────────────────────────────────────────
	 * EVERYTHING BELOW IS PLACEHOLDER DATA. UI-002 replaces it with derived
	 * queries loaded in a +page.server.ts that this file does not have yet;
	 * the data layer is another agent's ticket. Nothing here reads from the
	 * server, and the local $state exists only so the interactions can be
	 * felt on a real phone — a tick does not persist and is not meant to.
	 *
	 * What the data agent needs to supply, in the shape this page consumes:
	 *   tasks   { id, title, meta, priority: 'high'|'normal'|'low', tags[] }
	 *   habits  { id, name, streak, target }
	 *   counts  { dueToday, overdue, habitsDone }
	 * ─────────────────────────────────────────────────────────────────────
	 */

	const today = new Date();
	const longDate = today.toLocaleDateString(undefined, {
		weekday: 'long',
		day: 'numeric',
		month: 'long'
	});

	// The week strip. Wide on a small phone, so it scrolls inside itself.
	// Built by constructor arithmetic rather than setDate(): the constructor
	// normalises an out-of-range day for us, and never mutating a Date keeps
	// this clear of the reactivity trap that SvelteDate exists to solve.
	const week = Array.from({ length: 7 }, (_, i) => {
		const date = new Date(
			today.getFullYear(),
			today.getMonth(),
			today.getDate() - today.getDay() + i
		);
		const pad = (n: number) => String(n).padStart(2, '0');
		return {
			// A local calendar date, not toISOString(): that converts to UTC
			// first and hands back yesterday for anyone west of Greenwich in
			// the evening — exactly the household using this.
			key: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
			weekday: date.toLocaleDateString(undefined, { weekday: 'short' }),
			day: date.getDate(),
			isToday: date.toDateString() === today.toDateString()
		};
	});

	let tasks = $state([
		{
			id: 't1',
			title: 'Book the vet for Juno',
			meta: 'Health · due 4:00 pm',
			priority: 'high' as const,
			tags: ['pets', 'calls'],
			done: false
		},
		{
			id: 't2',
			title: 'Pay the hydro bill',
			meta: 'Money · due today',
			priority: 'normal' as const,
			tags: ['bills'],
			done: false
		},
		{
			id: 't3',
			title: 'Defrost the chicken for tomorrow',
			meta: 'Meals · due 6:00 pm',
			priority: 'low' as const,
			tags: [],
			done: true
		}
	]);

	let habits = $state([
		{ id: 'h1', name: 'Morning walk', streak: 12, done: true },
		{ id: 'h2', name: 'Vitamins', streak: 4, done: false },
		{ id: 'h3', name: 'Read 10 pages', streak: 31, done: false }
	]);

	let journal = $state('');

	const openTasks = $derived(tasks.filter((t) => !t.done).length);
	const habitsDone = $derived(habits.filter((h) => h.done).length);

	const priorityTone = { high: 'crit', normal: 'accent', low: 'neutral' } as const;
</script>

<svelte:head><title>Today · LifeOS</title></svelte:head>

<PageHeader title="Today" description={longDate}>
	{#snippet meta()}
		<Badge tone={openTasks > 0 ? 'accent' : 'ok'} dot>
			{openTasks} task{openTasks === 1 ? '' : 's'} left
		</Badge>
		<Badge tone={habitsDone === habits.length ? 'ok' : 'neutral'} dot>
			{habitsDone}/{habits.length} habits
		</Badge>
	{/snippet}
</PageHeader>

<!-- Seven day chips exceed a narrow phone; the strip scrolls, the page does not. -->
<div class="scroll-x week-strip">
	<ul class="week">
		{#each week as day (day.key)}
			<li>
				<a href={resolve(appPath(`/journal/${day.key}`))} class="day" class:is-today={day.isToday}>
					<span class="weekday">{day.weekday}</span>
					<span class="date numeric">{day.day}</span>
				</a>
			</li>
		{/each}
	</ul>
</div>

<div class="stack">
	<Card title="Due today" subtitle="What the day actually asks of you" flush>
		{#snippet actions()}
			<Button size="sm" href="/tasks">All tasks</Button>
		{/snippet}

		<List label="Tasks due today">
			{#each tasks as task (task.id)}
				<ListRow title={task.title} meta={task.meta} href="/tasks/{task.id}" muted={task.done}>
					{#snippet lead()}
						<Checkbox bind:checked={task.done} label="Complete: {task.title}" hideLabel />
					{/snippet}
					{#snippet trail()}
						{#if !task.done}
							<Badge tone={priorityTone[task.priority]}>{task.priority}</Badge>
						{/if}
					{/snippet}
					{#if task.tags.length > 0 && !task.done}
						{#each task.tags as tag (tag)}
							<Tag label={tag} href="/tasks?tag={tag}" />
						{/each}
					{/if}
				</ListRow>
			{/each}
		</List>
	</Card>

	<Card title="Habits" subtitle="Tick them off as you go" flush>
		<List label="Habits for today">
			{#each habits as habit (habit.id)}
				<ListRow title={habit.name} muted={false}>
					{#snippet lead()}
						<Checkbox bind:checked={habit.done} label="Log: {habit.name}" hideLabel />
					{/snippet}
					{#snippet trail()}
						<Badge tone={habit.done ? 'ok' : 'neutral'}>
							{habit.streak} day{habit.streak === 1 ? '' : 's'}
						</Badge>
					{/snippet}
				</ListRow>
			{/each}
		</List>
	</Card>

	<Card title="Overdue">
		<EmptyState
			title="Nothing is overdue"
			description="Anything you miss will show up here the next morning."
			icon="check"
		/>
	</Card>

	<Card title="Daily log" subtitle="A line or two is plenty">
		<Textarea
			label="How did today go?"
			bind:value={journal}
			rows={4}
			placeholder="Slept badly, walked anyway."
			hint="Saved to the daily log for {longDate}."
		/>
		<div class="log-actions">
			<Button variant="primary" disabled={!journal.trim()}>Save entry</Button>
		</div>
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

	.log-actions {
		display: flex;
		justify-content: flex-end;
		margin-top: var(--sp-3);
	}
</style>
