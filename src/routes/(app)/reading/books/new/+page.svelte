<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button, Card, PageHeader } from '$lib/components';
	import BookFields from '../BookFields.svelte';

	let { data, form } = $props();

	const values = $derived(form?.values ?? data.values);
</script>

<svelte:head><title>New book · Reading Tracker · LifeOS</title></svelte:head>

<PageHeader title="New book" back={{ href: '/reading/books', label: 'Books' }} />

<Card>
	<form method="POST" class="edit" use:enhance>
		{#if form?.error}
			<p class="notice error" role="alert">{form.error}</p>
		{/if}

		<BookFields {values} />

		<div class="row-end">
			<Button type="submit" variant="primary">Save book</Button>
		</div>
	</form>
</Card>

<style>
	.edit {
		display: grid;
		gap: var(--sp-4);
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
