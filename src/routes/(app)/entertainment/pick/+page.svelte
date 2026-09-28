<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button, Card, EmptyState, PageHeader, Select } from '$lib/components';

	let { data, form } = $props();

	const TYPE_LABELS: Record<string, string> = { movie: 'Movie', tv: 'TV show', other: 'Other' };

	const typeOptions = $derived(
		data.mediaTypes.map((t) => ({ value: t, label: TYPE_LABELS[t] ?? t }))
	);
	const serviceOptions = $derived(data.streamingServices.map((s) => ({ value: s, label: s })));

	// The action's own result once the form has been submitted at least once,
	// falling back to the load function's first pick -- so the page always has
	// something to show without waiting for a click, and "Another" keeps
	// showing the latest roll rather than snapping back to that first one.
	const suggestion = $derived(form?.suggestion !== undefined ? form.suggestion : data.suggestion);
	const mediaType = $derived(form?.mediaType ?? data.mediaType);
	const streamingService = $derived(form?.streamingService ?? data.streamingService);

	const meta = $derived(
		suggestion
			? [
					TYPE_LABELS[suggestion.mediaType] ?? suggestion.mediaType,
					suggestion.genre,
					suggestion.streamingService,
					suggestion.releaseYear ? String(suggestion.releaseYear) : null
				]
					.filter(Boolean)
					.join(' · ')
			: ''
	);
</script>

<svelte:head><title>What should we watch? · LifeOS</title></svelte:head>

<PageHeader
	title="What should we watch?"
	description="A random pick from what is still on the list."
	back={{ href: '/entertainment', label: 'Entertainment' }}
/>

<div class="stack">
	<Card title="Filters">
		<form
			method="POST"
			action="?/roll"
			class="filters"
			use:enhance={() =>
				async ({ update }) =>
					// The form stays on screen and its two Selects must keep showing
					// the filters just used, not the option the page was first
					// served with -- see the note on the [id] edit form for why a
					// plain reset would undo that.
					update({ reset: false })}
		>
			<div class="grid">
				<Select
					label="Type"
					name="mediaType"
					options={typeOptions}
					placeholder="Any type"
					value={mediaType}
				/>
				<Select
					label="Streaming service"
					name="streamingService"
					options={serviceOptions}
					placeholder="Any service"
					value={streamingService}
				/>
			</div>
			<div class="row-end">
				<Button type="submit" variant="primary">Another</Button>
			</div>
		</form>
	</Card>

	<Card flush>
		{#if suggestion}
			<div class="suggestion">
				<p class="name">{suggestion.name}</p>
				{#if meta}<p class="meta">{meta}</p>{/if}
				<div class="row-end">
					<Button href={`/entertainment/${suggestion.id}`} variant="primary">Open title</Button>
				</div>
			</div>
		{:else}
			<EmptyState
				title="Nothing matches"
				description="Everything on the list has been started, or no title fits these filters."
				icon="today"
			>
				{#snippet action()}
					<Button href="/entertainment/new">Add a title</Button>
				{/snippet}
			</EmptyState>
		{/if}
	</Card>
</div>

<style>
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}
	.filters {
		display: grid;
		gap: var(--sp-4);
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 10rem), 1fr));
		gap: var(--sp-3);
	}
	.row-end {
		display: flex;
		justify-content: flex-end;
	}
	.suggestion {
		display: flex;
		flex-direction: column;
		gap: var(--sp-2);
		padding: var(--sp-4);
	}
	.name {
		margin: 0;
		font-size: var(--fs-lg);
		font-weight: 650;
	}
	.meta {
		margin: 0;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}
</style>
