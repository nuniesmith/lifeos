/**
 * The slice of jsdom this application uses.
 *
 * jsdom ships no type declarations of its own, and `@types/jsdom` would be a
 * dependency added to describe one constructor. The Markdown renderer only ever
 * needs a window to hand to DOMPurify, so that is all this declares.
 */
declare module 'jsdom' {
	export class JSDOM {
		constructor(html?: string);
		readonly window: Window & typeof globalThis;
	}
}
