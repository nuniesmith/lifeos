import { describe, expect, it } from 'vitest';
import { rangeStatus } from '$lib/server/repositories/labs-visits';

/**
 * `rangeStatus` (migration 0020): the whole of "Out of Range?", computed
 * rather than stored so a marker's reference range can be edited without a
 * cached flag going stale against it. Kept in its own file rather than added
 * to tests/unit/repositories.test.ts, which sibling agents building the other
 * Health feature packs are also likely to be touching (see the file header in
 * src/lib/server/repositories/labs-visits.ts).
 */

describe('rangeStatus', () => {
	it('is in range strictly between the bounds', () => {
		expect(rangeStatus(5, 1, 10)).toBe('in_range');
	});

	it('is in range exactly at the low bound -- inclusive, not exclusive', () => {
		expect(rangeStatus(1, 1, 10)).toBe('in_range');
	});

	it('is in range exactly at the high bound -- inclusive, not exclusive', () => {
		expect(rangeStatus(10, 1, 10)).toBe('in_range');
	});

	it('is low just under the low bound', () => {
		expect(rangeStatus(0.9, 1, 10)).toBe('low');
	});

	it('is high just over the high bound', () => {
		expect(rangeStatus(10.1, 1, 10)).toBe('high');
	});

	describe('with only one reference bound', () => {
		it('can still be flagged high with no low bound at all', () => {
			expect(rangeStatus(999, null, 10)).toBe('high');
		});

		it('is in range under a high-only bound, arbitrarily low', () => {
			expect(rangeStatus(-999, null, 10)).toBe('in_range');
		});

		it('can still be flagged low with no high bound at all', () => {
			expect(rangeStatus(-1, 1, null)).toBe('low');
		});

		it('is in range over a low-only bound, arbitrarily high', () => {
			expect(rangeStatus(999, 1, null)).toBe('in_range');
		});
	});

	it('reports no_reference rather than in_range when neither bound is set', () => {
		// A different fact from "confirmed in range": nothing has been recorded
		// to check the value against yet.
		expect(rangeStatus(5, null, null)).toBe('no_reference');
	});
});
