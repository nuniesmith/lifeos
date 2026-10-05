import { describe, expect, it } from 'vitest';
import { parseCsvTable } from '$lib/server/import/csv';
import {
	BOOK_PACES,
	cleanTextArray,
	mapStorygraphRow,
	parseIsbn,
	parseQuarterRating,
	parseStorygraphDate
} from '$lib/server/import/storygraph';

/**
 * The StoryGraph row mapper (Reading Tracker R3b; migration 0037).
 *
 * Pure -- no database -- so every shape the brief enumerates is exercised
 * directly here, the same way import-csv.test.ts exercises csv.ts. All
 * titles and authors below are invented; this never reads from `data/`,
 * which holds the household's real StoryGraph export (hard rule 1).
 */

/** A complete, StoryGraph-shaped row (no Notion extras -- see the "header
 *  shape" suite below for that distinction), overridable per test so each
 *  one only names the cell it actually cares about. */
function baseRow(overrides: Record<string, string> = {}): Record<string, string> {
	return {
		Title: 'The Sample Saga',
		Authors: 'Fictional Author',
		'Character- or Plot-Driven?': '',
		'Content Warning Description': '',
		'Content Warnings': '',
		Contributors: '',
		'Date Added': '2024/01/01',
		'Dates Read': '',
		'Diverse Characters?': '',
		'Flawed Characters?': '',
		Format: 'digital',
		'ISBN/UID': '9780000000001',
		'Last Date Read': '',
		'Loveable Characters?': '',
		Moods: '',
		'Owned?': 'No',
		Pace: 'medium',
		'Read Count': '1',
		'Read Status': 'read',
		Review: '',
		'Star Rating': '',
		'Strong Character Development?': '',
		Tags: '',
		...overrides
	};
}

/** Maps a row and asserts it produced a book, for tests that only care
 *  about the book's shape rather than a row-level refusal. */
function bookOf(overrides: Record<string, string> = {}, row = 1) {
	const mapped = mapStorygraphRow(baseRow(overrides), row);
	if (!mapped.book) {
		throw new Error(`row ${row} did not map to a book: ${JSON.stringify(mapped.warnings)}`);
	}
	return mapped.book;
}

describe('Read Status', () => {
	it('maps read to status read and builds a finished read from its range', () => {
		const book = bookOf({ 'Read Status': 'read', 'Dates Read': '2024/01/05-2024/01/20' });
		expect(book.status).toBe('read');
		expect(book.reads).toEqual([
			{
				status: 'finished',
				startedOn: '2024-01-05',
				finishedOn: '2024-01-20',
				rating: null,
				review: null
			}
		]);
	});

	it('maps currently-reading to status reading with one open read', () => {
		const book = bookOf({ 'Read Status': 'currently-reading', 'Dates Read': '2024/03/01' });
		expect(book.status).toBe('reading');
		expect(book.reads).toEqual([
			{ status: 'reading', startedOn: '2024-03-01', finishedOn: null, rating: null, review: null }
		]);
	});

	it('maps paused to status paused with one open read', () => {
		const book = bookOf({ 'Read Status': 'paused', 'Dates Read': '2024/03/01' });
		expect(book.status).toBe('paused');
		expect(book.reads).toEqual([
			{ status: 'paused', startedOn: '2024-03-01', finishedOn: null, rating: null, review: null }
		]);
	});

	it('maps to-read to status tbr with no read at all', () => {
		const book = bookOf({ 'Read Status': 'to-read', 'Dates Read': '2024/01/05-2024/01/20' });
		expect(book.status).toBe('tbr');
		expect(book.reads).toEqual([]);
	});

	it('maps did-not-finish to status dnf with exactly one dateless read', () => {
		// Dates Read is populated here on purpose: unlike `read`/`reading`/
		// `paused`, a dnf row mines no date source at all (this module's
		// header), so the range above must have no effect on the read built.
		const book = bookOf({ 'Read Status': 'did-not-finish', 'Dates Read': '2024/01/05-2024/01/20' });
		expect(book.status).toBe('dnf');
		expect(book.reads).toEqual([
			{ status: 'dnf', startedOn: null, finishedOn: null, rating: null, review: null }
		]);
	});

	it('refuses an unrecognised value rather than guessing a status', () => {
		const mapped = mapStorygraphRow(baseRow({ 'Read Status': 'skimmed' }), 9);
		expect(mapped.book).toBeNull();
		expect(mapped.warnings).toEqual([
			{ row: 9, field: 'Read Status', message: expect.any(String) }
		]);
	});

	it('refuses a row with no title', () => {
		const mapped = mapStorygraphRow(baseRow({ Title: '   ' }), 3);
		expect(mapped.book).toBeNull();
		expect(mapped.warnings).toEqual([{ row: 3, field: 'Title', message: expect.any(String) }]);
	});
});

