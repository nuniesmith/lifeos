/**
 * Pure layout math for the inline SVG line charts on this page.
 *
 * Kept free of Svelte and of the DOM so the scaling — the part most likely to
 * have an off-by-one at an edge (a single point, an empty series, every value
 * identical) — is unit-testable without rendering anything. `MeasurementChart.svelte`
 * only turns the numbers this produces into markup.
 */

export interface ChartSeries {
	/** Key into each point's `values`. */
	key: string;
	label: string;
	/** A CSS colour, e.g. `var(--c-accent)`. Never a status colour (ok/warn/crit) — those are reserved. */
	color: string;
	dashed?: boolean;
}

export interface ChartPoint {
	/** An ISO instant. */
	at: string;
	values: Record<string, number | null>;
}

export interface PlottedPoint {
	x: number;
	y: number;
	value: number;
	at: string;
}

export interface PlottedSeries extends ChartSeries {
	/** Only the points this series actually has a value for — a gap in the
	 *  data is a gap in the line, not a dip to zero. */
	points: PlottedPoint[];
}

export interface Tick {
	y: number;
	label: string;
}

export interface ChartLayout {
	width: number;
	height: number;
	series: PlottedSeries[];
	yTicks: Tick[];
	isEmpty: boolean;
}

const PAD = { top: 10, right: 10, bottom: 8, left: 4 };

/**
 * Formats an axis label: whole numbers stay whole (a heart rate of "72", not
 * "72.0"), and one decimal place otherwise (a weight of "154.2").
 */
function formatTick(value: number, wholeNumbers: boolean): string {
	// Ticks sit on the padded bounds, which are rarely round. When every
	// reading is a whole number (blood pressure, heart rate, QT), label the
	// ticks the same way: "135", not "135.2".
	if (wholeNumbers) return String(Math.round(value));
	return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * Scales one or more series that share a single y-axis (systolic and
 * diastolic are both mmHg — the same chart, not two) onto a fixed-size
 * viewBox, ready to draw as an SVG polyline.
 *
 * Time runs left to right over the FULL window (every point passed in),
 * even for a series that has no reading on some of those days — that is what
 * keeps a blood-pressure line and a weight line, drawn from the same
 * `points`, lined up on the same day.
 */
export function layoutChart(
	points: readonly ChartPoint[],
	seriesConfig: readonly ChartSeries[],
	width = 320,
	height = 140
): ChartLayout {
	const innerLeft = PAD.left;
	const innerRight = width - PAD.right;
	const innerTop = PAD.top;
	const innerBottom = height - PAD.bottom;

	const times = points.map((p) => Date.parse(p.at)).filter((t) => Number.isFinite(t));
	const minTime = times.length ? Math.min(...times) : 0;
	const maxTime = times.length ? Math.max(...times) : 0;
	const timeSpan = maxTime - minTime;

	const xOf = (time: number, index: number, total: number): number => {
		// A single day, or every reading at the same instant, has no time span
		// to divide by — space points evenly instead of collapsing them onto
		// one x, which would draw nothing but a vertical stack of markers.
		if (timeSpan <= 0) {
			return total <= 1
				? (innerLeft + innerRight) / 2
				: innerLeft + (index / (total - 1)) * (innerRight - innerLeft);
		}
		return innerLeft + ((time - minTime) / timeSpan) * (innerRight - innerLeft);
	};

	const allValues = points.flatMap((p) =>
		seriesConfig
			.map((s) => p.values[s.key])
			.filter((v): v is number => v !== null && v !== undefined)
	);

	if (allValues.length === 0) {
		return { width, height, series: [], yTicks: [], isEmpty: true };
	}

	const rawMin = Math.min(...allValues);
	const rawMax = Math.max(...allValues);
	// Ten percent of headroom top and bottom, so a line does not run along the
	// very edge of the chart; a flat series (or a single reading) gets an
	// artificial band around its one value instead of a zero-height range.
	const span = rawMax - rawMin;
	const padding = span > 0 ? span * 0.1 : Math.max(Math.abs(rawMax) * 0.1, 1);
	const domainMin = rawMin - padding;
	const domainMax = rawMax + padding;
	const domainSpan = domainMax - domainMin;

	const yOf = (value: number): number =>
		innerBottom - ((value - domainMin) / domainSpan) * (innerBottom - innerTop);

	const series: PlottedSeries[] = seriesConfig.map((config) => ({
		...config,
		points: points
			.map((p, index) => {
				const value = p.values[config.key];
				if (value === null || value === undefined) return null;
				return { x: xOf(Date.parse(p.at), index, points.length), y: yOf(value), value, at: p.at };
			})
			.filter((p): p is PlottedPoint => p !== null)
	}));

	const yTicks: Tick[] = [domainMax, (domainMin + domainMax) / 2, domainMin].map((value) => ({
		y: yOf(value),
		label: formatTick(value, allValues.every(Number.isInteger))
	}));

	return { width, height, series, yTicks, isEmpty: false };
}

/** An SVG `points` attribute for a `<polyline>`, or null when there is nothing to draw. */
export function polylineOf(points: readonly PlottedPoint[]): string | null {
	if (points.length < 2) return null;
	return points.map((p) => `${p.x},${p.y}`).join(' ');
}
