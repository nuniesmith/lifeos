<script lang="ts">
	import { resolve } from '$app/paths';
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';
	import { appPath } from './nav';

	interface Props {
		title: string;
		/** One sentence of orientation. Longer than that belongs on the page. */
		description?: string;
		/** A back link for a detail page. Phones have no reliable back chrome. */
		back?: { href: string; label: string };
		/** Page-level controls; they wrap under the title on a narrow screen. */
		actions?: Snippet;
		/** Counts, dates, badges — the line beneath the title. */
		meta?: Snippet;
	}

	let { title, description, back, actions, meta }: Props = $props();
</script>

<header class="page-header">
	{#if back}
		<a class="back" href={resolve(appPath(back.href))}>
			<span class="flip"><Icon name="chevron" size={16} /></span>
			{back.label}
		</a>
	{/if}

	<div class="row">
		<h1>{title}</h1>
		{#if actions}
			<div class="actions">{@render actions()}</div>
		{/if}
	</div>

	{#if description}
		<p class="description">{description}</p>
	{/if}

	{#if meta}
		<div class="meta">{@render meta()}</div>
	{/if}
</header>

<style>
	.page-header {
		margin-bottom: var(--sp-7);
		padding-bottom: var(--sp-4);
		border-bottom: 1px solid var(--c-border);
	}

	.back {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-1);
		min-height: var(--tap);
		margin-bottom: var(--sp-1);
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
		text-decoration: none;
	}
	.back:hover {
		color: var(--c-text);
	}
	.flip {
		display: inline-flex;
		transform: rotate(180deg);
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--sp-3);
	}

	h1 {
		margin: 0;
		font-size: clamp(1.45rem, 2vw, 1.9rem);
		letter-spacing: -0.01em;
		font-weight: 680;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-2);
	}

	.description {
		margin: var(--sp-3) 0 0;
		padding: 0.38rem 0.55rem;
		border-radius: var(--radius-sm);
		background: var(--page-accent-soft, transparent);
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
		font-style: italic;
	}

	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--sp-2);
		margin-top: var(--sp-3);
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}
</style>