describe('Format', () => {
	it.each([
		['digital', 'ebook'],
		['audio', 'audiobook'],
		['paperback', 'print'],
		['hardcover', 'print'],
		['print', 'print'],
		['', null],
		['vinyl', null]
	])('maps %s to %s', (raw, expected) => {
		expect(bookOf({ Format: raw }).format).toBe(expected);
	});
});

describe('dates', () => {
	it('converts StoryGraph YYYY/MM/DD to YYYY-MM-DD', () => {
		expect(parseStorygraphDate('2024/01/05')).toBe('2024-01-05');
	});

	it('rejects anything not in that shape, including blank', () => {
		expect(parseStorygraphDate('01/05/2024')).toBeNull();
		expect(parseStorygraphDate('January 5, 2024')).toBeNull();
		expect(parseStorygraphDate('')).toBeNull();
	});

	it('warns on an unparsable Date Added rather than throwing', () => {
		const mapped = mapStorygraphRow(baseRow({ 'Date Added': 'not a date' }), 4);
		expect(mapped.book?.tbrAddedOn).toBeNull();
		expect(mapped.warnings).toEqual([{ row: 4, field: 'Date Added', message: expect.any(String) }]);
	});
});

describe('Dates Read shapes', () => {
	it('a single range becomes one finished read', () => {
		const book = bookOf({ 'Dates Read': '2024/01/05-2024/01/20' });
		expect(book.reads).toEqual([
			{
				status: 'finished',
				startedOn: '2024-01-05',
				finishedOn: '2024-01-20',
				rating: null,
				review: null
			}
		]);
	});

	it('a lone date on a read row becomes finished_on with no started_on', () => {
		const book = bookOf({ 'Dates Read': '2024/01/20' });
		expect(book.reads).toEqual([
			{ status: 'finished', startedOn: null, finishedOn: '2024-01-20', rating: null, review: null }
		]);
	});

	it('several comma-separated ranges become one finished read each, most recent last', () => {
		const book = bookOf({
			'Dates Read': '2019/05/01-2019/05/10,2024/02/01-2024/02/20',
			'Star Rating': '5',
			Review: 'Even better the second time.'
		});
		expect(book.reads).toHaveLength(2);
		expect(book.reads[0]).toMatchObject({
			startedOn: '2019-05-01',
			finishedOn: '2019-05-10',
			rating: null,
			review: null
		});
		// "Star Rating and Review go on the MOST RECENT read only."
		expect(book.reads[1]).toMatchObject({
			startedOn: '2024-02-01',
			finishedOn: '2024-02-20',
			rating: 5,
			review: 'Even better the second time.'
		});
	});

	it('an empty Dates Read on a read row falls back to Last Date Read', () => {
		const book = bookOf({ 'Dates Read': '', 'Last Date Read': '2021/07/04' });
		expect(book.reads).toEqual([
			{ status: 'finished', startedOn: null, finishedOn: '2021-07-04', rating: null, review: null }
		]);
	});

	it('still produces one dateless finished read when Last Date Read is also empty', () => {
		const book = bookOf({ 'Dates Read': '', 'Last Date Read': '' });
		expect(book.reads).toEqual([
			{ status: 'finished', startedOn: null, finishedOn: null, rating: null, review: null }
		]);
	});

	it('never invents a read beyond what Dates Read actually gives, regardless of Read Count', () => {
		const book = bookOf({ 'Dates Read': '2024/01/05-2024/01/20', 'Read Count': '3' });
		expect(book.reads).toHaveLength(1);
	});

	it('a reversed range is skipped with a warning rather than failing the row', () => {
		const mapped = mapStorygraphRow(baseRow({ 'Dates Read': '2023/01/20-2023/01/05' }), 7);
		expect(mapped.book).not.toBeNull();
		expect(mapped.book?.reads).toEqual([]);
		expect(mapped.warnings).toEqual([
			{ row: 7, field: 'Dates Read', message: expect.stringContaining('ends before it starts') }
		]);
	});

	it('an unparsable entry is skipped with a warning, not thrown', () => {
		const mapped = mapStorygraphRow(baseRow({ 'Dates Read': 'sometime last year' }), 8);
		expect(mapped.book).not.toBeNull();
		expect(mapped.book?.reads).toEqual([]);
		expect(mapped.warnings).toEqual([{ row: 8, field: 'Dates Read', message: expect.any(String) }]);
	});

	it('currently-reading takes started_on from a range, and never a finished_on', () => {
		const book = bookOf({
			'Read Status': 'currently-reading',
			'Dates Read': '2024/01/05-2024/01/20'
		});
		expect(book.reads).toEqual([
			{ status: 'reading', startedOn: '2024-01-05', finishedOn: null, rating: null, review: null }
		]);
	});
});

