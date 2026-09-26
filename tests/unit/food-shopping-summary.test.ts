import { describe, expect, it } from 'vitest';
import {
	describePlanShopping,
	describeUndo,
	type PlanShoppingCounts
} from '../../src/routes/(app)/food/shopping-summary';

/**
 * The words /food uses to say what "add this week's ingredients" did. The
 * action overwrites statuses somebody chose, so this report is how it avoids
 * doing that silently — worth pinning down.
 */

const names = (...list: string[]) => list.map((name) => ({ name }));

const counts = (overrides: Partial<PlanShoppingCounts> = {}): PlanShoppingCounts => ({
	added: [],
	alreadyListed: 0,
	inStock: 0,
	useUp: 0,
	notYours: 0,
	needed: 0,
	...overrides
});

describe('describePlanShopping', () => {
	it('says how many were added and how many were already in', () => {
		expect(
			describePlanShopping(
				counts({ added: names('a', 'b', 'c', 'd', 'e', 'f', 'g'), inStock: 3, needed: 10 })
			)
		).toBe('Added 7 ingredients to the shopping list; 3 already in stock.');
	});

	it('uses the singular for one', () => {
		expect(describePlanShopping(counts({ added: names('Leeks'), needed: 1 }))).toBe(
			'Added 1 ingredient to the shopping list.'
		);
	});

	it('names every reason something was left alone', () => {
		expect(
			describePlanShopping(
				counts({
					added: names('Leeks'),
					alreadyListed: 2,
					inStock: 1,
					useUp: 1,
					notYours: 1,
					needed: 6
				})
			)
		).toBe(
			'Added 1 ingredient to the shopping list; 2 already on it, 1 already in stock, ' +
				'1 to use up first, 1 not yours to change.'
		);
	});

	it('says a second run found nothing new, rather than claiming it added something', () => {
		expect(describePlanShopping(counts({ alreadyListed: 4, inStock: 2, needed: 6 }))).toBe(
			'Nothing new to add to the shopping list; 4 already on it, 2 already in stock.'
		);
	});

	it('explains an empty result instead of reporting zero', () => {
		expect(describePlanShopping(counts())).toBe(
			'None of the planned recipes list any ingredients yet, so there was nothing to add.'
		);
	});
});

describe('describeUndo', () => {
	it('says how many came back off the list', () => {
		expect(describeUndo({ restored: 7, leftAlone: 0 })).toBe(
			'Took 7 ingredients back off the shopping list.'
		);
	});

	it('says when something had been bought in the meantime and was kept', () => {
		expect(describeUndo({ restored: 1, leftAlone: 1 })).toBe(
			'Took 1 ingredient back off the shopping list; 1 had changed since, so it was left alone.'
		);
		expect(describeUndo({ restored: 0, leftAlone: 2 })).toBe(
			'Nothing to take back off the shopping list; 2 had changed since, so they were left alone.'
		);
	});
});
