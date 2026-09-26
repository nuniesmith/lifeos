import DOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { Marked } from 'marked';

/**
 * Markdown to HTML that is safe to put on a page.
 *
 * Every record the importer promotes carries its Notion page body as Markdown,
 * and Markdown is a superset of HTML: a body can hold a `<script>`, an
 * `<img onerror>`, a `javascript:` link, or anything else someone pasted into
 * Notion. None of that was written by this application, and some of it may not
 * have been written by the household either — a recipe copied off a website
 * brings the website's markup with it. So nothing here trusts the source.
 *
 * Three stages, each with one job:
 *
 *  1. `marked` turns Markdown into HTML. It does not sanitize — it passes raw
 *     HTML and `javascript:` hrefs straight through — and is not asked to.
 *  2. DOMPurify, over a jsdom window, removes everything not on an explicit
 *     allowlist: no scripts, no event handlers, no styles, no forms, no frames,
 *     no SVG or MathML (their namespaces are refused outright, which is what
 *     closes the namespace-confusion family of mutation XSS).
 *  3. A pass over the sanitized tree applies this application's own policy,
 *     which is narrower than DOMPurify's: a link survives only if it parses as
 *     http(s), mailto or tel; an image survives only if it resolves to an
 *     attachment this household holds, and is then pointed at `/api/media`
 *     rather than at whatever the body said. Nothing this stage writes is taken
 *     from the source except text DOMPurify has already accepted.
 *
 * It runs on the server, once per render, and the page receives the finished
 * string. The client never sees the Markdown through this path and never runs
 * a sanitizer of its own, so there is one implementation to get right.
 */

/** A stored image a body reference resolves to. */
export interface MarkdownImage {
	id: string;
	width: number | null;
	height: number | null;
}

export interface RenderOptions {
	/**
	 * Local image references, exactly as the importer recorded them from the
	 * body (percent-decoded, relative to the page), mapped to the attachment
	 * each one became. An image whose reference is not here is dropped rather
	 * than emitted: the export's relative path is broken on this server, and an
	 * external URL is a tracking pixel or worse.
	 */
	images?: ReadonlyMap<string, MarkdownImage>;
	/** Builds the URL an attachment is served from; the app's base path lives there. */
	mediaUrl?: (id: string) => string;
	/**
	 * How many levels to push headings down. A body's `#` is the top of the
	 * *body*, not of the page: the page already has its `<h1>`, and the body
	 * usually sits inside a card whose title is an `<h2>`. Clamped at `<h6>`.
	 */
	headingOffset?: number;
}

// ─── the allowlist ─────────────────────────────────────────────────────────

/**
 * Elements a body may contain. What GitHub-flavoured Markdown produces for
 * prose, headings, lists (task lists render as a disabled checkbox), code,
 * quotes, tables, links and images — and nothing that can run, embed, submit
 * or restyle. Anything else is removed with its text kept, except the
 * elements whose text is itself dangerous (script, style, …), which DOMPurify
 * drops whole.
 */
export const ALLOWED_TAGS = [
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'p',
	'br',
	'hr',
	'ul',
	'ol',
	'li',
	'input',
	'strong',
	'em',
	'b',
	'i',
	'del',
	's',
	'code',
	'pre',
	'blockquote',
	'table',
	'thead',
	'tbody',
	'tr',
	'th',
	'td',
	'a',
	'img'
] as const;

/**
 * Attributes, on any allowed element. No `style`, `class`, `id` or `name`
 * (restyling the page, and DOM clobbering), no `on*`, no `data-*` or `aria-*`
 * — the source has no business setting any of them. `type`, `checked` and
 * `disabled` exist for task-list checkboxes and are policed below; `align` is
 * how a Markdown table says which way a column is justified.
 */
export const ALLOWED_ATTR = [
	'href',
	'title',
	'src',
	'alt',
	'align',
	'start',
	'type',
	'checked',
	'disabled'
] as const;

/** The only schemes a link may use. Everything else loses its link. */
const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** DOM node types, spelled out: Node's constants are not globals under Node.js. */
const ELEMENT_NODE = 1;

