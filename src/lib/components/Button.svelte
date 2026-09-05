<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';
	import { resolve } from '$app/paths';
	import Icon from './Icon.svelte';
	import { appPath } from './nav';
	import type { IconName } from './icons';

	interface Props extends HTMLButtonAttributes {
		variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
		size?: 'sm' | 'md';
		/**
		 * Render an <a> that looks like a button. Navigation is a link and
		 * must stay one: a button that navigates loses the middle click, the
		 * open-in-new-tab menu and the browser's own affordances.
		 */
		href?: string;
		/** Shows a spinner and marks the control busy without collapsing it. */
		loading?: boolean;
		/** Full width. The usual shape for a primary action on a phone. */
		full?: boolean;
		icon?: IconName;
		/**
		 * Drop the label to a tooltip and an accessible name. The caller must
		 * still pass children — they become the name — and an icon.
		 */
		iconOnly?: boolean;
		children: Snippet;
	}

	let {
		variant = 'secondary',
		size = 'md',
		href,
		loading = false,
		full = false,
		icon,
		iconOnly = false,
		type = 'button',
		disabled,
		children,
		...rest
	}: Props = $props();

	const classes = $derived(
		['btn', variant, size, full && 'full', iconOnly && 'icon-only'].filter(Boolean).join(' ')
	);
</script>

{#snippet body()}
	{#if loading}
		<span class="spinner" aria-hidden="true"></span>
	{:else if icon}
		<Icon name={icon} size={size === 'sm' ? 16 : 18} />
	{/if}
	<span class={iconOnly ? 'sr-only' : 'label'}>{@render children()}</span>
{/snippet}

{#if href}
	<!-- The rest props are typed for a <button>; the two element interfaces
	     differ only in the element passed to event handlers, so the cast is
	     safe and keeps one component serving both shapes. -->
	<a
		{...rest as HTMLAnchorAttributes}
		href={resolve(appPath(href))}
		class={classes}
		aria-busy={loading || undefined}
	>
		{@render body()}
	</a>
{:else}
	<button {...rest} {type} class={classes} disabled={disabled || loading} aria-busy={loading}>
		{@render body()}
	</button>
{/if}

<style>
	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--sp-2);
		min-height: var(--tap);
		padding: 0 var(--sp-4);
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		font-size: var(--fs-sm);
		font-weight: 600;
		line-height: 1.2;
		text-align: center;
		text-decoration: none;
		cursor: pointer;
		transition:
			background-color var(--dur-fast) var(--ease),
			border-color var(--dur-fast) var(--ease);
	}

	.sm {
		min-height: 34px;
		padding: 0 var(--sp-3);
		font-size: var(--fs-xs);
	}

	.full {
		display: flex;
		width: 100%;
	}

	.icon-only {
		padding: 0;
		width: var(--tap);
	}
	.icon-only.sm {
		width: 34px;
	}

	.primary {
		background: var(--c-accent);
		color: var(--c-accent-text);
	}
	.primary:hover:not(:disabled) {
		background: color-mix(in srgb, var(--c-accent) 88%, var(--c-text));
	}

	.secondary {
		background: var(--c-surface);
		border-color: var(--c-border);
		color: var(--c-text);
	}
	.secondary:hover:not(:disabled) {
		background: var(--c-surface-alt);
	}

	.ghost {
		background: transparent;
		color: var(--c-text-muted);
	}
	.ghost:hover:not(:disabled) {
		background: var(--c-surface-alt);
		color: var(--c-text);
	}

	.danger {
		background: transparent;
		border-color: color-mix(in srgb, var(--c-crit) 40%, transparent);
		color: var(--c-crit);
	}
	.danger:hover:not(:disabled) {
		background: color-mix(in srgb, var(--c-crit) 10%, transparent);
	}

	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	button[aria-busy='true'] {
		cursor: progress;
	}

	.label {
		/* Long labels wrap rather than widening the row past the viewport. */
		min-width: 0;
	}

	.spinner {
		width: 1em;
		height: 1em;
		border: 2px solid currentcolor;
		border-top-color: transparent;
		border-radius: 50%;
		animation: spin 700ms linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(1turn);
		}
	}

	/* tokens.css neutralises the animation under reduced motion; without a
	   visible spin the ring alone still reads as "something is happening". */
</style>
