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
 *
 * When the database's columns are known, a blank line does not end the block
 * if another of those properties is still to come: formula displays render as
 * several paragraphs INSIDE one value (see parseMarkdownPage).
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
 * Lines that can only be page body, never part of a property value: an image,
 * a link line, an HTML block (`<aside>`), a heading, a table, a quote or a
 * code fence. Formula displays are plain text, so meeting one of these while
 * looking ahead means the property block is over.
 */
const BODY_ONLY_LINE = /^\s*(?:!\[|\[|<|#|\||>|```)/;

/** Whitespace-insensitive form, for comparing the page's text with the CSV's. */
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * @param knownProperties Column names from the database's CSV header. When
 * supplied, only those keys start a property, which removes the one genuine
 * ambiguity in this format: a body line like `Note: buy milk` is
 * indistinguishable from a property without knowing the schema. Callers that
 * have the header should always pass it.
 * @param rowValues The page's CSV row, when known. Lets the final
 * multi-paragraph property keep its closing paragraphs (see valueContinues).
 */
export function parseMarkdownPage(
	source: string,
	knownProperties?: Iterable<string>,
	rowValues?: Record<string, string>
): MarkdownPage {
	const known = knownProperties
		? [...new Set([...knownProperties].map((k) => k.trim()))].filter(Boolean)
		: null;
	const lines = source.replace(/\r\n?/g, '\n').split('\n');

	/** The property a line starts, if it starts one. */
	const propertyOf = (line: string): { key: string; value: string } | null => {
		if (known) {
			// With the schema in hand, match the column names themselves: the
			// generic pattern cannot express a key like "Log ☀️ High Energy
			// Version", and a line starts one of these keys or none. Whitespace
			// before the colon is allowed because Notion keeps a column's
			// trailing space ("Physical Symptoms : …"). Requiring the colon
			// straight after the key is what keeps "Symptom Impact Score: 2"
			// from reading as a value of "Symptom Impact", whatever the order.
			for (const key of known) {
				if (!line.startsWith(key)) continue;
				const rest = /^\s*:(?:[ \t](.*))?$/.exec(line.slice(key.length));
				if (rest) return { key, value: rest[1] ?? '' };
			}
			return null;
		}
		const match = PROPERTY_LINE.exec(line);
		return match ? { key: match[1]!.trim(), value: match[2] ?? '' } : null;
	};

	/**
	 * Whether a property not yet read follows `from` before anything that can
	 * only be body. Formula displays render as several paragraphs inside ONE
	 * value -- the 2026-09-24 Daily Log has four ("Daily Check In", "Daily
	 * Health Snapshot", "Medication Summary", "Nutrition Summary") -- and ending
	 * the block at their first blank line poured every later property into the
	 * body: ~60 lines per day, 1,494 across 25 days of notes. Only asked when
	 * the columns are known, since only then is "a property" unambiguous.
	 */
	const propertyAhead = (from: number, seen: Map<string, string[]>): boolean => {
		for (let i = from; i < lines.length; i++) {
			const line = lines[i]!;
			if (line.trim() === '') continue;
			// A known key first: a column really is called "# of Servings", and
			// read as a heading it would end the block one property early.
			const found = propertyOf(line);
			if (found && !seen.has(found.key)) return true;
			if (BODY_ONLY_LINE.test(line)) return false;
		}
		return false;
	};

	/**
	 * Whether the paragraph at `from` is still the value of `key`, judged
	 * against the CSV's copy of that value. propertyAhead cannot settle the
	 * LAST multi-paragraph property -- nothing follows it to prove the block
	 * goes on -- so without this its closing paragraphs ("🛒 STILL NEED" on a
	 * meal plan) became body. The CSV holds each formula's full text, so the
	 * page text is still the value exactly while it remains a prefix of it.
	 */
	const valueContinues = (from: number, key: string, sofar: string[]): boolean => {
		const whole = rowValues?.[key];
		if (!whole) return false;
		const next: string[] = [];
		for (let i = from; i < lines.length && lines[i]!.trim() !== ''; i++) next.push(lines[i]!);
		if (next.length === 0) return false;
		return squash(whole).startsWith(squash([...sofar, ...next].join('\n')));
	};

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
	if (index < lines.length && propertyOf(lines[index]!)) {
		const values = new Map<string, string[]>();
		let currentKey: string | null = null;
		while (index < lines.length) {
			const line = lines[index]!;
			if (line.trim() === '') {
				// The blank line ends the block, unless the columns are known and
				// one of them is still to come, or the CSV shows the value goes
				// on -- then it is a paragraph break inside the current value.
				if (
					!known ||
					!currentKey ||
					!(
						propertyAhead(index + 1, values) ||
						valueContinues(index + 1, currentKey, values.get(currentKey)!)
					)
				) {
					break;
				}
				values.get(currentKey)!.push('');
				index++;
				continue;
			}

			const found = propertyOf(line);
			// Notion emits each property once, so a key already read is text
			// inside the current value, not a second copy of that property.
			if (found && !values.has(found.key)) {
				currentKey = found.key;
				values.set(currentKey, [found.value.trim()]);
			} else if (currentKey) {
				// A continuation of the value above.
				values.get(currentKey)!.push(line.trim());
			}
			index++;
		}
		for (const [key, parts] of values) properties[key] = parts.join('\n').trim();
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

/**
 * Extracts `[text](target)` pairs, tracking parenthesis depth in the target.
 *
 * A regex that stops at the first `)` is wrong here for the same reason it was
 * wrong for relation cells: filenames contain parentheses. Notion exports
 * assets like `ChatGPT_Image_..._(2).png`, and truncating at the inner bracket
 * produced a path that matches nothing.
 */
function extractLinks(markdown: string, wantImages: boolean): string[] {
	const out: string[] = [];
	let i = 0;

	while (i < markdown.length) {
		const open = markdown.indexOf('[', i);
		if (open === -1) break;

		const isImage = open > 0 && markdown[open - 1] === '!';
		const close = markdown.indexOf(']', open);
		if (close === -1) break;
		if (markdown[close + 1] !== '(') {
			i = close + 1;
			continue;
		}

		let depth = 0;
		let j = close + 1;
		for (; j < markdown.length; j++) {
			if (markdown[j] === '(') depth++;
			else if (markdown[j] === ')') {
				depth--;
				if (depth === 0) break;
			}
		}
		if (depth !== 0) break;

		if (isImage === wantImages) {
			// A target containing spaces may be wrapped in angle brackets.
			const target = markdown.slice(close + 2, j).replace(/^<(.*)>$/s, '$1');
			if (!/^https?:/i.test(target)) {
				try {
					out.push(decodeURIComponent(target));
				} catch {
					out.push(target);
				}
			}
		}
		i = j + 1;
	}

	return out;
}

/** Local image paths, ignoring anything hosted elsewhere. */
export function extractImages(markdown: string): string[] {
	return extractLinks(markdown, true);
}

/** Notion ids of internal page links in the body. */
export function extractPageLinks(markdown: string): string[] {
	const out = new Set<string>();
	for (const target of extractLinks(markdown, false)) {
		const id = NOTION_ID.exec(target)?.[0];
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
