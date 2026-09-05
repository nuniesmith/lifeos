<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		/** Maps to the semantic colours, never to a bare hue. */
		tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'crit';
		/**
		 * Adds a coloured dot. Status must not be carried by colour alone, and
		 * the dot plus the label text is what makes it legible to a
		 * colour-blind reader and in a screenshot printed in grey.
		 */
		dot?: boolean;
		children: Snippet;
	}

	let { tone = 'neutral', dot = false, children }: Props = $props();
</script>

<span class="badge {tone}">
	{#if dot}<span class="dot" aria-hidden="true"></span>{/if}
	{@render children()}
</span>

<style>
	.badge {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-1);
		padding: 0.1rem var(--sp-2);
		border: 1px solid transparent;
		border-radius: var(--radius-pill);
		font-size: var(--fs-xs);
		font-weight: 600;
		line-height: 1.5;
		white-space: nowrap;
	}

	.dot {
		width: 0.45em;
		height: 0.45em;
		border-radius: 50%;
		background: currentcolor;
	}

	.neutral {
		background: var(--c-surface-alt);
		border-color: var(--c-border);
		color: var(--c-text-muted);
	}
	.accent {
		background: var(--c-accent-soft);
		border-color: color-mix(in srgb, var(--c-accent) 30%, transparent);
		color: var(--c-accent);
	}
	.ok {
		background: color-mix(in srgb, var(--c-ok) 12%, transparent);
		border-color: color-mix(in srgb, var(--c-ok) 30%, transparent);
		color: var(--c-ok);
	}
	.warn {
		background: color-mix(in srgb, var(--c-warn) 12%, transparent);
		border-color: color-mix(in srgb, var(--c-warn) 30%, transparent);
		color: var(--c-warn);
	}
	.crit {
		background: color-mix(in srgb, var(--c-crit) 12%, transparent);
		border-color: color-mix(in srgb, var(--c-crit) 30%, transparent);
		color: var(--c-crit);
	}
</style>
