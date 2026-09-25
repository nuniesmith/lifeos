import { describe, expect, it } from 'vitest';
import { knownDatabaseName } from '$lib/server/import/promote';

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
