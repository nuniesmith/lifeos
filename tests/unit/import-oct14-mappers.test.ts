import { describe, expect, it } from 'vitest';
import { documentKind } from '$lib/server/import/mappers/life-admin';
import {
	audience,
	chilliCount,
	cleanIsbn,
	quarterStars,
	readingFormat
} from '$lib/server/import/mappers/reading';
import { routineVersion, timeOfDay } from '$lib/server/import/mappers/routines';
import { linkedPageIds, names, type StagedRow } from '$lib/server/import/mappers/shared';
import { monthStart } from '$lib/server/import/promote';

const row = (raw: Record<string, string>): StagedRow => ({
	id: 'r',
	notion_page_id: null,
	database_name: 'x',
	database_notion_id: null,
	title: null,
	raw,
	body: null
});

describe('mappers first used for the 2026-10-14 export', () => {
	it('reads relation cells as names and as page ids, URL-encoded or not', () => {
		const r = row({
			Authors:
				'Jeanette Rose (Author%20Database/Jeanette%20Rose%203d7879a556f18095811ed9f3ec8041f4.md), Alexis Rune (Author%20Database/Alexis%20Rune%203d7879a556f180aa811ed9f3ec8041f4.md)'
		});
		expect(names(r, 'Authors')).toEqual(['Jeanette Rose', 'Alexis Rune']);
		// The %20 before an id must not be read as the id's first two digits.
		expect(linkedPageIds(r, 'Authors')).toEqual([
			'3d7879a5-56f1-8095-811e-d9f3ec8041f4',
			'3d7879a5-56f1-80aa-811e-d9f3ec8041f4'
		]);
		expect(names(row({ Tags: 'Witches, Fae, witches' }), 'Tags')).toEqual(['Witches', 'Fae']);
	});

	it('maps the book vocabulary onto the schema', () => {
		expect(readingFormat('eBook')).toBe('ebook');
		expect(readingFormat('Audiobook')).toBe('audiobook');
		expect(readingFormat('Paperback')).toBe('print');
		expect(audience('New Adult')).toBe('adult');
		expect(audience('Young Adult')).toBe('young_adult');
		expect(quarterStars(4.4)).toBe(4.5);
		expect(quarterStars(6)).toBeNull();
		expect(chilliCount('🌶️🌶️')).toBe(2);
		expect(chilliCount('')).toBeNull();
		expect(cleanIsbn('978-1-63557-404-3')).toBe('9781635574043');
		expect(cleanIsbn('B0ABCDEF12')).toBeNull();
	});

	it('names a record by what it is before the shelf it is filed on', () => {
		expect(documentKind('ID & License', 'Birth Certificate')).toBe('certificate');
		expect(documentKind(null, "Driver's License")).toBe('licence');
		expect(documentKind(null, 'Vehicle Title')).toBe('registration');
		expect(documentKind(null, 'Passport')).toBe('id');
		expect(documentKind('ID & License', 'Something')).toBe('licence');
		expect(documentKind(null, 'Gym')).toBe('other');
	});

	it('reads routine times and versions', () => {
		expect(timeOfDay('Morning Routine')).toBe('morning');
		expect(timeOfDay('Bedtime Routine')).toBe('evening');
		expect(timeOfDay('Daily Reset')).toBe('anytime');
		expect(routineVersion('☀️ High Energy')).toBe('high');
		expect(routineVersion('🌱 1%')).toBe('minimal');
		expect(routineVersion('🌤️ Average')).toBe('average');
	});

	it('places a month relation on its first day', () => {
		expect(monthStart('July 2026 (Time%20Databases/Months%20Database/July%202026%20abc.md)')).toBe(
			'2026-07-01'
		);
		expect(monthStart('Someday 2026')).toBeNull();
		expect(monthStart(undefined)).toBeNull();
	});
});
