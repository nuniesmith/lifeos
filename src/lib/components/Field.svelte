<script lang="ts" module>
	/**
	 * What Field hands its control. The control must spread these onto the
	 * element — that is the whole contract, and it is what guarantees the
	 * label, the hint and the error are actually associated rather than merely
	 * sitting nearby.
	 */
	export interface FieldContext {
		id: string;
		/** For aria-describedby: the hint and error ids, or undefined. */
		describedBy: string | undefined;
		invalid: boolean;
		required: boolean;
	}
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		label: string;
		/** Supply one to match an existing element; otherwise it is generated. */
		id?: string;
		/** Guidance shown before the user gets it wrong. */
		hint?: string;
		/** A validation message. Its presence is what marks the field invalid. */
		error?: string;
		required?: boolean;
		/**
		 * Keeps the label for assistive technology but takes it off screen.
		 * For a search box or a single obvious control — never as a way to fit
		 * more onto a phone.
		 */
		labelHidden?: boolean;
		children: Snippet<[FieldContext]>;
	}

	let {
		label,
		id: providedId,
		hint,
		error,
		required = false,
		labelHidden = false,
		children
	}: Props = $props();

	// $props.id() is stable across server render and hydration, which a
	// module-level counter is not: the counter would restart per process and
	// mismatch the ids the server already sent.
	const generatedId = $props.id();
	const id = $derived(providedId ?? generatedId);

	const hintId = $derived(hint ? `${id}-hint` : undefined);
	const errorId = $derived(error ? `${id}-error` : undefined);
	const describedBy = $derived([hintId, errorId].filter(Boolean).join(' ') || undefined);

	const context: FieldContext = $derived({
		id,
		describedBy,
		invalid: Boolean(error),
		required
	});
</script>

<div class="field">
	<label for={id} class:sr-only={labelHidden}>
		{label}
		{#if required}<span class="req" aria-hidden="true">*</span>{/if}
	</label>

	{@render children(context)}

	{#if hint}
		<p class="hint" id={hintId}>{hint}</p>
	{/if}

	{#if error}
		<!--
			Not role="alert": the message is already reached through
			aria-describedby when focus is on the control, and an alert would
			interrupt as the user types. The form summary is what announces.
		-->
		<p class="error" id={errorId}>{error}</p>
	{/if}
</div>

<style>
	.field {
		display: flex;
		flex-direction: column;
		gap: var(--sp-1);
		min-width: 0;
	}

	label {
		font-size: var(--fs-sm);
		font-weight: 600;
		color: var(--c-text-muted);
	}

	.req {
		color: var(--c-crit);
	}

	.hint,
	.error {
		margin: 0;
		font-size: var(--fs-xs);
	}

	.hint {
		color: var(--c-text-muted);
	}

	.error {
		color: var(--c-crit);
		font-weight: 600;
	}

	/*
	 * The control itself is styled from here rather than from each wrapper, so
	 * an <input>, a <select>, a <textarea> and any bespoke control passed
	 * through the snippet all share one appearance.
	 */
	.field :global(input),
	.field :global(select),
	.field :global(textarea) {
		width: 100%;
		padding: var(--sp-2) var(--sp-3);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-sm);
		background: var(--c-surface);
		/* 16px minimum, or iOS Safari zooms the page on focus and the phone
		   layout is thrown sideways. */
		font-size: max(var(--fs-base), 16px);
	}

	.field :global(textarea) {
		min-height: 6rem;
		line-height: 1.5;
		resize: vertical;
	}

	.field :global([aria-invalid='true']) {
		border-color: var(--c-crit);
	}
</style>
