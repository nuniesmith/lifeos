import { describe, expect, it } from 'vitest';
import {
	extractChecklist,
	extractImages,
	extractPageLinks,
	parseMarkdownPage
} from '$lib/server/import/markdown';
import { pickByAgreement, propertyAgreement } from '$lib/server/import/run';

// The shape Notion actually exports, taken from a real page.
const PAGE = `# Reorganize bedside table

Status: To Do
Do Date: August 30, 2026
Important: Yes
Project: Project Example (../Projects%20Database/Project%20Example%203ad879a556f180d4a3d2f10c60ff8fd9.md)

Some body text that mentions a ratio: 3 to 1.

- [x] Buy risers
- [ ] Get measurements
  - [ ] Measure the wall

![photo.png](Life%20OS/photo.png)
[Another page](Life%20OS/Other%20Page%203ad879a556f180c1ac15d106e1e07e2c.md)
[External](https://example.com/thing)
`;

describe('page parsing', () => {
	const page = parseMarkdownPage(PAGE);

	it('reads the title from the H1', () => {
		expect(page.title).toBe('Reorganize bedside table');
	});

	it('reads the property block', () => {
		expect(page.properties['Status']).toBe('To Do');
		expect(page.properties['Important']).toBe('Yes');
	});

	it('stops the property block at the body', () => {
		// "a ratio: 3 to 1" is prose, not a property. Scanning the whole file
		// for `Key: value` would swallow it.
		expect(page.properties).not.toHaveProperty('Some body text that mentions a ratio');
		expect(Object.keys(page.properties)).toHaveLength(4);
	});

	it('keeps the body separate from the properties', () => {
		expect(page.body).toContain('Some body text');
		expect(page.body).not.toContain('Status: To Do');
	});

	it('finds relations inside properties', () => {
		expect(page.relations).toHaveLength(1);
		expect(page.relations[0]!.property).toBe('Project');
		expect(page.relations[0]!.refs[0]!.notionId).toBe('3ad879a556f180d4a3d2f10c60ff8fd9');
	});

	it('handles a page with no properties at all', () => {
		const plain = parseMarkdownPage('# Just a title\n\nJust prose.\n');
		expect(plain.properties).toEqual({});
		expect(plain.body).toBe('Just prose.');
	});
});

describe('assets and links', () => {
	it('collects local images and decodes their paths', () => {
		expect(extractImages(PAGE)).toEqual(['Life OS/photo.png']);
	});

	it('ignores remote images', () => {
		expect(extractImages('![x](https://example.com/a.png)')).toEqual([]);
	});

	it('collects internal page links but not images or external URLs', () => {
		const links = extractPageLinks(PAGE);
		expect(links).toEqual(['3ad879a556f180c1ac15d106e1e07e2c']);
	});
});

describe('checklists', () => {
	it('preserves nesting depth and checked state', () => {
		expect(extractChecklist(PAGE)).toEqual([
			{ text: 'Buy risers', checked: true, depth: 0 },
			{ text: 'Get measurements', checked: false, depth: 0 },
			{ text: 'Measure the wall', checked: false, depth: 1 }
		]);
	});
});

describe('property agreement', () => {
	const row = { Status: 'Use up!', Note: 'line one\nline two', Rel: 'X (a/b%20c.md)' };

	it('scores exact matches', () => {
		expect(propertyAgreement(row, { Status: 'Use up!' })).toBe(1);
	});

	it('treats a truncated multi-line value as agreement', () => {
		// The markdown property block cannot span lines, so it holds only the
		// first line of a multi-line CSV value.
		expect(propertyAgreement(row, { Note: 'line one' })).toBe(1);
	});

	it('ignores relation cells, which encode paths differently', () => {
		expect(propertyAgreement(row, { Rel: 'X (../a/b%20c.md)' })).toBe(0);
	});

	it('separates two same-titled rows by their differing values', () => {
		// This is the case that was silently swapping pages: two rows share a
		// title and only a property tells them apart.
		const a = { Status: "❌ Don't Need" };
		const b = { Status: '⚡️ Use up!' };
		expect(propertyAgreement(a, { Status: "❌ Don't Need" })).toBeGreaterThan(
			propertyAgreement(a, { Status: '⚡️ Use up!' })
		);
		expect(propertyAgreement(b, { Status: '⚡️ Use up!' })).toBeGreaterThan(
			propertyAgreement(b, { Status: "❌ Don't Need" })
		);
	});
});

