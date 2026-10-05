import { describe, expect, it } from 'vitest';
import { attentionState } from '$lib/server/repositories/documents';

/**
 * `attentionState` (migration 0036): the whole of "needs attention" for a
 * document, computed rather than stored so a renewal's own lead-time edit
 * can never leave a cached flag stale against it. Kept in its own file the
 * same way labs-visits.ts's `rangeStatus` is, in case a sibling agent is also
 * touching tests/unit/repositories.test.ts.
 */

describe('attentionState', () => {
	it('is none with no expiry at all', () => {
		expect(attentionState(null, '2026-10-04', 30)).toBe('none');
	});

	it('is none with no expiry even when the lead time is zero', () => {
		expect(attentionState(null, '2026-10-04', 0)).toBe('none');
	});

	it('is expired the day after it expires', () => {
		expect(attentionState('2026-10-03', '2026-10-04', 30)).toBe('expired');
	});

	it('is expired, however long ago', () => {
		expect(attentionState('2026-01-01', '2026-10-04', 30)).toBe('expired');
	});

	it('is due, not expired, exactly on the day it expires', () => {
		expect(attentionState('2026-10-04', '2026-10-04', 30)).toBe('due');
	});

	it('is due exactly at the far edge of its own lead time -- inclusive', () => {
		expect(attentionState('2026-11-03', '2026-10-04', 30)).toBe('due');
	});

	it('is ok just one day past the far edge of its lead time', () => {
		expect(attentionState('2026-11-04', '2026-10-04', 30)).toBe('ok');
	});

	it('is ok, arbitrarily far in the future', () => {
		expect(attentionState('2030-01-01', '2026-10-04', 30)).toBe('ok');
	});

	describe('with a lead time of zero', () => {
		it('is due only on the day it expires itself', () => {
			expect(attentionState('2026-10-04', '2026-10-04', 0)).toBe('due');
		});

		it('is ok the very next day -- the lead window is zero days wide', () => {
			expect(attentionState('2026-10-05', '2026-10-04', 0)).toBe('ok');
		});

		it('is still expired once that single due day has passed', () => {
			expect(attentionState('2026-10-03', '2026-10-04', 0)).toBe('expired');
		});
	});
});
