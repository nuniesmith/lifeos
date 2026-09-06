<script lang="ts">
	import { resolve } from '$app/paths';
	import Icon from '$lib/components/Icon.svelte';
	import { appPath } from '$lib/components/nav';

	interface CalendarTask {
		id: string;
		title: string;
		doOn: string | null;
		deadlineOn: string | null;
		status: string;
	}

	interface CalendarDate {
		id: string;
		name: string;
		day: string;
	}

	interface Props {
		today: string;
		tasks: CalendarTask[];
		dates?: CalendarDate[];
	}

	let { today, tasks, dates = [] }: Props = $props();
	let monthOffset = $state(0);
	const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
	const pad = (value: number) => String(value).padStart(2, '0');
	const dateKey = (date: Date) =>
		`${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

	// Calendar arithmetic stays in UTC; `today` already reflects household time.
	const month = $derived.by(() => {
		const year = Number(today.slice(0, 4));
		const monthNumber = Number(today.slice(5, 7));
		return new Date(Date.UTC(year, monthNumber - 1 + monthOffset, 1));
	});
	const monthLabel = $derived(
		month.toLocaleDateString('en-CA', { month: 'long', year: 'numeric', timeZone: 'UTC' })
	);
	const weeks = $derived.by(() => {
		const year = month.getUTCFullYear();
		const monthNumber = month.getUTCMonth();
		const precedingDays = (month.getUTCDay() + 6) % 7;
		const daysInMonth = new Date(Date.UTC(year, monthNumber + 1, 0)).getUTCDate();
		const weekCount = Math.ceil((precedingDays + daysInMonth) / 7);

		return Array.from({ length: weekCount }, (_, week) =>
			Array.from({ length: 7 }, (_, weekday) => {
				const date = new Date(Date.UTC(year, monthNumber, week * 7 + weekday - precedingDays + 1));
				const key = dateKey(date);
				return {
					key,
					number: date.getUTCDate(),
					outside: date.getUTCMonth() !== monthNumber,
					label: date.toLocaleDateString('en-CA', {
						weekday: 'long',
						month: 'long',
						day: 'numeric',
						year: 'numeric',
						timeZone: 'UTC'
					}),
					tasks: tasks.filter(
						(task) => task.status !== 'dropped' && (task.doOn === key || task.deadlineOn === key)
					),
					dates: dates.filter((event) => event.day === key)
				};
			})
		);
	});
</script>

<section class="calendar" aria-label="Monthly calendar">
	<header class="calendar-header">
		<div class="calendar-heading">
			<span class="section-label"><Icon name="today" size={15} /> Calendar</span>
			<h2 aria-live="polite">{monthLabel}</h2>
		</div>
		<div class="month-controls" aria-label="Calendar navigation">
			<button class="today-button" type="button" onclick={() => (monthOffset = 0)}>Today</button>
			<button type="button" aria-label="Previous month" onclick={() => (monthOffset -= 1)}>
				<span class="previous"><Icon name="chevron" size={16} /></span>
			</button>
			<button type="button" aria-label="Next month" onclick={() => (monthOffset += 1)}>
				<Icon name="chevron" size={16} />
			</button>
		</div>
	</header>

	<table>
		<caption class="sr-only">{monthLabel}: scheduled tasks and important dates</caption>
		<thead>
			<tr>
				{#each weekdays as weekday (weekday)}
					<th scope="col">{weekday}</th>
				{/each}
			</tr>
		</thead>
		<tbody>
			{#each weeks as week, index (index)}
				<tr>
					{#each week as day (day.key)}
						<td class:outside={day.outside} class:current-day={day.key === today}>
							<a
								class="day-link"
								href={resolve(appPath(`/journal/${day.key}`))}
								aria-label={`Open journal for ${day.label}`}
								aria-current={day.key === today ? 'date' : undefined}><span>{day.number}</span></a
							>
							<div class="events">
								{#each day.dates as event (event.id)}
									<a
										class="event important-date"
										href={resolve(appPath(`/journal/${day.key}`))}
										title={event.name}><span class="event-dot"></span>{event.name}</a
									>
								{/each}
								{#each day.tasks as task (task.id)}
									<a
										class="event task"
										class:completed={task.status === 'done'}
										href={resolve(appPath(`/tasks/${task.id}`))}
										title={task.title}><span class="event-dot"></span>{task.title}</a
									>
								{/each}
							</div>
						</td>
					{/each}
				</tr>
			{/each}
		</tbody>
	</table>
	<footer>
		<span><i class="legend-dot task-dot"></i> Tasks</span>
		<span><i class="legend-dot date-dot"></i> Important dates</span>
		<a href={resolve(appPath('/journal'))}>Open journal <span aria-hidden="true">↗</span></a>
	</footer>
</section>

<style>
	.calendar {
		min-width: 0;
		overflow: hidden;
		border: 1px solid var(--c-border);
		border-radius: var(--radius);
		background: var(--c-surface);
	}

	.calendar-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 1.2rem 1.15rem 0.7rem;
	}

	.section-label {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		margin-bottom: 0.6rem;
		color: var(--c-text-muted);
		font-size: 0.65rem;
		font-weight: 600;
		letter-spacing: 0.14em;
		text-transform: uppercase;
	}

	h2 {
		margin: 0;
		font-size: 1rem;
		font-weight: 550;
	}

	.month-controls {
		display: flex;
		align-items: center;
		gap: 0.1rem;
	}

	button {
		display: inline-flex;
		min-width: 2.75rem;
		align-items: center;
		justify-content: center;
		padding: 0.25rem;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--c-text-muted);
		cursor: pointer;
	}

	button:hover {
		background: var(--c-surface-alt);
		color: var(--c-text);
	}

	.today-button {
		padding-inline: 0.6rem;
		font-size: 0.73rem;
	}

	.previous {
		transform: rotate(180deg);
	}

	table {
		width: 100%;
		table-layout: fixed;
	}

	th {
		padding: 0.75rem 0.2rem;
		color: var(--c-text-muted);
		font-size: 0.65rem;
		font-weight: 500;
		text-align: center;
	}

	td {
		height: 6.5rem;
		padding: 0.25rem 0.3rem 0.45rem;
		border-top: 1px solid var(--c-border);
		border-right: 1px solid var(--c-border);
		vertical-align: top;
	}

	td:last-child {
		border-right: 0;
	}

	.outside {
		background: color-mix(in srgb, var(--c-surface-alt) 38%, transparent);
	}

	.outside .day-link {
		color: var(--c-text-muted);
		opacity: 0.6;
	}

	.current-day {
		background: color-mix(in srgb, var(--c-accent-soft) 32%, var(--c-surface));
	}

	.day-link {
		display: flex;
		width: 100%;
		min-height: 2.75rem;
		align-items: center;
		justify-content: center;
		color: var(--c-text);
		font-size: 0.76rem;
		text-decoration: none;
		font-variant-numeric: tabular-nums;
	}

	.day-link span {
		display: grid;
		width: 1.65rem;
		height: 1.65rem;
		place-items: center;
		border-radius: 50%;
	}

	.day-link[aria-current='date'] span {
		background: var(--c-accent);
		color: var(--c-accent-text);
		font-weight: 650;
	}

	.day-link:hover span {
		box-shadow: 0 0 0 1px var(--c-accent);
	}

	.events {
		display: grid;
		gap: 0.25rem;
	}

	.event {
		display: block;
		overflow: hidden;
		padding: 0.22rem 0.25rem;
		border-radius: 3px;
		background: var(--c-accent-soft);
		color: var(--c-text);
		font-size: 0.62rem;
		line-height: 1.4;
		text-overflow: ellipsis;
		text-decoration: none;
		white-space: nowrap;
	}

	.event:hover {
		text-decoration: underline;
	}

	.event-dot,
	.legend-dot {
		display: inline-block;
		width: 0.3rem;
		height: 0.3rem;
		border-radius: 50%;
		background: var(--c-accent);
	}

	.event-dot {
		margin-right: 0.25rem;
		vertical-align: 0.08rem;
	}

	.important-date {
		background: color-mix(in srgb, var(--c-warn) 12%, var(--c-surface));
	}

	.important-date .event-dot,
	.date-dot {
		background: var(--c-warn);
	}

	.completed {
		opacity: 0.65;
		text-decoration: line-through;
	}

	footer {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.7rem;
		padding: 0.65rem 1rem;
		border-top: 1px solid var(--c-border);
		color: var(--c-text-muted);
		font-size: 0.65rem;
	}

	footer > span {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}

	footer > a {
		margin-left: auto;
		color: inherit;
		text-decoration: none;
	}

	footer > a:hover {
		text-decoration: underline;
	}

	@media (max-width: 36rem) {
		.calendar-header {
			padding-inline: 0.75rem;
		}

		td {
			height: 5.6rem;
			padding-inline: 0.1rem;
		}

		.event {
			padding-inline: 0.12rem;
			font-size: 0.57rem;
		}

		.event-dot {
			display: none;
		}
	}
</style>