describe('multi-line property values', () => {
	// An Area Report renders across two lines. Ending the property block at the
	// first continuation line pushed every property after it into the body.
	const page = parseMarkdownPage(
		[
			'# Relationship & Connection',
			'',
			'Area Report: 🌿 Quiet right now',
			'↻ Review current · Sep 13',
			'Archive: No',
			'Review Every: Month',
			'',
			'🌿 **This Part of Life**',
			'',
			'Real body prose.'
		].join('\n')
	);

	it('keeps a continuation line with its property', () => {
		expect(page.properties['Area Report']).toBe('🌿 Quiet right now\n↻ Review current · Sep 13');
	});

	it('still reads the properties that follow the multi-line one', () => {
		expect(page.properties['Archive']).toBe('No');
		expect(page.properties['Review Every']).toBe('Month');
	});

	it('does not leak any property into the body', () => {
		expect(page.body).not.toContain('Archive: No');
		expect(page.body).not.toContain('Review Every');
		expect(page.body.startsWith('🌿 **This Part of Life**')).toBe(true);
	});

	it('uses the known column names to tell a property from prose', () => {
		// `Just prose: with a colon.` is indistinguishable from a property on
		// its own. The importer knows the database's columns, so it passes them.
		const src = '# Title\n\nJust prose: with a colon.\n\nMore.';
		expect(parseMarkdownPage(src, ['Status', 'Archive']).properties).toEqual({});
		expect(parseMarkdownPage(src, ['Status', 'Archive']).body).toContain('Just prose:');
	});

	it('still parses real properties when the columns are supplied', () => {
		const src = '# T\n\nStatus: To Do\nArchive: No\n\nBody.';
		const parsed = parseMarkdownPage(src, ['Status', 'Archive']);
		expect(parsed.properties).toEqual({ Status: 'To Do', Archive: 'No' });
		expect(parsed.body).toBe('Body.');
	});
});

