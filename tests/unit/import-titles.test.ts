import { describe, expect, it } from 'vitest';
import {
	MAX_FILENAME_TITLE,
	databaseNameFromPath,
	pageDirectoryFor,
	titleKey,
	titleKeys
} from '$lib/server/import/run';

describe('title normalisation', () => {
	it.each([
		['Environment: House & Home', 'environment house & home'],
		['Achey/Sore', 'achey sore'],
		['Upper Body: Biceps & Triceps', 'upper body biceps & triceps'],
		['Already Plain', 'already plain'],
		// No page filename in this export contains a period, while titles do.
		['The Eisenhower Matrix 2.0', 'the eisenhower matrix 2 0']
	])('matches the filename Notion writes for %s', (title, expected) => {
		// Notion cannot put ':' or '/' in a filename, so comparing raw titles
		// fails for every row containing one.
		expect(titleKey(title)).toBe(expected);
	});

	it('collapses the whitespace left behind by a replacement', () => {
		expect(titleKey('A  :  B')).toBe('a b');
	});

	it('handles every character illegal in a filename', () => {
		expect(titleKey('a\\b/c:d*e?f"g<h>i|j.k')).toBe('a b c d e f g h i j k');
	});
});

describe('long title fallback', () => {
	const long = 'The Eisenhower Matrix 2.0 - Beyond Urgent and Important for Real Work';

	it('offers the exact key first', () => {
		expect(titleKeys('short')).toEqual(['short']);
	});

	it('adds a truncated key only when the title is too long for a filename', () => {
		const keys = titleKeys(long);
		expect(keys).toHaveLength(2);
		expect(keys[1]).toHaveLength(MAX_FILENAME_TITLE);
		expect(keys[0]!.startsWith(keys[1]!)).toBe(true);
	});

	it('does not truncate a title that already fits', () => {
		const exact = 'x'.repeat(MAX_FILENAME_TITLE);
		expect(titleKeys(exact)).toHaveLength(1);
	});
});

describe('export path conventions', () => {
	it('pairs a CSV with the directory holding its page files', () => {
		// The CSV keeps the database id; the sibling directory does not.
		expect(
			pageDirectoryFor('Life OS/System/Tasks Database 3ad879a556f180c1ac15d106e1e07e2c_all.csv')
		).toBe('Life OS/System/Tasks Database');
	});

	it('derives a readable database name', () => {
		expect(
			databaseNameFromPath('Life OS/System/Tasks Database 3ad879a556f180c1ac15d106e1e07e2c_all.csv')
		).toBe('Tasks Database');
	});
});
