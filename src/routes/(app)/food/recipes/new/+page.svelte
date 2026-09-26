<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button, Card, Input, PageHeader, Textarea } from '$lib/components';

	let { form } = $props();

	const values = $derived(form?.values);
</script>

<svelte:head><title>New recipe · LifeOS</title></svelte:head>

<PageHeader title="New recipe" back={{ href: '/food', label: 'Food HQ' }} />

<Card>
	<form method="POST" class="edit" use:enhance>
		{#if form?.error}
			<p class="notice error" role="alert">{form.error}</p>
		{/if}

		<Input
			label="Name"
			name="name"
			value={values?.name ?? ''}
			required
			maxlength={300}
			autocomplete="off"
		/>

		<div class="grid">
			<Input
				label="Serves"
				name="servings"
				type="number"
				inputmode="numeric"
				min="1"
				value={values?.servings ?? ''}
			/>
			<Input
				label="Prep (min)"
				name="prepMinutes"
				type="number"
				inputmode="numeric"
				min="0"
				value={values?.prepMinutes ?? ''}
			/>
			<Input
				label="Cook (min)"
				name="cookMinutes"
				type="number"
				inputmode="numeric"
				min="0"
				value={values?.cookMinutes ?? ''}
			/>
		</div>

		<Input
			label="Source link"
			name="url"
			type="url"
			inputmode="url"
			placeholder="https://"
			value={values?.url ?? ''}
		/>
		<Textarea
			label="Instructions"
			name="notes"
			rows={12}
			value={values?.notes ?? ''}
			hint="Optional, and can be added later. Markdown: # for a heading, 1. for a step, - [ ] for a checklist."
		/>

		<div class="row-end">
			<Button type="submit" variant="primary">Save recipe</Button>
		</div>
	</form>
</Card>

<style>
	.edit {
		display: grid;
		gap: var(--sp-4);
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 8rem), 1fr));
		gap: var(--sp-3);
	}
	.row-end {
		display: flex;
		justify-content: flex-end;
	}
	.notice {
		margin: 0;
		padding: var(--sp-2) var(--sp-3);
		border-radius: var(--radius-sm);
		font-size: var(--fs-sm);
	}
	.notice.error {
		color: var(--c-crit);
		border: 1px solid color-mix(in srgb, var(--c-crit) 25%, transparent);
		background: color-mix(in srgb, var(--c-crit) 8%, transparent);
	}
</style>
