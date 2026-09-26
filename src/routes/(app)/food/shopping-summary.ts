/**
 * What "add this week's ingredients to the shopping list" did, in words.
 *
 * The action overwrites statuses somebody chose, so saying exactly what it did
 * is part of the feature rather than decoration: a change nobody is told about
 * is one nobody can check or undo. Kept pure, and out of the component, so the
 * wording is tested without a browser.
 *
 * The shapes are declared here rather than imported from the repository: this
 * module is used by the page, and the page must not reach into server code.
 */

export interface PlanShoppingCounts {
	added: readonly { name: string }[];
	alreadyListed: number;
	inStock: number;
	useUp: number;
	notYours: number;
	needed: number;
}

const ingredients = (n: number) => `${n} ingredient${n === 1 ? '' : 's'}`;

/** "Added 7 ingredients to the shopping list; 3 already in stock." */
export function describePlanShopping(result: PlanShoppingCounts): string {
	if (result.needed === 0) {
		return 'None of the planned recipes list any ingredients yet, so there was nothing to add.';
	}

	const lead =
		result.added.length > 0
			? `Added ${ingredients(result.added.length)} to the shopping list`
			: 'Nothing new to add to the shopping list';

	const rest = [
		result.alreadyListed > 0 ? `${result.alreadyListed} already on it` : null,
		result.inStock > 0 ? `${result.inStock} already in stock` : null,
		result.useUp > 0 ? `${result.useUp} to use up first` : null,
		// Not in the house, but owned by the other member: named so a missing
		// item on the list has an explanation rather than looking like a bug.
		result.notYours > 0 ? `${result.notYours} not yours to change` : null
	].filter(Boolean);

	return rest.length > 0 ? `${lead}; ${rest.join(', ')}.` : `${lead}.`;
}

/** "Took 7 ingredients back off the shopping list." */
export function describeUndo(result: { restored: number; leftAlone: number }): string {
	const lead =
		result.restored > 0
			? `Took ${ingredients(result.restored)} back off the shopping list`
			: 'Nothing to take back off the shopping list';
	if (result.leftAlone === 0) return `${lead}.`;
	// Bought (or otherwise changed) since they were added — undo is not
	// allowed to un-buy something.
	const them = result.leftAlone === 1 ? 'it was' : 'they were';
	return `${lead}; ${result.leftAlone} had changed since, so ${them} left alone.`;
}
