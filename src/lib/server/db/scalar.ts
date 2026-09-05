/**
 * Helpers for single-row queries.
 *
 * With `noUncheckedIndexedAccess`, destructuring `const [row] = await sql...`
 * yields `T | undefined` at every call site. These make the one legitimate
 * assumption — that `count(*)` and `returning` always produce a row — explicit
 * and checked in one place instead of asserted everywhere.
 */

export function one<T>(rows: readonly T[], what = 'row'): T {
	const row = rows[0];
	if (row === undefined) throw new Error(`expected exactly one ${what}, got none`);
	return row;
}

export function count(rows: readonly { count: number }[]): number {
	return one(rows, 'count').count;
}