describe('Star Rating', () => {
	it.each(['0', '0.25', '2.5', '4.75', '5'])('accepts the quarter-step value %s', (raw) => {
		expect(parseQuarterRating(raw)).toBe(Number(raw));
	});

	it.each(['4.3', '4.1', '-1', '5.01', 'abc'])('rejects %s', (raw) => {
		expect(parseQuarterRating(raw)).toBeNull();
	});

	it('leaves rating null with no warning when the cell is simply blank', () => {
		const mapped = mapStorygraphRow(baseRow({ 'Star Rating': '' }), 1);
		expect(mapped.book?.rating).toBeNull();
		expect(mapped.warnings).toEqual([]);
	});

	it('warns and drops an invalid rating rather than failing the row', () => {
		const mapped = mapStorygraphRow(baseRow({ 'Star Rating': '4.3' }), 2);
		expect(mapped.book).not.toBeNull();
		expect(mapped.book?.rating).toBeNull();
		expect(mapped.warnings).toEqual([
			{ row: 2, field: 'Star Rating', message: expect.any(String) }
		]);
	});
});

describe('ISBN vs UID', () => {
	it('accepts a 13-digit ISBN', () => {
		expect(parseIsbn('9780000000001')).toBe('9780000000001');
	});

	it('accepts a 10-character ISBN ending in the X check character, case-insensitively', () => {
		expect(parseIsbn('012345678X')).toBe('012345678X');
		expect(parseIsbn('012345678x')).toBe('012345678X');
	});

	it('strips hyphens and spaces before validating', () => {
		expect(parseIsbn('978-0-00-000000-1')).toBe('9780000000001');
	});

	it('rejects an opaque StoryGraph UID that is not ISBN-shaped', () => {
		expect(parseIsbn('SG-UID-0002')).toBeNull();
	});

	it('keeps the raw cell as storygraph_id even when it is not a valid ISBN', () => {
		const mapped = mapStorygraphRow(baseRow({ 'ISBN/UID': 'SG-UID-0002' }), 2);
		expect(mapped.book?.isbn).toBeNull();
		expect(mapped.book?.storygraphId).toBe('SG-UID-0002');
		expect(mapped.warnings).toEqual([{ row: 2, field: 'ISBN/UID', message: expect.any(String) }]);
	});

	it('sets both isbn and storygraph_id from a valid ISBN, with no warning', () => {
		const mapped = mapStorygraphRow(baseRow({ 'ISBN/UID': '9780000000001' }), 1);
		expect(mapped.book?.isbn).toBe('9780000000001');
		expect(mapped.book?.storygraphId).toBe('9780000000001');
		expect(mapped.warnings).toEqual([]);
	});

	it('leaves both null, with no warning, when the cell is blank', () => {
		const mapped = mapStorygraphRow(baseRow({ 'ISBN/UID': '' }), 1);
		expect(mapped.book?.isbn).toBeNull();
		expect(mapped.book?.storygraphId).toBeNull();
		expect(mapped.warnings).toEqual([]);
	});
});

describe('cleanTextArray (Authors, Moods, Tags)', () => {
	it('trims, drops blanks, and dedupes case-insensitively keeping the first spelling', () => {
		expect(cleanTextArray('Cozy, cozy , , Found Family')).toEqual(['Cozy', 'Found Family']);
	});

	it('splits Authors on commas, trimmed, in order', () => {
		expect(bookOf({ Authors: 'Fictional Author, Second Author' }).authorNames).toEqual([
			'Fictional Author',
			'Second Author'
		]);
	});

	it('maps Moods and Tags through the same rule', () => {
		const book = bookOf({ Moods: 'hopeful, Hopeful, adventurous', Tags: '' });
		expect(book.moods).toEqual(['hopeful', 'adventurous']);
		expect(book.tags).toEqual([]);
	});
});