/**
 * A link target that is safe to put in an `href`, or null.
 *
 * Parsed with the WHATWG URL parser — the one browsers use — rather than
 * matched with a pattern, because every trick for sneaking `javascript:` past
 * a regex (a tab inside the scheme, leading control characters, mixed case,
 * entity encoding already undone by the HTML parser) is something this parser
 * normalises away before it reports the protocol. A relative reference does not
 * parse without a base and is refused: in an imported body it points into the
 * Notion export, which does not exist here.
 *
 * Exported for fields that hold a bare URL, such as a recipe's source link.
 */
export function safeLinkUrl(value: string | null | undefined): string | null {
	if (!value) return null;
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		return null;
	}
	return LINK_PROTOCOLS.has(url.protocol) ? url.href : null;
}

/** Only a web page opens elsewhere; a mail or phone link opens an app. */
const isWebUrl = (href: string) => /^https?:/i.test(href);

// ─── the renderer ──────────────────────────────────────────────────────────

let purifier: ReturnType<typeof DOMPurify> | null = null;

/**
 * One jsdom window for the life of the process, made on first use.
 *
 * A window costs tens of milliseconds and a few megabytes to build, and this
 * server runs on a small machine; nothing about a render needs a fresh one,
 * because DOMPurify parses each input into a document of its own.
 */
function sanitizer(): ReturnType<typeof DOMPurify> {
	purifier ??= DOMPurify(new JSDOM('').window);
	return purifier;
}

const markdown = new Marked({
	gfm: true,
	// A line break in a Notion block is a line break the household typed, not
	// a hard wrap: rendering it as a space runs a recipe's lines together.
	breaks: true,
	async: false
});

/**
 * Renders a Markdown body to sanitized HTML. Empty in, empty out.
 *
 * The result is the only string this application passes to `{@html}`.
 */
export function renderMarkdown(
	source: string | null | undefined,
	options: RenderOptions = {}
): string {
	if (!source || !source.trim()) return '';

	const html = markdown.parse(source) as string;

	const body = sanitizer().sanitize(html, {
		ALLOWED_TAGS: [...ALLOWED_TAGS],
		ALLOWED_ATTR: [...ALLOWED_ATTR],
		// HTML only. Refusing the SVG and MathML namespaces removes the elements
		// whose parsing rules differ from HTML's, which is where mutation XSS
		// lives, and SVG is also a script host in its own right.
		ALLOWED_NAMESPACES: ['http://www.w3.org/1999/xhtml'],
		ALLOW_DATA_ATTR: false,
		ALLOW_ARIA_ATTR: false,
		ALLOW_UNKNOWN_PROTOCOLS: false,
		// Named even though the allowlist already excludes them, so a later
		// widening of ALLOWED_TAGS cannot let one of these back in by accident.
		FORBID_TAGS: ['script', 'style', 'iframe', 'frame', 'object', 'embed', 'form', 'svg', 'math'],
		FORBID_ATTR: ['style'],
		KEEP_CONTENT: true,
		RETURN_DOM: true
	}) as HTMLElement;

	applyPolicy(body, options);
	// Trimmed so a body that sanitizes to nothing is empty, and the page can say so.
	return body.innerHTML.trim();
}

/**
 * This application's rules, applied to a tree DOMPurify has already cleaned.
 *
 * Only ever removes nodes or writes attribute values built here; it cannot
 * introduce markup the sanitizer did not see.
 */
