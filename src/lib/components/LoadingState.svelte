<script lang="ts">
	interface Props {
		/** Announced to assistive technology; not shown. */
		label?: string;
		/** How many skeleton rows to draw. Match the list being replaced. */
		lines?: number;
	}

	let { label = 'Loading…', lines = 3 }: Props = $props();

	// A stable key per row: the shimmer offset is a function of position, so
	// the bars do not all pulse in lockstep.
	const rows = $derived(Array.from({ length: Math.max(1, lines) }, (_, i) => i));
</script>

<!--
	A polite live region, not an alert: content arriving is not an
	interruption. The visible part is a skeleton rather than a spinner so the
	page does not reflow when the real rows land.
-->
<div class="loading" role="status" aria-live="polite" aria-busy="true">
	<span class="sr-only">{label}</span>
	{#each rows as row (row)}
		<span class="bar" style="--i: {row}"></span>
	{/each}
</div>

<style>
	.loading {
		display: flex;
		flex-direction: column;
		gap: var(--sp-3);
		padding: var(--sp-4);
	}

	.bar {
		height: 1rem;
		border-radius: var(--radius-sm);
		background: var(--c-skeleton);
		animation: pulse 1.4s ease-in-out infinite;
		animation-delay: calc(var(--i) * 120ms);
	}

	/* Rows of unequal length read as text rather than as a loading bar chart. */
	.bar:nth-child(3n + 2) {
		width: 82%;
	}
	.bar:nth-child(3n + 3) {
		width: 64%;
	}

	@keyframes pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.55;
		}
	}

	/* tokens.css already collapses the animation under reduced motion; the
	   bars then sit still, which is the correct fallback for a skeleton. */
</style>
