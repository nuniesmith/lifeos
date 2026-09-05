<script lang="ts">
	import Button from './Button.svelte';
	import Icon from './Icon.svelte';

	interface Props {
		title?: string;
		/**
		 * What failed, in the user's terms. Never a stack trace or SQL — the
		 * server already refuses to send those; do not reintroduce them here.
		 */
		message?: string;
		/**
		 * A support reference, when the server supplied one. It is the thread
		 * back to the log and is safe to show.
		 */
		requestId?: string;
		/** Shows a retry button when the caller can actually retry. */
		onRetry?: () => void;
	}

	let {
		title = 'That did not load',
		message = 'Something went wrong on our side. Try again in a moment.',
		requestId,
		onRetry
	}: Props = $props();
</script>

<!-- role="alert" so the failure is announced even if focus is elsewhere. -->
<div class="error" role="alert">
	<span class="glyph"><Icon name="alert" size={22} /></span>
	<div class="text">
		<p class="title">{title}</p>
		<p class="message">{message}</p>
		{#if requestId}
			<p class="rid">Reference <code>{requestId}</code></p>
		{/if}
	</div>
	{#if onRetry}
		<div class="retry">
			<Button size="sm" onclick={onRetry}>Try again</Button>
		</div>
	{/if}
</div>

<style>
	.error {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: var(--sp-3);
		padding: var(--sp-4);
		border: 1px solid color-mix(in srgb, var(--c-crit) 30%, transparent);
		border-radius: var(--radius);
		background: color-mix(in srgb, var(--c-crit) 7%, var(--c-surface));
	}

	.glyph {
		flex: none;
		color: var(--c-crit);
		padding-top: 0.1rem;
	}

	.text {
		flex: 1 1 14rem;
		min-width: 0;
	}

	.title {
		margin: 0;
		font-weight: 650;
		color: var(--c-crit);
	}

	.message {
		margin: var(--sp-1) 0 0;
		max-width: var(--measure);
		font-size: var(--fs-sm);
	}

	.rid {
		margin: var(--sp-2) 0 0;
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
	}

	code {
		font-family: var(--font-mono);
		overflow-wrap: anywhere;
	}

	.retry {
		flex: none;
	}
</style>
