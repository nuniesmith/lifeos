import { describe, expect, it } from 'vitest';
import { cleanTextArray } from '$lib/server/repositories/reading';
import {
	TASK_CATEGORIES,
	TASK_CATEGORY_LABELS,
	TASK_CATEGORY_OPTIONS,
	TODAYS_THREE_DEFINITIONS,
	TODAYS_THREE_SLOTS,
	WORKDAY_THEMES,
	WORKDAY_THEME_LABELS,
	WORKDAY_THEME_OPTIONS,
	isTaskCategory,
	isTodaysThreeSlot,
	isWorkdayTheme
} from '$lib/daily-planning';

/**
 * The shared vocabulary (migration 0038): one module, so the server and
 * every page agree on a label. These pin the labels themselves — the part a
 * future rename could change without anything else here noticing — and the
 * two guards repositories lean on to accept or refuse a value.
 */

describe('the themed-workday labels', () => {
	it('gives every theme the label the brief names, in order', () => {
		expect(WORKDAY_THEME_OPTIONS).toEqual([
			{ value: 'money_admin', label: 'Money & Admin' },
			{ value: 'home_environment', label: 'Home & Environment' },
			{ value: 'errands_appointments', label: 'Errands & Appointments' },
			{ value: 'flex_overflow', label: 'Flex & Overflow' },
			{ value: 'self_care', label: 'Self-Care' },
			{ value: 'random_fun', label: 'Random & Fun' },
			{ value: 'reset', label: 'Reset' }
		]);
	});

	it('has exactly one label per theme, no more and no fewer', () => {
		expect(Object.keys(WORKDAY_THEME_LABELS).sort()).toEqual([...WORKDAY_THEMES].sort());
	});

	it('recognises a real theme and refuses anything else', () => {
		expect(isWorkdayTheme('self_care')).toBe(true);
		expect(isWorkdayTheme('')).toBe(false);
		expect(isWorkdayTheme('selfcare')).toBe(false);
		expect(isWorkdayTheme(null)).toBe(false);
		expect(isWorkdayTheme(undefined)).toBe(false);
	});
});

describe('the task category labels', () => {
	it('gives every category the label the brief names, in order', () => {
		expect(TASK_CATEGORY_OPTIONS).toEqual([
			{ value: 'dopamine_menu', label: 'Dopamine Menu' },
			{ value: 'three_tweaks', label: 'Three Tweaks' },
			{ value: 'hard_deadline', label: 'Hard Deadlines' },
			{ value: 'parking_lot', label: 'Parking Lot' }
		]);
	});

	it('has exactly one label per category, no more and no fewer', () => {
		expect(Object.keys(TASK_CATEGORY_LABELS).sort()).toEqual([...TASK_CATEGORIES].sort());
	});

	it('recognises a real category and refuses anything else', () => {
		expect(isTaskCategory('hard_deadline')).toBe(true);
		expect(isTaskCategory('urgent')).toBe(false);
		expect(isTaskCategory(42)).toBe(false);
	});

	it('is a different vocabulary from theme — nothing overlaps', () => {
		// Theme and category are deliberately two separate questions (the
		// brief's own distinction); sharing a value would be the schema
		// quietly conflating them again.
		const overlap = TASK_CATEGORIES.filter((c) =>
			(WORKDAY_THEMES as readonly string[]).includes(c)
		);
		expect(overlap).toEqual([]);
	});
});

describe("Today's Three slot definitions", () => {
	it('defines exactly DUE, HARD and EASY, in that order', () => {
		expect(TODAYS_THREE_DEFINITIONS.map((d) => d.slot)).toEqual(['due', 'hard', 'easy']);
		expect(TODAYS_THREE_SLOTS).toEqual(['due', 'hard', 'easy']);
	});

	it('carries the one-line definition the brief gives each slot', () => {
		const hints = Object.fromEntries(TODAYS_THREE_DEFINITIONS.map((d) => [d.slot, d.hint]));
		expect(hints.due).toBe('A task with a real deadline or consequence.');
		expect(hints.hard).toBe('Something you’ve been avoiding.');
		expect(hints.easy).toBe('One genuinely finishable task.');
	});

	it('recognises a real slot and refuses anything else', () => {
		expect(isTodaysThreeSlot('hard')).toBe(true);
		expect(isTodaysThreeSlot('medium')).toBe(false);
		expect(isTodaysThreeSlot(null)).toBe(false);
	});
});

/**
 * `daily_logs.pattern_tags` relies on reading.ts's own `cleanTextArray`
 * (the brief's own instruction: clean it "like moods/tags in reading.ts"),
 * which already has exhaustive coverage of its own in reading.test.ts. This
 * pins the one fact that matters from the pattern-tags call site: it is
 * the SAME function, not a second copy that could drift from it.
 */
describe('pattern-tag cleaning', () => {
	it('cleans a comma-separated field the way the journal form sends it', () => {
		expect(cleanTextArray('Low energy, Rainy day , low energy')).toEqual([
			'Low energy',
			'Rainy day'
		]);
	});

	it('is empty, never null, for nothing recorded', () => {
		expect(cleanTextArray(undefined)).toEqual([]);
		expect(cleanTextArray('')).toEqual([]);
	});
});
