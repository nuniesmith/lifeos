<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button, Card, Input, PageHeader, Select } from '$lib/components';

	let { data, form } = $props();

	const values = $derived(form?.values);

	const TYPE_LABELS: Record<string, string> = { movie: 'Movie', tv: 'TV show', other: 'Other' };
	const STATUS_LABELS: Record<string, string> = {
		want_to_watch: 'Want to watch',
		watching: 'Watching',
		watched: 'Watched',
		paused: 'Paused',
		dropped: 'Dropped'
	};

	const typeOptions = $derived(
		data.mediaTypes.map((t) => ({ value: t, label: TYPE_LABELS[t] ?? t }))
	);
	const statusOptions = $derived(
		data.statuses.map((s) => ({ value: s, label: STATUS_LABELS[s] ?? s }))
	);
</script>

<svelte:head><title>New title · LifeOS</title></svelte:head>

<PageHeader title="New title" back={{ href: '/entertainment', label: 'Entertainment' }} />

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
			<Select
				label="Type"
				name="mediaType"
				options={typeOptions}
				value={values?.mediaType || 'other'}
			/>
			<Select
				label="Status"
				name="status"
				options={statusOptions}
				value={values?.status || 'want_to_watch'}
			/>
		</div>

		<div class="grid">
			<Input
				label="Streaming service"
				name="streamingService"
				value={values?.streamingService ?? ''}
				placeholder="Netflix, Crave…"
			/>
			<Input label="Genre" name="genre" value={values?.genre ?? ''} />
		</div>

		<div class="grid">
			<Input
				label="Release year"
				name="releaseYear"
				type="number"
				inputmode="numeric"
				min="1850"
				max="2200"
				value={values?.releaseYear ?? ''}
			/>
			<Input
				label="Total seasons"
				name="totalSeasons"
				type="number"
				inputmode="numeric"
				min="0"
				value={values?.totalSeasons ?? ''}
			/>
		</div>

		<div class="row-end">
			<Button type="submit" variant="primary">Save title</Button>
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
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 9rem), 1fr));
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
