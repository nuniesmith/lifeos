<script lang="ts">
	import { layoutChart, polylineOf, type ChartPoint, type ChartSeries } from './chart';

	interface Props {
		title: string;
		points: ChartPoint[];
		series: ChartSeries[];
		/** Appended to each point's native tooltip: "128 mmHg", "72 bpm". */
		unit?: string;
	}

	let { title, points, series, unit = '' }: Props = $props();

	const WIDTH = 320;
	const HEIGHT = 140;

	const layout = $derived(layoutChart(points, series, WIDTH, HEIGHT));

	const dateLabel = (iso: string): string =>
		new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
</script>

<figure class="chart">
	<figcaption>{title}</figcaption>

	{#if layout.isEmpty}
		<p class="empty">Not enough readings yet.</p>
	{:else}
		<svg viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label={title}>
			{#each layout.yTicks as tick (tick.y)}
				<line x1={0} x2={layout.width} y1={tick.y} y2={tick.y} class="grid" />
				<text x={2} y={tick.y - 3} class="tick">{tick.label}</text>
			{/each}

			{#each layout.series as plotted (plotted.key)}
				{@const line = polylineOf(plotted.points)}
				{#if line}
					<polyline
						points={line}
						class="line"
						class:dashed={plotted.dashed}
						style:stroke={plotted.color}
					/>
				{/if}
				<!--
					Keyed by position, not by `point.at`: two readings can share an
					instant (the form defaults to the current minute), and a duplicate
					key makes Svelte throw, which stopped the whole page updating.
					The circles hold no state, so position is a sufficient key.
				-->
				{#each plotted.points as point, index (index)}
					<circle cx={point.x} cy={point.y} r={2.75} style:fill={plotted.color}>
						<title
							>{`${dateLabel(point.at)}: ${point.value}${unit ? ` ${unit}` : ''} (${plotted.label})`}</title
						>
					</circle>
				{/each}
			{/each}
		</svg>

		{#if series.length > 1}
			<ul class="legend">
				{#each series as s (s.key)}
					<li>
						<span class="swatch" style:background={s.color}></span>
						{s.label}
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</figure>

<style>
	.chart {
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: var(--sp-2);
	}

	figcaption {
		font-size: var(--fs-sm);
		font-weight: 600;
		color: var(--c-text-muted);
	}

	svg {
		width: 100%;
		height: auto;
		/* A phone is narrower than 320 logical px in the viewBox at times; the
		   viewBox scaling handles that, this just stops the element itself
		   forcing a wider box than its column. */
		max-width: 100%;
		overflow: visible;
	}

	.grid {
		stroke: var(--c-border);
		stroke-width: 1;
		vector-effect: non-scaling-stroke;
	}

	.tick {
		fill: var(--c-text-muted);
		font-size: 8px;
	}

	.line {
		fill: none;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
		vector-effect: non-scaling-stroke;
	}

	/* Style, not just colour, tells the two BP lines apart — the app has only
	   one brand hue and a neutral, and a colour pair alone would not clear a
	   colour-vision check. */
	.line.dashed {
		stroke-dasharray: 5 4;
	}

	.empty {
		margin: 0;
		padding: var(--sp-4) 0;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}

	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-3);
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: var(--fs-xs);
		color: var(--c-text-muted);
	}

	.legend li {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-1);
	}

	.swatch {
		width: 0.85rem;
		height: 0.2rem;
		border-radius: var(--radius-pill);
	}
</style>
