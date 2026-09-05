import { describe, expect, it } from 'vitest';
import {
	notionIdFromFilename,
	notionIdToUuid,
	parseCsv,
	parseCsvTable,
	parseRelationCell,
	parseSourceBoolean,
	parseSourceDate,
	stripBom
} from '$lib/server/import/csv';

describe('BOM handling', () => {
	it('strips the BOM every first column in this export carries', () => {
		// Without this the title column of all 36 databases is unfindable.
		const { headers } = parseCsvTable('﻿Task,Status\nWrite tests,To Do\n');
		expect(headers[0]).toBe('Task');
	});

	it('leaves text without a BOM alone', () => {
		expect(stripBom('Task')).toBe('Task');
	});
});

describe('CSV parsing', () => {
	it('keeps commas inside quoted fields', () => {
		const rows = parseCsv('a,b\n"Andrea Hunt, NP",x\n');
		expect(rows[1]).toEqual(['Andrea Hunt, NP', 'x']);
	});

	it('keeps newlines inside quoted fields', () => {
		// Goals is 46 physical lines and 5 rows; line counting cannot work.
		const rows = parseCsv('a,b\n"line one\nline two",x\n');
		expect(rows).toHaveLength(2);
		expect(rows[1]![0]).toBe('line one\nline two');
	});

	it('unescapes doubled quotes', () => {
		expect(parseCsv('a\n"He said ""hi"""\n')[1]![0]).toBe('He said "hi"');
	});

	it('handles CRLF and a bare CR', () => {
		expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
			['a', 'b'],
			['1', '2']
		]);
	});

	it('does not invent a trailing empty row', () => {
		expect(parseCsv('a,b\n1,2\n')).toHaveLength(2);
	});

	it('preserves empty fields rather than collapsing them', () => {
		expect(parseCsv('a,b,c\n1,,3\n')[1]).toEqual(['1', '', '3']);
	});
});

describe('relation cells', () => {
	const cell =
		'Sweet Potato (Ingredients%20Database/Sweet%20Potato%203c8879a556f1803b8f0df37147b3aae7.csv), ' +
		'Ground Beef (Ingredients%20Database/Ground%20Beef%203c8879a556f18005a5f4cf8e77c57133.csv)';

	it('parses every reference in a multi-valued cell', () => {
		const refs = parseRelationCell(cell);
		expect(refs.map((r) => r.title)).toEqual(['Sweet Potato', 'Ground Beef']);
		expect(refs[0]!.notionId).toBe('3c8879a556f1803b8f0df37147b3aae7');
	});

	it('percent-decodes the path for provenance', () => {
		expect(parseRelationCell(cell)[0]!.path).toContain('Ingredients Database/Sweet Potato');
	});

	it('survives a comma inside a title', () => {
		// Splitting on ", " would produce two broken halves here.
		const refs = parseRelationCell(
			'Andrea Hunt, NP (People%20Database/Andrea%20Hunt%203c8879a556f1803b8f0df37147b3aae7.csv)'
		);
		expect(refs).toHaveLength(1);
		expect(refs[0]!.title).toBe('Andrea Hunt, NP');
	});

	it('survives commas in titles across several references', () => {
		const refs = parseRelationCell(
			'@August 9, 2026 (Dates/A%20aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.csv), ' +
				'@August 10, 2026 (Dates/B%20bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.csv)'
		);
		expect(refs.map((r) => r.notionId)).toEqual([
			'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
		]);
		expect(refs[1]!.title).toBe('@August 10, 2026');
	});

	it('ignores a parenthetical that is not a relation', () => {
		expect(parseRelationCell('Buy milk (the good kind)')).toEqual([]);
		expect(parseRelationCell('')).toEqual([]);
		expect(parseRelationCell('no parens at all')).toEqual([]);
	});
});

describe('Notion identifiers', () => {
	it('converts a 32-hex id to UUID form', () => {
		expect(notionIdToUuid('3c8879a556f1803b8f0df37147b3aae7')).toBe(
			'3c8879a5-56f1-803b-8f0d-f37147b3aae7'
		);
	});

	it('refuses anything that is not an id', () => {
		expect(() => notionIdToUuid('nope')).toThrow(TypeError);
	});

	it('extracts an id from an export filename', () => {
		expect(notionIdFromFilename('Tasks Database 3ad879a556f180c1ac15d106e1e07e2c_all.csv')).toBe(
			'3ad879a556f180c1ac15d106e1e07e2c'
		);
		expect(notionIdFromFilename('README.md')).toBeNull();
	});
});

describe('scalar values', () => {
	it('parses the date formats this export actually uses', () => {
		expect(parseSourceDate('August 31, 2026')).toEqual({ date: '2026-08-31', hasTime: false });
		expect(parseSourceDate('July 30, 2026 2:57 PM')).toEqual({
			date: '2026-07-30',
			hasTime: true
		});
	});

	it('returns null for an empty or unparseable date', () => {
		expect(parseSourceDate('')).toBeNull();
		expect(parseSourceDate('sometime next week')).toBeNull();
	});

	it('reads Notion Yes/No checkboxes', () => {
		expect(parseSourceBoolean('Yes')).toBe(true);
		expect(parseSourceBoolean('No')).toBe(false);
		expect(parseSourceBoolean('')).toBeNull();
	});
});

describe('paths containing parentheses', () => {
	it('parses a relation whose path has its own parentheses', () => {
		// "Tags & Topics (Resources) Database" is a real path in this export.
		// Matching to the first ')' silently dropped all 19 such cells.
		const refs = parseRelationCell(
			'Organization (Life%20OS/System/Tags%20%26%20Topics%20(Resources)%20Database/' +
				'Organization%203c3879a556f18037b1d4e00000000000.csv)'
		);
		expect(refs).toHaveLength(1);
		expect(refs[0]!.title).toBe('Organization');
		expect(refs[0]!.notionId).toBe('3c3879a556f18037b1d4e00000000000');
		expect(refs[0]!.path).toContain('Tags & Topics (Resources) Database');
	});

	it('still parses several such relations in one cell', () => {
		const one = 'A (X/Tags%20(Resources)/A%20aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.csv)';
		const two = 'B (X/Tags%20(Resources)/B%20bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.csv)';
		const refs = parseRelationCell(`${one}, ${two}`);
		expect(refs.map((r) => r.title)).toEqual(['A', 'B']);
	});

	it('stops rather than guessing on an unbalanced parenthesis', () => {
		expect(parseRelationCell('A (X/unclosed%20aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.csv')).toEqual([]);
	});
});
