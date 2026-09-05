import { describe, expect, it } from 'vitest';
import {
	extractChecklist,
	extractImages,
	extractPageLinks,
	parseMarkdownPage
} from '$lib/server/import/markdown';
import { propertyAgreement } from '$lib/server/import/run';

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