describe('targets containing parentheses', () => {
	it('keeps a filename with parentheses intact', () => {
		// Notion exports assets like ChatGPT_Image_..._(2).png. Stopping at the
		// first ')' produced a path that matched nothing — the same mistake as
		// the relation-cell parser made.
		const md = '![img](Recipe%20Library/ChatGPT_Image_(2).png)';
		expect(extractImages(md)).toEqual(['Recipe Library/ChatGPT_Image_(2).png']);
	});

	it('handles several such images in one body', () => {
		const md = '![a](x/a_(1).png)\n![b](x/b_(2).png)';
		expect(extractImages(md)).toEqual(['x/a_(1).png', 'x/b_(2).png']);
	});

	it('still separates images from page links', () => {
		const md = '![a](x/a_(1).png)\n[p](y/Page%20aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.md)';
		expect(extractImages(md)).toEqual(['x/a_(1).png']);
		expect(extractPageLinks(md)).toEqual(['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
	});
});

describe('angle-bracket targets', () => {
	it('unwraps a target wrapped in <>', () => {
		// Markdown allows this for targets containing spaces, and formatters
		// rewrite plain targets into this form.
		expect(extractImages('![a](<x/my file_(1).png>)')).toEqual(['x/my file_(1).png']);
	});
});

describe('property values that contain blank lines', () => {
	// The shape of a Daily Log page from the 2026-09-24 export, values invented.
	// Formula displays render as several paragraphs INSIDE one value; ending the
	// block at their first blank line poured every later property -- and about
	// sixty lines a day of formula text -- into the body, and so into the note.
	const columns = [
		'Date',
		'Daily Check In',
		'Daily Health Snapshot',
		'Symptom Impact',
		'Symptom Impact Score',
		'Weekly Movement'
	];
	const src = [
		'# Wednesday, @Yesterday',
		'',
		'Date: September 23, 2026',
		"Daily Check In: 🌡️ TODAY'S CHECK-IN",
		'',
		'💛 MOOD',
		'Content',
		'',
		'🩺 SYMPTOMS',
		'Impact: Disruptive',
		'Daily Health Snapshot: ❤️ HEALTH AT A GLANCE',
		'',
		'💗 HEART RATE',
		'No reading logged',
		'Symptom Impact: Disruptive',
		'Symptom Impact Score: 2',
		'Weekly Movement: 0',
		'',
		'![photo.png](Wednesday/photo.png)',
		'',
		'Real journal text.'
	].join('\n');
	const page = parseMarkdownPage(src, columns);

	it('reads every property, including those after a multi-paragraph value', () => {
		expect(Object.keys(page.properties)).toEqual(columns);
	});

	it('keeps the paragraphs inside the value they belong to', () => {
		expect(page.properties['Daily Check In']).toBe(
			"🌡️ TODAY'S CHECK-IN\n\n💛 MOOD\nContent\n\n🩺 SYMPTOMS\nImpact: Disruptive"
		);
	});

	it('does not read "Symptom Impact Score" as a value of "Symptom Impact"', () => {
		expect(page.properties['Symptom Impact']).toBe('Disruptive');
		expect(page.properties['Symptom Impact Score']).toBe('2');
	});

	it('starts the body where the body starts', () => {
		expect(page.body.startsWith('![photo.png]')).toBe(true);
		expect(page.body).not.toContain('MOOD');
		expect(page.body).toContain('Real journal text.');
	});

	it('still ends at the first blank line when the columns are not known', () => {
		const bare = parseMarkdownPage(src);
		expect(Object.keys(bare.properties)).toEqual(['Date', 'Daily Check In']);
		expect(bare.body).toContain('Symptom Impact: Disruptive');
	});

	it('does not swallow a body line that happens to look like an unread property', () => {
		const p = parseMarkdownPage(
			['# T', '', 'Status: To Do', '', '![img.png](T/img.png)', '', 'Archive: typed by hand'].join(
				'\n'
			),
			['Status', 'Archive']
		);
		expect(p.properties).toEqual({ Status: 'To Do' });
		expect(p.body).toContain('Archive: typed by hand');
	});

	it('recognises column names the generic pattern cannot express', () => {
		const p = parseMarkdownPage(
			['# Morning', '', 'Log ☀️ High Energy Version: Yes', '# of Servings: 4', '', 'Body.'].join(
				'\n'
			),
			['Log ☀️ High Energy Version', '# of Servings']
		);
		expect(p.properties).toEqual({ 'Log ☀️ High Energy Version': 'Yes', '# of Servings': '4' });
		expect(p.body).toBe('Body.');
	});

	it('reads a column whose name ends in a space', () => {
		const p = parseMarkdownPage('# D\n\nPhysical Symptoms : Joint pain\n\nBody.', [
			'Physical Symptoms '
		]);
		expect(p.properties).toEqual({ 'Physical Symptoms': 'Joint pain' });
	});

	it("keeps the last value's closing paragraphs when the CSV row says they are its", () => {
		// Nothing follows the last property to prove the block goes on, so only
		// the CSV's copy of the value can tell its paragraphs from the body.
		const row = {
			Date: 'September 1, 2026',
			'Plan Details Display': '🥕 INGREDIENTS\nNone\n\n🛒 STILL NEED\nNothing to buy'
		};
		const meal = [
			'# Plan',
			'',
			'Date: September 1, 2026',
			'Plan Details Display: 🥕 INGREDIENTS',
			'None',
			'',
			'🛒 STILL NEED',
			'Nothing to buy',
			'',
			'Real notes.'
		].join('\n');
		const withRow = parseMarkdownPage(meal, Object.keys(row), row);
		expect(withRow.properties['Plan Details Display']).toBe(row['Plan Details Display']);
		expect(withRow.body).toBe('Real notes.');

		// Without the row that paragraph cannot be placed, and lands in the body.
		expect(parseMarkdownPage(meal, Object.keys(row)).body).toContain('🛒 STILL NEED');
	});
});

describe('matching a row to a page by its properties', () => {
	const row = {
		Day: 'Tuesday, @September 22, 2026',
		Date: 'September 22, 2026',
		Caffeine: 'No',
		Intimacy: 'No'
	};

	it('picks the page that clearly agrees best', () => {
		const pages = new Map([
			['tuesday', { Date: 'September 22, 2026', Caffeine: 'No', Intimacy: 'No' }],
			['wednesday', { Date: 'September 23, 2026', Caffeine: 'No', Intimacy: 'No' }]
		]);
		expect(pickByAgreement(row, pages)).toBe('tuesday');
	});

	it('refuses a tie rather than guess', () => {
		const pages = new Map([
			['a', { Caffeine: 'No', Intimacy: 'No' }],
			['b', { Caffeine: 'No', Intimacy: 'No' }]
		]);
		expect(pickByAgreement(row, pages)).toBeNull();
	});

	it('refuses a thin match', () => {
		expect(pickByAgreement(row, new Map([['a', { Caffeine: 'No' }]]))).toBeNull();
	});

	it('refuses when there is nothing to choose from', () => {
		expect(pickByAgreement(row, new Map())).toBeNull();
	});
});
