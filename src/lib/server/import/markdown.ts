import { parseRelationCell, type RelationRef } from './csv.ts';

/**
 * Markdown page parsing (IMP-004).
 *
 * Each exported page is `# Title`, then a block of `Key: Value` property lines,
 * then the page body. The CSVs carry the properties but not the body, so this
 * is the only source for notes, nested checklists, and rich content.
 *
 * The property block is where the parsing has to be careful. It runs from the
 * title to the first blank line, and only when the first line is itself a
 * property — Notion always emits properties first, so anything else means the
 * page has none. Within the block a `Key: value` line starts a property and any
 * other line continues the one above it, because property values can span
 * lines. Terminating at "the first line that is not a property" instead put the
 * remaining properties into the body of 200 pages.
 */

export interface MarkdownPage {
	title: string;
	/** Property lines in order, values exactly as written. */
	properties: Record<string, string>;
	/** Everything after the property block, with leading blank lines removed. */
	body: string;
	/** Relation references found in the property block. */
	relations: { property: string; refs: RelationRef[] }[];
	/** Local asset paths referenced by image syntax. */
	images: string[];
	/** Internal page links found in the body, by Notion id. */
	pageLinks: string[];
}

const NOTION_ID = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/;

/**
 * A property line is `Key: value` where the key has no markdown syntax in it.
 * Requiring the key to be short and punctuation-free keeps ordinary prose from
 * being swallowed into the property block.
 */
const PROPERTY_LINE = /^([A-Za-z][A-Za-z0-9 '&/?()-]{0,60}?):[ \t](.*)$/;

/**
 * @param knownProperties Column names from the database's CSV header. When
 * supplied, only those keys start a property, which removes the one genuine
 * ambiguity in this format: a body line like `Note: buy milk` is
 * indistinguishable from a property without knowing the schema. Callers that
 * have the header should always pass it.
 */
export function parseMarkdownPage(
	source: string,
	knownProperties?: Iterable<string>
): MarkdownPage {
	const known = knownProperties ? new Set([...knownProperties].map((k) => k.trim())) : null;
	const isKnown = (key: string) => known === null || known.has(key);
	const lines = source.replace(/\r\n?/g, '\n').split('\n');

	let index = 0;
	let title = '';

	// Leading blank lines, then the H1.
	while (index < lines.length && lines[index]!.trim() === '') index++;
	if (index < lines.length && lines[index]!.startsWith('# ')) {
		title = lines[index]!.slice(2).trim();
		index++;
	}
	while (index < lines.length && lines[index]!.trim() === '') index++;

	// Property block: everything up to the first blank line, but only when the
	// first line is actually a property. Notion always emits properties before
	// the body, so a non-property first line means the page simply has none.
	//
	// The terminator is the blank line, not "the first line that is not a
	// property". A property value can span lines — an Area Report renders as
	// two — and stopping at the first continuation line dumped the remaining
	// properties into the body of 200 pages.
	const properties: Record<string, string> = {};
	const firstMatch = index < lines.length ? PROPERTY_LINE.exec(lines[index]!) : null;
	if (firstMatch && isKnown(firstMatch[1]!.trim())) {
		let currentKey: string | null = null;
		while (index < lines.length) {
			const line = lines[index]!;
			if (line.trim() === '') break;

			const match = PROPERTY_LINE.exec(line);
			if (match && isKnown(match[1]!.trim())) {
				currentKey = match[1]!.trim();
				if (!(currentKey in properties)) properties[currentKey] = (match[2] ?? '').trim();
			} else if (currentKey) {
				// A continuation of the value above.
				properties[currentKey] = `${properties[currentKey]}\n${line.trim()}`.trim();
			}
			index++;
		}
		// Skip the blank line that ended the block.
		while (index < lines.length && lines[index]!.trim() === '') index++;
	}

	const body = lines
		.slice(index)
		.join('\n')
		.replace(/^\s*(?:---\s*)?\n?/, '')
		.trim();

	const relations = Object.entries(properties)
		.map(([property, value]) => ({ property, refs: parseRelationCell(value) }))
		.filter((entry) => entry.refs.length > 0);

	return {
		title,
		properties,
		body,
		relations,
		images: extractImages(body),
		pageLinks: extractPageLinks(body)
	};
}

/** Local image paths, ignoring anything hosted elsewhere. */
export function extractImages(markdown: string): string[] {
	const out: string[] = [];
	const pattern = /!\[[^\]]*\]\(([^)]+)\)/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(markdown)) !== null) {
		const raw = match[1]!;
		if (/^https?:/i.test(raw)) continue;
		try {
			out.push(decodeURIComponent(raw));
		} catch {
			out.push(raw);
		}
	}
	return out;
}

/** Notion ids of internal page links in the body. */
export function extractPageLinks(markdown: string): string[] {
	const out = new Set<string>();
	// Deliberately not the image syntax: a `![...](...)` is an asset, not a link.
	const pattern = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(markdown)) !== null) {
		const raw = match[1]!;
		if (/^https?:/i.test(raw)) continue;
		let decoded = raw;
		try {
			decoded = decodeURIComponent(raw);
		} catch {
			// keep the encoded form
		}
		const id = NOTION_ID.exec(decoded)?.[0];
		if (id) out.add(id);
	}
	return [...out];
}

/**
 * Nested task lists, preserved with their depth.
 *
 * Notion writes sub-tasks as indented checkboxes, and flattening them would
 * lose the structure the household actually uses.
 */
export interface ChecklistItem {
	text: string;
	checked: boolean;
	depth: number;
}

export function extractChecklist(markdown: string): ChecklistItem[] {
	const items: ChecklistItem[] = [];
	for (const line of markdown.split('\n')) {
		const match = /^(\s*)[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(line);
		if (!match) continue;
		items.push({
			// Two spaces per level is what the export uses; tabs count as one level.
			depth: Math.floor(match[1]!.replace(/\t/g, '  ').length / 2),
			checked: match[2]!.toLowerCase() === 'x',
			text: match[3]!.trim()
		});
	}
	return items;
}
