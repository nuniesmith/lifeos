import { describe, expect, it } from 'vitest';
import { compactPositions, resolveStepVersion } from '$lib/server/repositories/routines';

/**
 * The two pure rules a routine step follows, tested without a database: which
 * text to show for an energy level (`resolveStepVersion`), and how a
 * routine's live steps renumber once one of them is archived
 * (`compactPositions`).
 */

describe('resolveStepVersion', () => {
	const step = { highVersion: 'Sprint 5k', averageVersion: 'Walk 20 minutes', minimalVersion: null };

	it('shows the average version by default', () => {
		expect(resolveStepVersion(step, 'average')).toBe('Walk 20 minutes');
	});

	it('shows the high-energy version when it is filled in', () => {
		expect(resolveStepVersion(step, 'high')).toBe('Sprint 5k');
	});

	it('falls back to average when the minimal version was never written', () => {
		expect(resolveStepVersion(step, 'minimal')).toBe('Walk 20 minutes');
	});

	it('falls back to average when the requested version is blank, not just missing', () => {
		const blank = { ...step, highVersion: '   ' };
		expect(resolveStepVersion(blank, 'high')).toBe('Walk 20 minutes');
	});

	it('uses the minimal version once someone has written one', () => {
		const full = { ...step, minimalVersion: 'Stand up and stretch' };
		expect(resolveStepVersion(full, 'minimal')).toBe('Stand up and stretch');
	});
});

describe('compactPositions', () => {
	it('leaves an already-contiguous sequence unchanged', () => {
		const steps = [
			{ id: 'a', position: 1 },
			{ id: 'b', position: 2 },
			{ id: 'c', position: 3 }
		];
		expect(compactPositions(steps)).toEqual([
			{ id: 'a', position: 1 },
			{ id: 'b', position: 2 },
			{ id: 'c', position: 3 }
		]);
	});

	it('closes a gap left by an archived step, preserving order', () => {
		// Position 2 is gone (archived); 3 and 4 close up to 2 and 3.
		const steps = [
			{ id: 'a', position: 1 },
			{ id: 'c', position: 3 },
			{ id: 'd', position: 4 }
		];
		expect(compactPositions(steps)).toEqual([
			{ id: 'a', position: 1 },
			{ id: 'c', position: 2 },
			{ id: 'd', position: 3 }
		]);
	});

	it('sorts by position first, regardless of the input order', () => {
		const steps = [
			{ id: 'z', position: 5 },
			{ id: 'a', position: 1 }
		];
		expect(compactPositions(steps)).toEqual([
			{ id: 'a', position: 1 },
			{ id: 'z', position: 2 }
		]);
	});

	it('renumbers a single remaining step to 1', () => {
		expect(compactPositions([{ id: 'only', position: 4 }])).toEqual([{ id: 'only', position: 1 }]);
	});

	it('returns an empty list for an empty routine', () => {
		expect(compactPositions([])).toEqual([]);
	});
});
