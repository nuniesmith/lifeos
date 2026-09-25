import { describe, expect, it } from 'vitest';
import { knownDatabaseName, sourceInstant } from '$lib/server/import/promote';

// On 2026-09-24 three databases were renamed in Notion. Looked up by name,
// each fell through to "not recognised" and stopped updating, silently.
describe('databases renamed in Notion', () => {
	it('finds a renamed database by its Notion id', () => {
		expect(
			knownDatabaseName('Symptom Library Database', '3bc879a5-56f1-801a-97e8-d6ab23727d35')
		).toBe('Symptoms Database');
		expect(
			knownDatabaseName('Movement Library Database', '3bc879a5-56f1-8041-84bb-e5e8cd7dd446')
		).toBe('Activity Database');
		expect(
			knownDatabaseName('Vitamins & Medications Database', '3bc879a5-56f1-808c-8f0e-d230d152b08f')
		).toBe('Vitamins Database');
	});

	it('uses the name for a database whose id it does not list', () => {
		expect(knownDatabaseName('Tasks Database', '00000000-0000-0000-0000-000000000000')).toBe(
			'Tasks Database'
		);
	});

	it('uses the name when there is no id', () => {
		expect(knownDatabaseName('Tasks Database', null)).toBe('Tasks Database');
	});
});

// Notion writes date-times with no zone. Read in the process zone, the same
// import stored midnight Toronto from one machine and 8 pm the previous
// evening from a UTC container: 30 dates shown a day early (2026-09-25).
describe('Notion date-times are read in the household zone, not the machine zone', () => {
	it('places a date-only value at midnight in the household zone', () => {
		expect(sourceInstant('May 28, 2026', 'America/Toronto')).toBe('2026-05-28T04:00:00.000Z');
		expect(sourceInstant('January 15, 2026', 'America/Toronto')).toBe('2026-01-15T05:00:00.000Z');
	});

	it('follows the zone it is given, whatever zone the process runs in', () => {
		// The test process runs in America/Toronto (vite.config.ts), so these
		// can only pass if the argument decides.
		expect(sourceInstant('May 28, 2026', 'Asia/Tokyo')).toBe('2026-05-27T15:00:00.000Z');
		expect(sourceInstant('May 28, 2026', 'UTC')).toBe('2026-05-28T00:00:00.000Z');
	});

	it('keeps the clock time of a date-time', () => {
		expect(sourceInstant('September 20, 2026 8:58 PM', 'America/Toronto')).toBe(
			'2026-09-21T00:58:00.000Z'
		);
	});

	it('reads a value that names its own zone as written', () => {
		expect(sourceInstant('September 20, 2026 8:58 PM (UTC)', 'America/Toronto')).toBe(
			'2026-09-20T20:58:00.000Z'
		);
		expect(sourceInstant('2026-09-20T20:58:00Z', 'Asia/Tokyo')).toBe('2026-09-20T20:58:00.000Z');
	});

	it('returns null for nothing and for nonsense', () => {
		expect(sourceInstant('', 'America/Toronto')).toBeNull();
		expect(sourceInstant('not a date', 'America/Toronto')).toBeNull();
	});
});
