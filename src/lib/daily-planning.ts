/**
 * Shared vocabulary for the daily-planning pack (migration 0038): a task's
 * theme and category, a day's theme, and the three Today's Three slots.
 *
 * Shared by the repository (filters, validation) and the pages (Selects,
 * labels), so it imports nothing from either: no Svelte, no database, no
 * `$lib/server`. The point is that the server and every page agree on the
 * label for a value without either side having its own copy to drift out of
 * step with the other — the same role `$lib/units.ts` plays for measurement
 * units.
 */

// ─── theme: the themed workday a task or a day belongs to ──────────────────

export const WORKDAY_THEMES = [
	'money_admin',
	'home_environment',
	'errands_appointments',
	'flex_overflow',
	'self_care',
	'random_fun',
	'reset'
] as const;

export type WorkdayTheme = (typeof WORKDAY_THEMES)[number];

export const WORKDAY_THEME_LABELS: Record<WorkdayTheme, string> = {
	money_admin: 'Money & Admin',
	home_environment: 'Home & Environment',
	errands_appointments: 'Errands & Appointments',
	flex_overflow: 'Flex & Overflow',
	self_care: 'Self-Care',
	random_fun: 'Random & Fun',
	reset: 'Reset'
};

/** `<Select>` options, in the order the household thinks of the week. */
export const WORKDAY_THEME_OPTIONS = WORKDAY_THEMES.map((value) => ({
	value,
	label: WORKDAY_THEME_LABELS[value]
}));

export function isWorkdayTheme(value: unknown): value is WorkdayTheme {
	return typeof value === 'string' && (WORKDAY_THEMES as readonly string[]).includes(value);
}

// ─── category: the kind of list a task sits on ─────────────────────────────

export const TASK_CATEGORIES = [
	'dopamine_menu',
	'three_tweaks',
	'hard_deadline',
	'parking_lot'
] as const;

export type TaskCategory = (typeof TASK_CATEGORIES)[number];

export const TASK_CATEGORY_LABELS: Record<TaskCategory, string> = {
	dopamine_menu: 'Dopamine Menu',
	three_tweaks: 'Three Tweaks',
	hard_deadline: 'Hard Deadlines',
	parking_lot: 'Parking Lot'
};

export const TASK_CATEGORY_OPTIONS = TASK_CATEGORIES.map((value) => ({
	value,
	label: TASK_CATEGORY_LABELS[value]
}));

export function isTaskCategory(value: unknown): value is TaskCategory {
	return typeof value === 'string' && (TASK_CATEGORIES as readonly string[]).includes(value);
}

// ─── today's three ──────────────────────────────────────────────────────────

export const TODAYS_THREE_SLOTS = ['due', 'hard', 'easy'] as const;

export type TodaysThreeSlot = (typeof TODAYS_THREE_SLOTS)[number];

export function isTodaysThreeSlot(value: unknown): value is TodaysThreeSlot {
	return typeof value === 'string' && (TODAYS_THREE_SLOTS as readonly string[]).includes(value);
}

export interface TodaysThreeSlotDefinition {
	slot: TodaysThreeSlot;
	label: string;
	/** The one-line definition Notion's daily focus gives each slot. */
	hint: string;
}

/** In display order: the order the brief states them in. */
export const TODAYS_THREE_DEFINITIONS: readonly TodaysThreeSlotDefinition[] = [
	{ slot: 'due', label: 'Due', hint: 'A task with a real deadline or consequence.' },
	{ slot: 'hard', label: 'Hard', hint: 'Something you’ve been avoiding.' },
	{ slot: 'easy', label: 'Easy', hint: 'One genuinely finishable task.' }
];
