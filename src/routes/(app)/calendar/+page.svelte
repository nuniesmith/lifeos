<script lang="ts">
	import { resolve } from '$app/paths';
	import HomeCalendar from '$lib/components/home/HomeCalendar.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { appPath } from '$lib/components/nav';

	let { data } = $props();
</script>

<svelte:head>
	<title>Calendar · LifeOS</title>
	<meta name="description" content="A household calendar for tasks and important dates." />
</svelte:head>

<PageHeader
	title="Calendar"
	description="See the shape of the month without losing the little things."
/>

<HomeCalendar today={data.today} month={data.month} tasks={data.tasks} dates={data.dates} />

<div class="calendar-notes">
	<p>
		Showing scheduled tasks and important dates for the month. Day numbers open the matching journal
		entry.
	</p>
	{#if data.calendarTruncated}
		<p class="warning" role="status">
			This month has more than 500 scheduled tasks, so the calendar is showing the first 500 by
			date.
			<a href={resolve(appPath('/tasks'))}>Open Tasks ↗</a>
		</p>
	{/if}
</div>

<style>
	.calendar-notes {
		display: grid;
		gap: var(--sp-2);
		margin-top: var(--sp-4);
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}
	.calendar-notes p {
		margin: 0;
	}
	.warning {
		padding: var(--sp-3);
		border: 1px solid color-mix(in srgb, var(--c-warn) 55%, var(--c-border));
		border-radius: var(--radius-sm);
		color: var(--c-warn);
	}
	.warning a {
		color: inherit;
	}
</style>