function applyPolicy(body: HTMLElement, options: RenderOptions): void {
	const doc = body.ownerDocument;
	const mediaUrl = options.mediaUrl ?? ((id: string) => `/api/media/${id}`);
	const offset = Math.max(0, Math.trunc(options.headingOffset ?? 0));

	// Images first, so a link left wrapping nothing but a dropped image can be
	// recognised as empty below.
	for (const img of [...body.querySelectorAll('img')]) {
		const found = resolveImage(img.getAttribute('src'), options.images);
		if (!found) {
			// An image on a line of its own sat between two line breaks; with
			// it gone they would stack into a blank line of their own.
			const before = neighbour(img, 'previousSibling');
			const after = neighbour(img, 'nextSibling');
			if (isBreak(before) && isBreak(after)) after?.remove();
			img.remove();
			continue;
		}
		const alt = img.getAttribute('alt') ?? '';
		const title = img.getAttribute('title');
		for (const name of img.getAttributeNames()) img.removeAttribute(name);
		img.setAttribute('src', mediaUrl(found.id));
		img.setAttribute('alt', alt);
		if (title) img.setAttribute('title', title);
		// Stored dimensions stop the text jumping as the picture arrives.
		if (found.width) img.setAttribute('width', String(found.width));
		if (found.height) img.setAttribute('height', String(found.height));
		img.setAttribute('loading', 'lazy');
		img.setAttribute('decoding', 'async');
	}

	for (const link of [...body.querySelectorAll('a')]) {
		const href = safeLinkUrl(link.getAttribute('href'));
		const empty = !link.textContent?.trim() && !link.querySelector('img');
		if (!href || empty) {
			// The words stay; only the link goes. An internal Notion link
			// ("see Cheddar") still reads correctly as text.
			link.replaceWith(...link.childNodes);
			continue;
		}
		link.setAttribute('href', href);
		link.setAttribute('rel', 'noopener noreferrer');
		if (isWebUrl(href)) link.setAttribute('target', '_blank');
		else link.removeAttribute('target');
	}

	// A task-list tick is the only input a body may hold, and it is a picture
	// of a tick: disabled, so it cannot be mistaken for a control that saves.
	for (const input of [...body.querySelectorAll('input')]) {
		if ((input.getAttribute('type') ?? '').toLowerCase() !== 'checkbox') {
			input.remove();
			continue;
		}
		const checked = input.hasAttribute('checked');
		for (const name of input.getAttributeNames()) input.removeAttribute(name);
		input.setAttribute('type', 'checkbox');
		input.setAttribute('disabled', '');
		if (checked) input.setAttribute('checked', '');
	}

	if (offset > 0) {
		for (const heading of [...body.querySelectorAll('h1, h2, h3, h4, h5, h6')]) {
			const level = Math.min(6, Number(heading.tagName.slice(1)) + offset);
			const shifted = doc.createElement(`h${level}`);
			shifted.append(...heading.childNodes);
			heading.replaceWith(shifted);
		}
	}

	// A table is the one thing in a body wider than a phone. It scrolls inside
	// a container of its own, which is focusable so a keyboard can scroll it
	// too, rather than pushing the whole page sideways.
	for (const table of [...body.querySelectorAll('table')]) {
		const frame = doc.createElement('div');
		frame.setAttribute('class', 'md-table');
		frame.setAttribute('role', 'region');
		frame.setAttribute('aria-label', 'Table');
		frame.setAttribute('tabindex', '0');
		table.replaceWith(frame);
		frame.append(table);
	}

	// A dropped image leaves the line breaks that stood either side of it, and
	// a paragraph that held only images leaves nothing at all. Both would show
	// as unexplained gaps in the text.
	for (const p of [...body.querySelectorAll('p')]) {
		trimBreaks(p);
		if (!p.textContent?.trim() && !p.querySelector('img, input')) p.remove();
	}
}

const isBreak = (node: ChildNode | null): boolean =>
	node !== null && node.nodeType === ELEMENT_NODE && (node as Element).tagName === 'BR';

const isBlankText = (node: ChildNode | null): boolean =>
	node !== null && node.nodeType !== ELEMENT_NODE && !node.textContent?.trim();

/** The nearest sibling that is not whitespace. */
function neighbour(node: ChildNode, side: 'previousSibling' | 'nextSibling'): ChildNode | null {
	let next = node[side];
	while (next && isBlankText(next)) next = next[side];
	return next;
}

/** Removes `<br>`s (and the whitespace around them) from both ends of a block. */
function trimBreaks(block: Element): void {
	for (const end of ['firstChild', 'lastChild'] as const) {
		let node = block[end];
		while (node && (isBreak(node) || isBlankText(node))) {
			node.remove();
			node = block[end];
		}
	}
}

/** The stored image a body's `src` names, or null to drop it. */
function resolveImage(
	src: string | null,
	images: ReadonlyMap<string, MarkdownImage> | undefined
): MarkdownImage | null {
	if (!src || !images || images.size === 0) return null;
	// marked percent-encodes spaces when it writes the attribute; the importer
	// recorded each reference decoded. Both spellings are tried so a path that
	// genuinely contains a `%` still matches.
	let decoded = src;
	try {
		decoded = decodeURIComponent(src);
	} catch {
		// A lone `%` is not an escape; the raw form is the one to look up.
	}
	const found = images.get(decoded) ?? images.get(src) ?? null;
	return found && UUID.test(found.id) ? found : null;
}
