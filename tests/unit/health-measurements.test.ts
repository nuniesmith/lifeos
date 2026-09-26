import { describe, expect, it } from 'vitest';
import { placeInZone } from '$lib/server/repositories/health-measurements';
import {
	layoutChart,
	polylineOf,
	type ChartPoint,
	type ChartSeries
} from '../../src/routes/(app)/health/measurements/chart';
import {
	summaryOf,
	toLocalInput,
	unitlessNote
} from '../../src/routes/(app)/health/measurements/format';

/**
 * The pure math behind the measurements page (MODEL-002): placing a stored
 * instant back onto a wall clock, summarising an arbitrary subset of six
 * possible readings, and scaling a sparse, possibly-empty series onto a fixed
 * chart. None of this touches Svelte or the database, which is the point —
 * an off-by-one at an edge (a single point, a flat series, an empty one)
 * should fail here, not by staring at a rendered chart.
 */

describe('placeInZone', () => {
	// This is the function a broken first version of this feature's repository
	// tried to do inline in SQL instead, by sending the datetime-local text as
	// a bound `::timestamp` parameter for PostgreSQL's own `AT TIME ZONE` to
	// interpret. The `postgres` driver's handling of that bound parameter and
	// PostgreSQL's reading of it as a naive timestamp disagreed about which
	// wall clock the text already named, and the zone offset was applied
	// twice — caught by the integration test asserting an exact instant, not
	// by anything that would show here (this file never touches SQL), which
	// is why that assertion exists at all despite this unit coverage.

	it('reads noon Toronto in September (EDT, UTC-4) as 16:00 UTC', () => {
		expect(placeInZone('2026-09-03T12:00', 'America/Toronto').toISOString()).toBe(
			'2026-09-03T16:00:00.000Z'
		);
	});

	it('follows the DST change: the same wall-clock hour is a different offset in January', () => {
		expect(placeInZone('2026-01-03T12:00', 'America/Toronto').toISOString()).toBe(
			'2026-01-03T17:00:00.000Z'
		);
	});

	it('is a no-op offset for UTC itself', () => {
		expect(placeInZone('2026-09-03T12:00', 'UTC').toISOString()).toBe('2026-09-03T12:00:00.000Z');
	});

	it('round-trips through toLocalInput', () => {
		const instant = placeInZone('2026-09-03T07:15', 'America/Toronto');
		expect(toLocalInput(instant, 'America/Toronto')).toBe('2026-09-03T07:15');
	});

	it('rejects anything that is not a datetime-local value', () => {
		expect(() => placeInZone('September 3, 2026', 'America/Toronto')).toThrow();
		expect(() => placeInZone('2026-09-03', 'America/Toronto')).toThrow();
	});
});

describe('toLocalInput', () => {
	it('reads an instant back onto the wall clock of the zone given', () => {
		// 2026-09-24T05:09:00Z is 1:09 AM in America/Toronto (EDT, UTC-4) that day.
		expect(toLocalInput('2026-09-24T05:09:00.000Z', 'America/Toronto')).toBe('2026-09-24T01:09');
	});

	it('follows the zone it is given, not the machine it runs on', () => {
		expect(toLocalInput('2026-09-24T05:09:00.000Z', 'UTC')).toBe('2026-09-24T05:09');
	});

	it('accepts a Date the same way it accepts an ISO string', () => {
		const date = new Date('2026-01-15T17:00:00.000Z');
		expect(toLocalInput(date, 'America/Toronto')).toBe('2026-01-15T12:00');
	});
});

describe('summaryOf', () => {
	const empty = {
		systolic: null,
		diastolic: null,
		heartRate: null,
		glucose: null,
		weight: null,
		qtInterval: null
	};

	it('pairs systolic and diastolic rather than listing them separately', () => {
		expect(summaryOf({ ...empty, systolic: 118, diastolic: 76 })).toBe('118/76 mmHg');
	});

	it('says which half it has when only one of the pair was recorded', () => {
		expect(summaryOf({ ...empty, systolic: 118 })).toBe('118 mmHg (systolic)');
		expect(summaryOf({ ...empty, diastolic: 76 })).toBe('76 mmHg (diastolic)');
	});

	it('shows glucose and weight in the unit each was taken in', () => {
		const text = summaryOf({
			...empty,
			glucose: 112,
			glucoseUnit: 'mg/dL',
			weight: 154.3,
			weightUnit: 'lb'
		});
		expect(text).toBe('glucose 112 mg/dL · weight 154.3 lb');
	});

	it('shows the bare number for a reading that recorded no unit, like an imported one', () => {
		const text = summaryOf({ ...empty, glucose: 6.2, weight: 71.4 });
		expect(text).toBe('glucose 6.2 · weight 71.4');
		expect(summaryOf({ ...empty, glucose: 6.2, glucoseUnit: null })).toBe('glucose 6.2');
	});

	it('combines every reading present, in a fixed order', () => {
		const text = summaryOf({
			systolic: 118,
			diastolic: 76,
			heartRate: 64,
			glucose: 6.2,
			weight: 71.4,
			qtInterval: 410
		});
		expect(text).toBe('118/76 mmHg · 64 bpm · glucose 6.2 · weight 71.4 · QT 410ms');
	});

	it('says plainly that a row has nothing on it, rather than an empty string', () => {
		expect(summaryOf(empty)).toBe('No readings recorded');
	});
});

