<script lang="ts">
	/**
	 * One marker's results over time, with its reference range shown as a
	 * dashed line -- the chart the Notion source draws per marker (migration
	 * 0020). Route-local rather than in $lib/components: nothing else in the
	 * app plots a value against a reference band, the same reasoning that
	 * keeps Progress.svelte and TagsCard.svelte under routes/(app)/projects.
	 *
	 * Status is a prop, not computed here: this file is plain markup shipped
	 * to the browser, and `rangeStatus` lives in $lib/server -- importing it
	 * here would pull server code into the client bundle. The route's
	 * `+page.server.ts` computes it once and passes it down, the same value
	 * the table beside this chart already shows.
	 */
	import type { RangeStatus } from '$lib/server/repositories';

	interface Point {
		resultDate: string;
		value: number;
		status: RangeStatus;
	}

	interface Props {
		results: Point[];
		referenceLow: number | null;
		referenceHigh: number | null;
		units: string | null;
	}

	let { results, referenceLow, referenceHigh, units }: Props = $props();

	const WIDTH = 640;
	const HEIGHT = 220;
	const PAD_LEFT = 44;
	const PAD_RIGHT = 12;
	const PAD_TOP = 16;
	const PAD_BOTTOM = 26;
	const plotWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
	const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;

	// Status colours are reserved and always paired with text elsewhere on the
	// page (the table's own status word) -- never relied on alone here either;
	// every point also carries a native tooltip with the same word in it.
	const STATUS_COLOR: Record<RangeStatus, string> = {
		low: 'var(--c-crit)',
		high: 'var(--c-crit)',
		in_range: 'var(--c-ok)',
		no_reference: 'var(--c-text-muted)'
	};
	const STATUS_LABEL: Record<RangeStatus, string> = {
		low: 'low',
		high: 'high',
		in_range: 'in range',
		no_reference: 'no reference range'
	};

	const bounds = $derived.by(() => {
		const values = results.map((r) => r.value);
		const withReference = [...values, referenceLow, referenceHigh].filter(
			(v): v is number => v !== null
		);
		const min = Math.min(...withReference);
		const max = Math.max(...withReference);
		// A flat series -- or a single point -- needs artificial headroom, or
		// the scale collapses every value onto one line.
		const span = max - min || Math.max(Math.abs(max), 1);
		const headroom = span * 0.12;
		return { min: min - headroom, max: max + headroom };
	});

	function y(value: number): number {
		const { min, max } = bounds;
		const t = max === min ? 0.5 : (value - min) / (max - min);
		return PAD_TOP + plotHeight * (1 - t);
	}

	function x(index: number): number {
		return results.length <= 1
			? PAD_LEFT + plotWidth / 2
			: PAD_LEFT + (plotWidth * index) / (results.length - 1);
	}

	const linePath = $derived(
		results.map((r, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(r.value)}`).join(' ')
	);
	const areaPath = $derived(
		results.length === 0
			? ''
			: `${linePath} L ${x(results.length - 1)} ${PAD_TOP + plotHeight} L ${x(0)} ${PAD_TOP + plotHeight} Z`
	);

	/** The scale's top, middle and bottom -- three labelled gridlines, not one per value. */
	const valueTicks = $derived.by(() => {
		const { min, max } = bounds;
		const round = (v: number) => Math.round(v * 100) / 100;
		return [round(max), round((max + min) / 2), round(min)];
	});

	/** First, middle and last date only -- a label under every point crowds a longer history. */
	const dateTicks = $derived.by(() => {
		if (results.length === 0) return [];
		if (results.length <= 2) return results.map((r, i) => ({ index: i, label: r.resultDate }));
		const middle = Math.floor((results.length - 1) / 2);
		return [...new Set([0, middle, results.length - 1])].map((i) => ({
			index: i,
			label: results[i]!.resultDate
		}));
	});
</script>

{#if results.length === 0}
	<p class="empty">No results yet -- add one below and it plots here.</p>
{:else}
	<svg
		viewBox="0 0 {WIDTH} {HEIGHT}"
		role="img"
		aria-label="Results over time{units ? ` in ${units}` : ''}, from {results[0]!
			.resultDate} to {results[results.length - 1]!.resultDate}"
	>
		{#each valueTicks as tick (tick)}
			<line x1={PAD_LEFT} x2={WIDTH - PAD_RIGHT} y1={y(tick)} y2={y(tick)} class="grid" />
			<text
				x={PAD_LEFT - 6}
				y={y(tick)}
				class="tick-label"
				text-anchor="end"
				dominant-baseline="middle"
			>
				{tick}
			</text>
		{/each}

		{#if referenceLow !== null}
			<line
				x1={PAD_LEFT}
				x2={WIDTH - PAD_RIGHT}
				y1={y(referenceLow)}
				y2={y(referenceLow)}
				class="reference"
			/>
		{/if}
		{#if referenceHigh !== null}
			<line
				x1={PAD_LEFT}
				x2={WIDTH - PAD_RIGHT}
				y1={y(referenceHigh)}
				y2={y(referenceHigh)}
				class="reference"
			/>
		{/if}

		<path d={areaPath} class="area" />
		<path d={linePath} class="line" />

		{#each results as r, i (r.resultDate + '|' + i)}
			<circle cx={x(i)} cy={y(r.value)} r="4" style:fill={STATUS_COLOR[r.status]} class="point">
				<title>{r.resultDate}: {r.value}{units ? ` ${units}` : ''} ({STATUS_LABEL[r.status]})</title
				>
			</circle>
		{/each}

		{#each dateTicks as tick (tick.index)}
			<text x={x(tick.index)} y={HEIGHT - 6} class="tick-label" text-anchor="middle"
				>{tick.label}</text
			>
		{/each}
	</svg>
{/if}

<style>
	.empty {
		margin: 0;
		padding: var(--sp-8) 0;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
		text-align: center;
	}
	svg {
		width: 100%;
		height: auto;
		overflow: visible;
	}
	.grid {
		stroke: var(--c-border);
		stroke-width: 1;
	}
	.reference {
		stroke: var(--c-text-muted);
		stroke-width: 1.5;
		stroke-dasharray: 5 4;
	}
	.area {
		fill: color-mix(in srgb, var(--c-accent) 12%, transparent);
		stroke: none;
	}
	.line {
		fill: none;
		stroke: var(--c-accent);
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.point {
		stroke: var(--c-surface);
		stroke-width: 1.5;
	}
	.tick-label {
		fill: var(--c-text-muted);
		font-size: 10px;
	}
</style>
