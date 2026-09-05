<script lang="ts">
	import { resolve } from '$app/paths';
	import Icon from './Icon.svelte';
	import { appPath } from './nav';

	interface Props {
		label: string;
		/** Makes the tag a link to its filtered view. */
		href?: string;
		/**
		 * Shows a remove control. Its accessible name names the tag, so a
		 * screen reader user hears which of a row of tags they are removing
		 * rather than five identical "Remove" buttons.
		 */
		onRemove?: () => void;
	}

	let { label, href, onRemove }: Props = $props();
</script>

<span class="tag" class:removable={Boolean(onRemove)}>
	{#if href}
		<a href={resolve(appPath(href))}>{label}</a>
	{:else}
		<span class="text">{label}</span>
	{/if}

	{#if onRemove}
		<button type="button" class="remove" onclick={onRemove} aria-label="Remove tag {label}">
			<Icon name="close" size={13} />
		</button>
	{/if}
</span>

<style>
	.tag {
		display: inline-flex;
		align-items: center;
		max-width: 100%;
		border: 1px solid var(--c-border);
		border-radius: var(--radius-pill);
		background: var(--c-surface-alt);
		font-size: var(--fs-xs);
		line-height: 1.6;
	}

	.text,
	a {
		display: block;
		padding: 0.1rem var(--sp-2);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--c-text-muted);
	}
	.removable .text,
	.removable a {
		padding-right: 0;
	}

	a {
		text-decoration: none;
	}
	a:hover {
		color: var(--c-accent);
		text-decoration: underline;
	}

	/* Deliberately under the 44px floor: a remove affordance sits inside a
	   pill and cannot be thumb-sized without the pill becoming a button.
	   The padded hit area below buys back most of the difference, and every
	   tag list must also offer a full-size edit path. */
	.remove {
		display: inline-flex;
		align-items: center;
		min-height: 0;
		padding: var(--sp-1) var(--sp-2) var(--sp-1) var(--sp-1);
		border: 0;
		background: none;
		color: var(--c-text-muted);
		cursor: pointer;
	}
	.remove:hover {
		color: var(--c-crit);
	}
</style>