describe('layoutChart', () => {
	const series: ChartSeries[] = [
		{ key: 'systolic', label: 'Systolic', color: 'var(--c-accent)' },
		{ key: 'diastolic', label: 'Diastolic', color: 'var(--c-text-muted)', dashed: true }
	];

	it('reports empty rather than dividing by a zero-length domain when no series has a value', () => {
		const points: ChartPoint[] = [
			{ at: '2026-01-01T12:00:00.000Z', values: { systolic: null, diastolic: null } }
		];
		const layout = layoutChart(points, series, 320, 140);
		expect(layout.isEmpty).toBe(true);
		expect(layout.series).toEqual([]);
	});

	it('places every point inside the drawable area, never on the exact edge', () => {
		const points: ChartPoint[] = [
			{ at: '2026-01-01T12:00:00.000Z', values: { systolic: 118, diastolic: 76 } },
			{ at: '2026-01-08T12:00:00.000Z', values: { systolic: 130, diastolic: 82 } },
			{ at: '2026-01-15T12:00:00.000Z', values: { systolic: 122, diastolic: 78 } }
		];
		const layout = layoutChart(points, series, 320, 140);
		expect(layout.isEmpty).toBe(false);
		for (const plotted of layout.series) {
			for (const p of plotted.points) {
				expect(p.y).toBeGreaterThan(0);
				expect(p.y).toBeLessThan(140);
				expect(p.x).toBeGreaterThanOrEqual(0);
				expect(p.x).toBeLessThanOrEqual(320);
			}
		}
	});

	it('does not collapse every point onto one x when every reading shares an instant', () => {
		const points: ChartPoint[] = [
			{ at: '2026-01-01T12:00:00.000Z', values: { systolic: 118, diastolic: null } },
			{ at: '2026-01-01T12:00:00.000Z', values: { systolic: 120, diastolic: null } }
		];
		const layout = layoutChart(points, series, 320, 140);
		const xs = layout.series.find((s) => s.key === 'systolic')?.points.map((p) => p.x) ?? [];
		expect(new Set(xs).size).toBe(2);
	});

	it('labels ticks as whole numbers when every reading is one, like blood pressure', () => {
		const points: ChartPoint[] = [
			{ at: '2026-01-01T12:00:00.000Z', values: { systolic: 131, diastolic: 83 } },
			{ at: '2026-01-08T12:00:00.000Z', values: { systolic: 118, diastolic: 76 } }
		];
		const labels = layoutChart(points, series, 320, 140).yTicks.map((t) => t.label);
		expect(labels).toHaveLength(3);
		for (const label of labels) expect(label).toMatch(/^\d+$/);
	});

	it('keeps one decimal on the ticks when the readings have decimals, like glucose', () => {
		const glucose: ChartSeries[] = [{ key: 'glucose', label: 'Glucose', color: 'var(--c-accent)' }];
		const points: ChartPoint[] = [
			{ at: '2026-01-01T12:00:00.000Z', values: { glucose: 5.4 } },
			{ at: '2026-01-08T12:00:00.000Z', values: { glucose: 6.1 } }
		];
		const labels = layoutChart(points, glucose, 320, 140).yTicks.map((t) => t.label);
		expect(labels.some((label) => label.includes('.'))).toBe(true);
	});

	it('bands a flat series around its one value instead of a zero-height range', () => {
		const points: ChartPoint[] = [
			{ at: '2026-01-01T12:00:00.000Z', values: { systolic: 120, diastolic: null } },
			{ at: '2026-01-08T12:00:00.000Z', values: { systolic: 120, diastolic: null } }
		];
		const layout = layoutChart(points, series, 320, 140);
		expect(layout.yTicks[0]!.y).not.toBe(layout.yTicks[2]!.y);
	});

	it('keeps a gap in one series a gap in its line, not a dip to zero', () => {
		const points: ChartPoint[] = [
			{ at: '2026-01-01T12:00:00.000Z', values: { systolic: 118, diastolic: 76 } },
			{ at: '2026-01-08T12:00:00.000Z', values: { systolic: null, diastolic: null } },
			{ at: '2026-01-15T12:00:00.000Z', values: { systolic: 122, diastolic: 78 } }
		];
		const layout = layoutChart(points, series, 320, 140);
		const systolic = layout.series.find((s) => s.key === 'systolic');
		expect(systolic?.points).toHaveLength(2);
		expect(systolic?.points.some((p) => p.value === 0)).toBe(false);
	});
});

describe('polylineOf', () => {
	it('draws nothing for a single point — there is no line to a lone reading', () => {
		expect(polylineOf([{ x: 1, y: 1, value: 1, at: '2026-01-01T00:00:00.000Z' }])).toBeNull();
	});

	it('joins two or more points into an SVG points attribute', () => {
		const points = [
			{ x: 1, y: 2, value: 1, at: '2026-01-01T00:00:00.000Z' },
			{ x: 3, y: 4, value: 2, at: '2026-01-02T00:00:00.000Z' }
		];
		expect(polylineOf(points)).toBe('1,2 3,4');
	});
});

describe('unitlessNote', () => {
	it('says nothing when every charted reading had a unit', () => {
		expect(unitlessNote(0, 0)).toBeNull();
	});

	it('names what was left off, in the singular', () => {
		expect(unitlessNote(1, 0)).toBe(
			'1 glucose reading has no unit recorded, so the chart leaves it out. Edit it below to set its unit.'
		);
	});

	it('names what was left off, in the plural', () => {
		expect(unitlessNote(0, 4)).toBe(
			'4 weight readings have no unit recorded, so the chart leaves them out. Edit them below to set their units.'
		);
	});

	it('covers both charts in one sentence when both left readings off', () => {
		expect(unitlessNote(2, 1)).toBe(
			'2 glucose and 1 weight readings have no unit recorded, so the charts leave them out. Edit them below to set their units.'
		);
	});
});
