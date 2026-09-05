<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';
	import type { IconName } from './icons';

	interface Props {
		/**
		 * What is empty, said plainly. "Nothing due today", not "No results" —
		 * an empty list is usually good news and should read like it.
		 */
		title: string;
		description?: string;
		icon?: IconName;
		/** The one thing to do next, if there is one. */
		action?: Snippet;
	}

	let { title, description, icon = 'check', action }: Props = $props();
</script>

<div class="empty">
	<span class="glyph"><Icon name={icon} size={26} /></span>
	<p class="title">{title}</p>
	{#if description}<p class="description">{description}</p>{/if}
	{#if action}
		<div class="action">{@render action()}</div>
	{/if}
</div>

<style>
	.empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--sp-2);
		padding: var(--sp-8) var(--sp-4);
		text-align: center;
	}

	.glyph {
		display: grid;
		place-items: center;
		width: 3rem;
		height: 3rem;
		border-radius: 50%;
		background: var(--c-surface-alt);
		color: var(--c-text-muted);
	}

	.title {
		margin: 0;
		font-weight: 600;
	}

	.description {
		margin: 0;
		max-width: 34ch;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}

	.action {
		margin-top: var(--sp-2);
	}
</style>
