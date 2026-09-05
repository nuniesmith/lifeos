<script lang="ts">
	import type { Snippet } from 'svelte';
	import { resolve } from '$app/paths';
	import Icon from './Icon.svelte';
	import { appPath } from './nav';

	interface Props {
		title: string;
		/** A second line: due date, project, count. Kept to one short line. */
		meta?: string;
		/** Navigates to the record. The whole row becomes the hit area. */
		href?: string;
		/** A checkbox, an avatar, a status dot. Stays clickable over a link. */
		lead?: Snippet;
		/** A badge, a menu, a value. Also stays clickable over a link. */
		trail?: Snippet;
		/** Anything richer than `meta` — tags, a progress bar. */
		children?: Snippet;
		/** Dims the row: done, archived, cancelled. */
		muted?: boolean;
	}

	let { title, meta, href, lead, trail, children, muted = false }: Props = $props();
</script>

<li class="row" class:muted>
	{#if lead}
		<div class="lead">{@render lead()}</div>
	{/if}

	<div class="main">
		{#if href}
			<!--
				One link, stretched over the row by ::after rather than by
				wrapping everything. Wrapping would swallow the checkbox in
				`lead` — a control inside a link is unreachable by keyboard in
				the way the user expects, and invalid HTML besides.
			-->
			<a class="title stretched" href={resolve(appPath(href))}>{title}</a>
		{:else}
			<span class="title">{title}</span>
		{/if}
		{#if meta}<span class="meta">{meta}</span>{/if}
		{#if children}
			<div class="extra">{@render children()}</div>
		{/if}
	</div>

	{#if trail}
		<div class="trail">{@render trail()}</div>
	{/if}

	{#if href}
		<span class="chevron" aria-hidden="true"><Icon name="chevron" size={16} /></span>
	{/if}
</li>

<style>
	.row {
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--sp-3);
		min-height: var(--tap);
		padding: var(--sp-3) var(--sp-4);
	}

	.row:has(.stretched:hover),
	.row:has(.stretched:focus-visible) {
		background: var(--c-surface-alt);
	}

	/* The outline belongs to the row, not to the invisible stretched link. */
	.row:has(.stretched:focus-visible) {
		outline: 2px solid var(--c-accent);
		outline-offset: -2px;
	}
	.stretched:focus-visible {
		outline: none;
	}

	.lead,
	.trail {
		/* Above the stretched link's overlay, so a checkbox in `lead` is still
		   the thing you tap when you tap it. */
		position: relative;
		z-index: 1;
		display: flex;
		flex: none;
		align-items: center;
		gap: var(--sp-2);
	}

	.main {
		display: flex;
		flex-direction: column;
		gap: var(--sp-1);
		flex: 1 1 auto;
		/* Without this a long title widens the row and the page scrolls
		   sideways on a phone. */
		min-width: 0;
	}

	.title {
		font-weight: 550;
		color: var(--c-text);
		text-decoration: none;
		overflow-wrap: anywhere;
	}

	.stretched::after {
		content: '';
		position: absolute;
		inset: 0;
	}

	.meta {
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
		overflow-wrap: anywhere;
	}

	.extra {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-2);
		margin-top: var(--sp-1);
		position: relative;
		z-index: 1;
	}

	.chevron {
		flex: none;
		color: var(--c-text-muted);
	}

	.muted .title {
		color: var(--c-text-muted);
		text-decoration: line-through;
	}
	.muted .meta {
		opacity: 0.8;
	}
</style>
