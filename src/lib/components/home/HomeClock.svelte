<script lang="ts">
	import { onMount } from 'svelte';

	interface Props {
		today: string;
		timezone?: string;
	}

	let { today, timezone = 'America/Toronto' }: Props = $props();
	let now = $state<Date | null>(null);

	const effectiveTimezone = $derived.by(() => {
		try {
			new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format();
			return timezone;
		} catch {
			return 'America/Toronto';
		}
	});
	const clock = $derived.by(() => {
		if (!now) return { hour: '––', minute: '––', period: '' };
		const parts = new Intl.DateTimeFormat('en-CA', {
			timeZone: effectiveTimezone,
			hour: '2-digit',
			minute: '2-digit',
			hour12: true
		}).formatToParts(now);
		const part = (name: Intl.DateTimeFormatPartTypes) =>
			parts.find((item) => item.type === name)?.value ?? '';
		return {
			hour: part('hour').padStart(2, '0'),
			minute: part('minute'),
			period: part('dayPeriod')
		};
	});
	const dateLabel = $derived(
		new Intl.DateTimeFormat('en-CA', {
			timeZone: now ? effectiveTimezone : 'UTC',
			weekday: 'long',
			month: 'long',
			day: 'numeric'
		}).format(now ?? new Date(`${today}T12:00:00Z`))
	);
	const city = $derived(effectiveTimezone.split('/').at(-1)?.replaceAll('_', ' ') ?? 'Local time');

	onMount(() => {
		now = new Date();
		const interval = window.setInterval(() => (now = new Date()), 1_000);
		return () => window.clearInterval(interval);
	});
</script>

<section class="clock-panel" aria-label={`Clock: ${effectiveTimezone}`}>
	<div class="clock-heading"><span class="clock-dot"></span> A moment for today</div>
	<p class="date-label">{dateLabel}</p>
	<time
		class="clock"
		datetime={now?.toISOString() ?? today}
		aria-label={now
			? `${clock.hour}:${clock.minute} ${clock.period}, ${dateLabel}, ${effectiveTimezone}`
			: dateLabel}
	>
		<span class="flip" aria-hidden="true">{clock.hour}</span>
		<span class="separator" aria-hidden="true">:</span>
		<span class="flip" aria-hidden="true">{clock.minute}</span>
	</time>
	<div class="clock-footer">
		<span>{city}</span>
		<span class="period">{clock.period || 'Local time'}</span>
	</div>
</section>

<style>
	.clock-panel {
		--clock-paper: #f4f1eb;
		--clock-ink: #37323d;
		--clock-lavender: #e4deed;
		min-width: 0;
		padding: 1.4rem 1.35rem 1.1rem;
		border: 1px solid #e7e1d8;
		border-radius: var(--radius);
		background: var(--clock-paper);
		color: var(--clock-ink);
	}

	.clock-heading {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.45rem;
		font-size: 0.58rem;
		font-weight: 600;
		letter-spacing: 0.16em;
		text-transform: uppercase;
	}

	.clock-dot {
		width: 0.32rem;
		height: 0.32rem;
		border-radius: 50%;
		background: #82718e;
	}

	.date-label {
		margin: 0.6rem 0 1.1rem;
		color: #68606b;
		font-size: 0.72rem;
		text-align: center;
	}

	.clock {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 0.9rem minmax(0, 1fr);
		align-items: center;
		gap: 0.3rem;
		max-width: 20rem;
		margin-inline: auto;
	}

	.flip {
		position: relative;
		display: grid;
		min-width: 0;
		min-height: 5.35rem;
		aspect-ratio: 1.05;
		place-items: center;
		border: 1px solid #d8d0e1;
		border-radius: 7px;
		background: linear-gradient(180deg, var(--clock-lavender) 50%, #eae4f1 50%);
		box-shadow:
			0 3px 0 #d4cbdc,
			0 5px 8px rgb(55 50 61 / 0.06);
		font-family: var(--font-sans);
		font-size: clamp(2.9rem, 4.5vw, 4.8rem);
		font-weight: 650;
		font-variant-numeric: tabular-nums;
		letter-spacing: -0.075em;
		line-height: 1;
		text-indent: -0.075em;
	}

	.flip::after {
		position: absolute;
		top: 50%;
		right: 0;
		left: 0;
		height: 1px;
		background: #cfc5d8;
		content: '';
	}

	.separator {
		padding-bottom: 0.35rem;
		color: #80728c;
		font-size: 2rem;
		text-align: center;
	}

	.clock-footer {
		display: flex;
		justify-content: space-between;
		max-width: 20rem;
		margin: 0.85rem auto 0;
		color: #77707b;
		font-size: 0.59rem;
		letter-spacing: 0.07em;
	}

	.period {
		text-transform: uppercase;
	}
</style>
