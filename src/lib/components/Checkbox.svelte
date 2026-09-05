<script lang="ts">
	interface Props {
		checked?: boolean;
		/**
		 * The accessible name. Always required — a row of anonymous checkboxes
		 * is unusable with a screen reader, so name each one after what it
		 * ticks off ("Complete: book the vet").
		 */
		label: string;
		/** Keeps the name for assistive technology, drops it from the page. */
		hideLabel?: boolean;
		disabled?: boolean;
		onchange?: (checked: boolean) => void;
	}

	let {
		checked = $bindable(false),
		label,
		hideLabel = false,
		disabled = false,
		onchange
	}: Props = $props();
</script>

<!--
	A native checkbox inside its own <label>, which associates the two without
	an id and makes the whole target — not just the 20px box — tick it. The
	box is sized explicitly because tokens.css puts a 44px min-height on every
	input, which on a checkbox would otherwise stretch it into a tall sliver.
-->
<label class="check" class:hidden-label={hideLabel}>
	<input
		type="checkbox"
		bind:checked
		{disabled}
		onchange={(event) => onchange?.(event.currentTarget.checked)}
	/>
	<span class:sr-only={hideLabel}>{label}</span>
</label>

<style>
	.check {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-2);
		min-height: var(--tap);
		font-size: var(--fs-sm);
		cursor: pointer;
	}

	/* With no visible text the label collapses to the box, so the tap area is
	   widened back out to a thumb. */
	.hidden-label {
		justify-content: center;
		min-width: var(--tap);
	}

	input {
		width: 20px;
		height: 20px;
		min-height: 0;
		margin: 0;
		accent-color: var(--c-accent);
		cursor: pointer;
	}

	input:disabled,
	input:disabled + span {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
