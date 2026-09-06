<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title?: string;
		/** A short line under the title. Not a place for a paragraph. */
		subtitle?: string;
		/**
		 * Heading rank. A card's title is a real heading and must not skip a
		 * level: the page's own <h1> comes from PageHeader, so a top-level
		 * card is an <h2> and a card inside one is an <h3>.
		 */
		level?: 2 | 3 | 4;
		/** Controls in the card header — a filter, an "add", a link out. */
		actions?: Snippet;
		footer?: Snippet;
		/**
		 * Turn off the body padding when the card holds a full-bleed list, so
		 * rows can divide edge to edge.
		 */
		flush?: boolean;
		children: Snippet;
	}

	let { title, subtitle, level = 2, actions, footer, flush = false, children }: Props = $props();
</script>

<section class="card">
	{#if title || actions}
		<header>
			<div class="titles">
				{#if title}
					<svelte:element this={`h${level}`} class="title">{title}</svelte:element>
				{/if}
				{#if subtitle}<p class="subtitle">{subtitle}</p>{/if}
			</div>
			{#if actions}
				<div class="actions">{@render actions()}</div>
			{/if}
		</header>
	{/if}

	<div class="body" class:flush>
		{@render children()}
	</div>

	{#if footer}
		<footer>{@render footer()}</footer>
	{/if}
</section>

<style>
	.card {
		background: var(--c-surface);
		border: 1px solid var(--c-border);
		border-radius: var(--radius);
		box-shadow: none;
		/* Contains the rounded corners of a flush list body. */
		overflow: hidden;
	}

	header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--sp-3);
		padding: var(--sp-4) var(--sp-4) 0;
	}

	.titles {
		min-width: 0;
	}

	.title {
		margin: 0;
		font-size: var(--fs-lg);
		font-weight: 650;
	}

	.subtitle {
		margin: var(--sp-1) 0 0;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}

	.actions {
		display: flex;
		flex: none;
		gap: var(--sp-2);
	}

	.body {
		padding: var(--sp-4);
		/* A grid child with content wider than the track would otherwise push
		   the page sideways; this keeps overflow inside .scroll-x wrappers. */
		min-width: 0;
	}

	.body.flush {
		padding: 0;
	}

	footer {
		padding: var(--sp-3) var(--sp-4);
		border-top: 1px solid var(--c-border);
		background: var(--c-surface-alt);
		font-size: var(--fs-sm);
	}
</style>