describe('Pace', () => {
	it.each(BOOK_PACES)('accepts %s', (pace) => {
		expect(bookOf({ Pace: pace }).pace).toBe(pace);
	});

	it('is null for anything else, including blank', () => {
		expect(bookOf({ Pace: '' }).pace).toBeNull();
		expect(bookOf({ Pace: 'medium-ish' }).pace).toBeNull();
	});
});

describe('Owned?', () => {
	it('is true only for Yes, case-insensitively, and false otherwise', () => {
		expect(bookOf({ 'Owned?': 'Yes' }).owned).toBe(true);
		expect(bookOf({ 'Owned?': 'yes' }).owned).toBe(true);
		expect(bookOf({ 'Owned?': 'No' }).owned).toBe(false);
		expect(bookOf({ 'Owned?': '' }).owned).toBe(false);
	});
});

describe('content warnings', () => {
	it('joins both columns when both are present', () => {
		const book = bookOf({
			'Content Warnings': 'Violence',
			'Content Warning Description': 'Battles.'
		});
		expect(book.contentWarnings).toBe('Violence\n\nBattles.');
	});

	it('keeps whichever single column is present', () => {
		expect(
			bookOf({ 'Content Warnings': 'Grief', 'Content Warning Description': '' }).contentWarnings
		).toBe('Grief');
	});

	it('is null when both are blank', () => {
		expect(
			bookOf({ 'Content Warnings': '', 'Content Warning Description': '' }).contentWarnings
		).toBeNull();
	});
});

describe('dropped columns', () => {
	it('reads nothing from the five character questions or Contributors', () => {
		// There is no field on ParsedBook any of these could land on -- this
		// proves they are read by nothing, not merely unused by this one test.
		const withAnswers = bookOf({
			'Character- or Plot-Driven?': 'Plot',
			'Diverse Characters?': 'Yes',
			'Flawed Characters?': 'Yes',
			'Loveable Characters?': 'No',
			'Strong Character Development?': 'Yes',
			Contributors: 'Some Translator'
		});
		const withoutAnswers = bookOf({});
		expect(withAnswers).toEqual(withoutAnswers);
	});
});

describe('header shape', () => {
	// The real export's header (brief's "The CSV"): StoryGraph's own columns
	// plus three Notion added. A fresh StoryGraph export lacks the three, and
	// the importer has to accept both by matching on name, not position.
	const FULL_HEADER = [
		'Title',
		'Authors',
		'Character- or Plot-Driven?',
		'Content Warning Description',
		'Content Warnings',
		'Contributors',
		'Date Added',
		'Dates Read',
		'Diverse Characters?',
		'Flawed Characters?',
		'Format',
		'ISBN/UID',
		'Import Notes',
		'Last Date Read',
		'Loveable Characters?',
		'Matched Book',
		'Migration Status',
		'Moods',
		'Owned?',
		'Pace',
		'Read Count',
		'Read Status',
		'Review',
		'Star Rating',
		'Strong Character Development?',
		'Tags'
	];
	const NOTION_ONLY = ['Import Notes', 'Matched Book', 'Migration Status'];
	const FRESH_HEADER = FULL_HEADER.filter((h) => !NOTION_ONLY.includes(h));

	// None of these values contain a comma, so joining with one is a valid
	// CSV line with no quoting needed.
	const VALUES: Record<string, string> = {
		Title: 'The Sample Saga',
		Authors: 'Fictional Author',
		'Date Added': '2024/01/01',
		'Dates Read': '2024/01/05-2024/01/20',
		Format: 'digital',
		'ISBN/UID': '9780000000001',
		'Owned?': 'Yes',
		Pace: 'medium',
		'Read Status': 'read',
		'Star Rating': '4.25'
	};
	const csvOf = (header: string[]) =>
		`${header.join(',')}\n${header.map((h) => VALUES[h] ?? '').join(',')}\n`;

	it('maps identically whether or not Notion added its own three columns', () => {
		const withNotion = mapStorygraphRow(parseCsvTable(csvOf(FULL_HEADER)).rows[0]!, 1);
		const fresh = mapStorygraphRow(parseCsvTable(csvOf(FRESH_HEADER)).rows[0]!, 1);
		expect(withNotion.book).toEqual(fresh.book);
		expect(withNotion.warnings).toEqual(fresh.warnings);
	});
});
