<script lang="ts">
	import type { HTMLTextareaAttributes } from 'svelte/elements';
	import Field from './Field.svelte';

	interface Props extends Omit<HTMLTextareaAttributes, 'value'> {
		label: string;
		value?: string;
		hint?: string;
		error?: string;
		labelHidden?: boolean;
		rows?: number;
	}

	let {
		label,
		value = $bindable(''),
		hint,
		error,
		labelHidden = false,
		required = false,
		rows = 4,
		id,
		...rest
	}: Props = $props();
</script>

<Field {label} id={id ?? undefined} {hint} {error} required={Boolean(required)} {labelHidden}>
	{#snippet children(field)}
		<textarea
			{...rest}
			id={field.id}
			{rows}
			bind:value
			required={field.required}
			aria-describedby={field.describedBy}
			aria-invalid={field.invalid || undefined}
		></textarea>
	{/snippet}
</Field>
