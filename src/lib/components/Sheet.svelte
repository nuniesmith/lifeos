<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';

	interface Props {
		open?: boolean;
		/** Names the dialog for assistive technology and heads the sheet. */
		title: string;
		children: Snippet;
	}

	let { open = $bindable(false), title, children }: Props = $props();

	let dialog = $state<HTMLDialogElement>();
	const headingId = $props.id();

	/**
	 * A native <dialog> opened with showModal(), not a div with a high
	 * z-index. The platform then supplies the focus trap, the inert background,
	 * Escape-to-close and the top layer — four things a hand-rolled modal gets
	 * wrong on a phone, where a leaked focus ring lands the keyboard on
	 * something behind the sheet.
	 */
	$effect(() => {
		const el = dialog;
		if (!el) return;
		if (open && !el.open) el.showModal();
		if (!open && el.open) el.close();
	});
</script>

<dialog
	bind:this={dialog}
	aria-labelledby={headingId}
	onclose={() => (open = false)}
	onmousedown={(event) => {
		// Tap the backdrop to dismiss, which is the expectation on a phone.
		// Bound to mousedown rather than click so a drag that starts inside
		// the sheet and ends on the backdrop does not close it. The keyboard
		// path is Escape, which <dialog> handles natively, and the Close
		// button below.
		if (event.target === dialog) open = false;
	}}
>
	<div class="panel">
		<header>
			<h2 id={headingId}>{title}</h2>
			<button type="button" class="close" onclick={() => (open = false)}>
				<Icon name="close" size={20} />
				<span class="sr-only">Close</span>
			</button>
		</header>
		<div class="content">
			{@render children()}
		</div>
	</div>
</dialog>

<style>
	dialog {
		/* Bottom sheet: within reach of a thumb, not stranded mid-screen. */
		margin: auto auto 0;
		padding: 0;
		width: 100%;
		max-width: 34rem;
		max-height: 85dvh;
		border: 1px solid var(--c-border);
		border-radius: var(--radius-lg) var(--radius-lg) 0 0;
		background: var(--c-surface);
		color: var(--c-text);
		box-shadow: var(--shadow-lg);
		overflow: hidden;
	}

	dialog::backdrop {
		background: var(--c-overlay);
	}

	@media (prefers-reduced-motion: no-preference) {
		dialog[open] {
			animation: rise var(--dur) var(--ease);
		}
	}

	@keyframes rise {
		from {
			transform: translateY(1.5rem);
			opacity: 0;
		}
	}

	@media (min-width: 48rem) {
		dialog {
			margin: auto;
			border-radius: var(--radius-lg);
		}
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--sp-3);
		padding: var(--sp-3) var(--sp-3) var(--sp-3) var(--sp-4);
		border-bottom: 1px solid var(--c-border);
	}

	h2 {
		margin: 0;
		font-size: var(--fs-lg);
	}

	.close {
		display: grid;
		place-items: center;
		width: var(--tap);
		border: none;
		border-radius: var(--radius-sm);
		background: none;
		color: var(--c-text-muted);
		cursor: pointer;
	}
	.close:hover {
		background: var(--c-surface-alt);
		color: var(--c-text);
	}

	.content {
		padding: var(--sp-4);
		/* The sheet is capped at 85dvh; anything longer scrolls here rather
		   than pushing the page. */
		overflow-y: auto;
		max-height: calc(85dvh - 4rem);
		padding-bottom: calc(var(--sp-4) + env(safe-area-inset-bottom));
	}
</style>
