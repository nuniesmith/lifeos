import { describe, expect, it } from 'vitest';
import { progressLabel, progressPercent } from '../../src/routes/(app)/reading/challenges/form';

/**
 * The pure formatting behind the challenges pages: the brief's own two
 * examples ("12 of 30", "8 of 20 prompts") and the percent a progress bar's
 * fill is given, including the zero-total edge a brand new prompts challenge
 * starts at (no items yet, so a naive division would be NaN%).
 */

describe('progressLabel', () => {
	it('labels a count challenge without the word "prompts"', () => {
		expect(progressLabel('count', { done: 12, total: 30 })).toBe('12 of 30');
	});

	it('labels a prompts challenge with the word "prompts"', () => {
		expect(progressLabel('prompts', { done: 8, total: 20 })).toBe('8 of 20 prompts');
	});
});

describe('progressPercent', () => {
	it('is zero for a challenge with nothing to fill yet', () => {
		expect(progressPercent({ done: 0, total: 0 })).toBe(0);
	});

	it('rounds to the nearest whole percent', () => {
		expect(progressPercent({ done: 1, total: 3 })).toBe(33);
	});

	it('never exceeds 100%, even if done somehow passed total', () => {
		expect(progressPercent({ done: 35, total: 30 })).toBe(100);
	});

	it('is exactly 100% at the target', () => {
		expect(progressPercent({ done: 30, total: 30 })).toBe(100);
	});
});
