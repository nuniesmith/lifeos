<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';
	import Field from './Field.svelte';

	interface Props extends Omit<HTMLInputAttributes, 'value' | 'type'> {
		label: string;
		value?: string;
		/**
		 * Text-like types only. A checkbox or radio needs its label beside the
		 * control rather than above it, so it is not this component's job.
		 */
		type?: 'text' | 'email' | 'password' | 'search' | 'url' | 'tel' | 'number' | 'date' | 'time';
		hint?: string;
		error?: string;
		labelHidden?: boolean;
	}

	let {
		label,
		value = $bindable(''),
		type = 'text',
		hint,
		error,
		labelHidden = false,
		required = false,
		id,
		...rest
	}: Props = $props();
</script>

<!-- The HTML attribute types allow null where Field wants an optional, so the
     two are normalised here rather than widening Field's contract. -->
<Field {label} id={id ?? undefined} {hint} {error} required={Boolean(required)} {labelHidden}>
	{#snippet children(field)}
		<input
			{...rest}
			id={field.id}
			{type}
			bind:value
			required={field.required}
			aria-describedby={field.describedBy}
			aria-invalid={field.invalid || undefined}
		/>
	{/snippet}
</Field>
