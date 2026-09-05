<script lang="ts">
	import type { HTMLSelectAttributes } from 'svelte/elements';
	import Field from './Field.svelte';
	import Icon from './Icon.svelte';

	export interface Option {
		value: string;
		label: string;
		disabled?: boolean;
	}

	interface Props extends Omit<HTMLSelectAttributes, 'value'> {
		label: string;
		options: readonly Option[];
		value?: string;
		/**
		 * An unselected first entry. Give it a real prompt ("Choose a project")
		 * rather than a blank, so the closed control still says what it is.
		 */
		placeholder?: string;
		hint?: string;
		error?: string;
		labelHidden?: boolean;
	}

	let {
		label,
		options,
		value = $bindable(''),
		placeholder,
		hint,
		error,
		labelHidden = false,
		required = false,
		id,
		...rest
	}: Props = $props();
</script>

<Field {label} id={id ?? undefined} {hint} {error} required={Boolean(required)} {labelHidden}>
	{#snippet children(field)}
		<!--
			A native <select> on purpose. The platform control gets the phone's
			own wheel picker, keyboard type-ahead and voice control for free;
			a custom listbox would have to re-earn all three.
		-->
		<div class="wrap">
			<select
				{...rest}
				id={field.id}
				bind:value
				required={field.required}
				aria-describedby={field.describedBy}
				aria-invalid={field.invalid || undefined}
			>
				{#if placeholder}
					<option value="" disabled={field.required}>{placeholder}</option>
				{/if}
				{#each options as option (option.value)}
					<option value={option.value} disabled={option.disabled}>{option.label}</option>
				{/each}
			</select>
			<span class="chevron" aria-hidden="true"><Icon name="chevron" size={16} /></span>
		</div>
	{/snippet}
</Field>

<style>
	.wrap {
		position: relative;
		display: flex;
	}

	select {
		appearance: none;
		/* Room for the chevron, which is decorative and not clickable. */
		padding-right: var(--sp-8) !important;
	}

	.chevron {
		position: absolute;
		top: 50%;
		right: var(--sp-3);
		transform: translateY(-50%) rotate(90deg);
		color: var(--c-text-muted);
		pointer-events: none;
	}
</style>
