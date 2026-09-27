<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button, Card, Input, PageHeader, Select, Textarea } from '$lib/components';
	import { SHELF_LABELS } from '../shelf';

	let { data, form } = $props();

	const values = $derived(form?.values);

	const TYPE_LABELS: Record<string, string> = {
		book: 'Book',
		note: 'Note',
		reference: 'Reference'
	};

	const entryTypeOptions = $derived(
		data.entryTypes.map((t) => ({ value: t, label: TYPE_LABELS[t] ?? t }))
	);
	const statusOptions = $derived(
		data.statuses.map((s) => ({ value: s, label: SHELF_LABELS[s] ?? s }))
	);
</script>

<svelte:head><title>New entry · LifeOS</title></svelte:head>

<PageHeader title="New entry" back={{ href: '/library', label: 'Library' }} />

<Card>
	<form method="POST" class="edit" use:enhance>
		{#if form?.error}
			<p class="notice error" role="alert">{form.error}</p>
		{/if}

		<Input
			label="Title"
			name="title"
			value={values?.title ?? ''}
			required
			maxlength={500}
			autocomplete="off"
		/>

		<div class="row">
			<Select
				label="Type"
				name="entryType"
				options={entryTypeOptions}
				value={values?.entryType || 'reference'}
			/>
			<Select
				label="Status"
				name="status"
				options={statusOptions}
				value={values?.status || data.defaultStatus}
			/>
		</div>

		<Input
			label="Format"
			name="format"
			value={values?.format ?? ''}
			placeholder="Article, podcast, video…"
			hint="The household's own shelving word. Optional — free text, not a fixed list."
		/>
		<Input label="Author" name="author" value={values?.author ?? ''} />
		<Input
			label="Link"
			name="url"
			type="url"
			inputmode="url"
			placeholder="https://"
			value={values?.url ?? ''}
		/>

		<Textarea label="Summary" name="summary" value={values?.summary ?? ''} rows={3} />
		<Textarea
			label="Notes"
			name="notes"
			value={values?.notes ?? ''}
			rows={8}
			hint="Optional, and can be added later. Markdown works: headings, lists, links."
		/>

		<div class="row-end">
			<Button type="submit" variant="primary">Save entry</Button>
		</div>
	</form>
</Card>

<style>
	.edit {
		display: grid;
		gap: var(--sp-4);
	}
	.row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 10rem), 1fr));
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
