/**
 * The icon set, as raw path data.
 *
 * Every glyph is stored as an array of `d` strings for a 24×24 viewBox and is
 * drawn with `stroke: currentColor`, so an icon inherits whatever colour and
 * theme its context has. Circles are written as two arcs rather than <circle>
 * elements so a single <path> loop can render any glyph — that keeps
 * Icon.svelte free of `{@html}` and of a per-shape branch.
 *
 * Drawn here rather than pulled from an icon package on purpose: this app
 * loads no external fonts or CDN assets, and a dozen glyphs are not worth a
 * dependency and its supply chain.
 */

export const ICONS = {
	/* A sun: the day, not a date. */
	today: [
		'M12 8.25a3.75 3.75 0 1 0 0 7.5 3.75 3.75 0 1 0 0-7.5',
		'M12 2.75v1.8M12 19.45v1.8M2.75 12h1.8M19.45 12h1.8',
		'M5.4 5.4l1.3 1.3M17.3 17.3l1.3 1.3M18.6 5.4l-1.3 1.3M6.7 17.3l-1.3 1.3'
	],
	/* A checked box. */
	tasks: [
		'M4.75 6.75a2 2 0 0 1 2-2h10.5a2 2 0 0 1 2 2v10.5a2 2 0 0 1-2 2H6.75a2 2 0 0 1-2-2z',
		'M8.5 12.2l2.4 2.4 4.6-5.2'
	],
	/* A folder. */
	projects: [
		'M3.75 7.5a1.75 1.75 0 0 1 1.75-1.75h3.1l2 2h7.65A1.75 1.75 0 0 1 20 9.5v7.75a1.75 1.75 0 0 1-1.75 1.75H5.5a1.75 1.75 0 0 1-1.75-1.75z'
	],
	/* Four panes: the areas of a life, side by side. */
	areas: [
		'M4.25 5.25h5.5v5.5h-5.5zM14.25 5.25h5.5v5.5h-5.5zM4.25 13.25h5.5v5.5h-5.5zM14.25 13.25h5.5v5.5h-5.5z'
	],
	/* A target. */
	goals: [
		'M4 12a8 8 0 1 0 16 0 8 8 0 1 0-16 0',
		'M8.5 12a3.5 3.5 0 1 0 7 0 3.5 3.5 0 1 0-7 0',
		'M11.9 12h.2'
	],
	/* A notebook with a spine. */
	journal: [
		'M6 3.75h11.25a1.5 1.5 0 0 1 1.5 1.5v13.5a1.5 1.5 0 0 1-1.5 1.5H6a1.75 1.75 0 0 1-1.75-1.75V5.5A1.75 1.75 0 0 1 6 3.75z',
		'M8.25 3.75v16.5',
		'M11.25 8.5h4.5M11.25 12h4.5'
	],
	/* Two arrows in a loop: something that comes round again. */
	habits: [
		'M4.75 11.25A6.5 6.5 0 0 1 11.25 4.75h5.5',
		'M14.25 2.25l2.75 2.5-2.75 2.5',
		'M19.25 12.75a6.5 6.5 0 0 1-6.5 6.5h-5.5',
		'M9.75 16.75L7 19.25l2.75 2.5'
	],
	people: [
		'M9.5 4.5a3.25 3.25 0 1 0 0 6.5 3.25 3.25 0 1 0 0-6.5',
		'M3.5 19.5v-1.25a3.75 3.75 0 0 1 3.75-3.75h4.5a3.75 3.75 0 0 1 3.75 3.75v1.25',
		'M16.75 5.15a3.25 3.25 0 0 1 0 5.2',
		'M18 14.7a3.75 3.75 0 0 1 2.5 3.55v1.25'
	],
	/* A bulleted log. */
	audit: ['M8.25 6.5h11.5M8.25 12h11.5M8.25 17.5h11.5', 'M4.2 6.5h.1M4.2 12h.1M4.2 17.5h.1'],
	plus: ['M12 5.5v13M5.5 12h13'],
	more: ['M4.9 12H5M11.95 12h.1M18.9 12h.1'],
	close: ['M6.75 6.75l10.5 10.5M17.25 6.75L6.75 17.25'],
	check: ['M5 12.5l4.5 4.5L19 7'],
	chevron: ['M9.75 5.75L16 12l-6.25 6.25'],
	alert: ['M12 4.5l8.5 15h-17z', 'M12 10v4M11.95 16.75h.1'],
	clock: ['M4 12a8 8 0 1 0 16 0 8 8 0 1 0-16 0', 'M12 7.5V12l2.9 1.7'],
	inbox: [
		'M3.75 13.75h4l1.4 2.75h5.7l1.4-2.75h4',
		'M3.75 13.75l2.4-8a1.75 1.75 0 0 1 1.7-1.25h8.3a1.75 1.75 0 0 1 1.7 1.25l2.4 8v4a1.75 1.75 0 0 1-1.75 1.75H5.5a1.75 1.75 0 0 1-1.75-1.75z'
	],
	signOut: [
		'M15 8.25V6a1.75 1.75 0 0 0-1.75-1.75h-6.5A1.75 1.75 0 0 0 5 6v12a1.75 1.75 0 0 0 1.75 1.75h6.5A1.75 1.75 0 0 0 15 18v-2.25',
		'M11 12h9M17 9l3 3-3 3'
	],
	/* A magnifier: the circle as two arcs, per the note above. */
	search: ['M5 10.75a5.75 5.75 0 1 0 11.5 0 5.75 5.75 0 1 0-11.5 0', 'M14.9 14.9l4.35 4.35']
} as const satisfies Record<string, readonly string[]>;

export type IconName = keyof typeof ICONS;
