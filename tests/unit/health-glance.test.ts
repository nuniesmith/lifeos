import { describe, expect, it } from 'vitest';
import type { HealthMeasurement, MedicalVisit } from '$lib/server/repositories';
import {
	dayLabel,
	healthGlance,
	labsStatus,
	measurementsStatus,
	medicationsStatus,
	visitsStatus,
	whenLabel
} from '../../src/routes/(app)/health/glance';

/**
 * The wording of `/health`'s one-line statuses. The numbers are the
 * repository's (tests/integration/health-glance.test.ts); what is proved here
 * is that each number reads the way a person would say it, including the
 * cases where there is nothing to say yet.
 */

const TODAY = '2026-09-25';
const ZONE = 'America/Toronto';

// Only the fields the status reads; the rest of the record is irrelevant here.
const reading = (fields: Partial<HealthMeasurement>): HealthMeasurement =>
	({
		measuredAt: new Date('2026-09-25T12:15:00Z'),
		systolic: null,
		diastolic: null,
		heartRate: null,
		glucose: null,
		weight: null,
		qtInterval: null,
		...fields
	}) as HealthMeasurement;

const visit = (reason: string, visitAt: string): MedicalVisit =>
	({ reason, visitAt: new Date(visitAt) }) as MedicalVisit;

describe('dayLabel', () => {
	it('names the days either side of today', () => {
		expect(dayLabel('2026-09-25', TODAY)).toBe('today');
		expect(dayLabel('2026-09-26', TODAY)).toBe('tomorrow');
		expect(dayLabel('2026-09-24', TODAY)).toBe('yesterday');
	});

	it('counts days within a week, and gives the date beyond one', () => {
		expect(dayLabel('2026-09-28', TODAY)).toBe('in 3 days');
		expect(dayLabel('2026-09-22', TODAY)).toBe('3 days ago');
		expect(dayLabel('2026-10-02', TODAY)).toBe('2026-10-02');
		expect(dayLabel('2026-08-01', TODAY)).toBe('2026-08-01');
	});
});

describe('whenLabel', () => {
	it('reads an instant on the household’s clock, not UTC’s', () => {
		// 02:30 UTC on the 26th is still the evening of the 25th in Toronto.
		expect(whenLabel(new Date('2026-09-26T02:30:00Z'), ZONE, TODAY)).toBe('today at 22:30');
	});
});

describe('medications', () => {
	it('says so when nothing is tracked yet', () => {
		expect(medicationsStatus({ tracked: 0, dueToday: 0, runningLow: 0 })).toBe(
			'Nothing tracked yet'
		);
	});

	it('says nothing is due rather than printing a zero', () => {
		expect(medicationsStatus({ tracked: 4, dueToday: 0, runningLow: 0 })).toBe('Nothing due today');
	});

	it('gives what is due and what is running low', () => {
		expect(medicationsStatus({ tracked: 4, dueToday: 2, runningLow: 1 })).toBe(
			'2 due today · 1 running low'
		);
		expect(medicationsStatus({ tracked: 4, dueToday: 0, runningLow: 3 })).toBe(
			'Nothing due today · 3 running low'
		);
	});
});

describe('measurements', () => {
	it('says so when there is no reading', () => {
		expect(measurementsStatus(null, ZONE, TODAY)).toBe('No readings yet');
	});

	it('leads with the reading, then when it was taken', () => {
		expect(
			measurementsStatus(reading({ systolic: 128, diastolic: 82, heartRate: 64 }), ZONE, TODAY)
		).toBe('Latest: 128/82 mmHg · 64 bpm · today at 08:15');
	});

	it('shows whatever the reading has when there is no blood pressure', () => {
		expect(
			measurementsStatus(
				reading({ weight: 71.4, measuredAt: new Date('2026-09-24T11:00:00Z') }),
				ZONE,
				TODAY
			)
		).toBe('Latest: weight 71.4 · yesterday at 07:00');
	});
});

describe('labs', () => {
	it('separates no markers, no results, and nothing out of range', () => {
		expect(labsStatus({ markers: 0, withResults: 0, outOfRange: 0 })).toBe('No markers yet');
		expect(labsStatus({ markers: 3, withResults: 0, outOfRange: 0 })).toBe('No results yet');
		expect(labsStatus({ markers: 3, withResults: 1, outOfRange: 0 })).toBe(
			'Nothing out of range · 1 marker tested'
		);
	});

	it('gives the out-of-range count against the markers that have results', () => {
		expect(labsStatus({ markers: 6, withResults: 5, outOfRange: 2 })).toBe(
			'2 of 5 markers out of range'
		);
		expect(labsStatus({ markers: 1, withResults: 1, outOfRange: 1 })).toBe(
			'1 of 1 marker out of range'
		);
	});
});

describe('visits', () => {
	it('says so when nothing is upcoming', () => {
		expect(visitsStatus(null, ZONE, TODAY)).toBe('Nothing upcoming');
	});

	it('gives the reason and when', () => {
		expect(visitsStatus(visit('Annual check-up', '2026-09-26T18:40:00Z'), ZONE, TODAY)).toBe(
			'Next: Annual check-up · tomorrow at 14:40'
		);
	});
});

describe('healthGlance', () => {
	it('links each of the four pages under Health, in a fixed order', () => {
		const entries = healthGlance({
			medications: { tracked: 0, dueToday: 0, runningLow: 0 },
			latestReading: null,
			labs: { markers: 0, withResults: 0, outOfRange: 0 },
			nextVisit: null,
			timeZone: ZONE,
			today: TODAY
		});
		expect(entries.map((e) => e.href)).toEqual([
			'/health/medications',
			'/health/measurements',
			'/health/labs',
			'/health/visits'
		]);
		// Each is a link with a name of its own, never a bare "View" or "More".
		for (const entry of entries) expect(entry.title.length).toBeGreaterThan(3);
	});
});
