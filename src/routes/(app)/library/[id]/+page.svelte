<script lang="ts">
	import { enhance } from '$app/forms';
	import { Badge, Button, Card, Input, PageHeader, Select, Textarea } from '$lib/components';

	let { data, form } = $props();

	const TYPE_LABELS: Record<string, string> = {
		book: 'Book',
		note: 'Note',
		reference: 'Reference'
	};
	const STATUS_LABELS: Record<string, string> = {
		inbox: 'New',
		reading_list: 'Reading list',
		live: 'Kept',
		archived_read: 'Finished'
	};

	const statusOptions = $derived(
		data.statuses.map((s) => ({ value: s, label: STATUS_LABELS[s] ?? s }))
	);
	const typeOptions = $derived(
		data.entryTypes.map((t) => ({ value: t, label: TYPE_LABELS[t] ?? t }))
	);

	const seen = $derived(
		data.item.lastInteractionAt
			? data.item.lastInteractionAt.toLocaleDateString(undefined, {
					day: 'numeric',
					month: 'long',
					year: 'numeric'
				})
			: null
	);
</script>

<svelte:head><title>{data.item.title} · LifeOS</title></svelte:head>

<PageHeader
	title={data.item.title}
	description={data.item.fullTitle && data.item.fullTitle !== data.item.title
		? data.item.fullTitle
		: undefined}
	back={{ href: '/library', label: 'Library' }}
>
	{#snippet meta()}
		<span>
			{TYPE_LABELS[data.item.entryType]}
			{data.item.author ? ` · ${data.item.author}` : ''}
			{data.item.highlightCount > 0
				? ` · ${data.item.highlightCount} highlight${data.item.highlightCount === 1 ? '' : 's'}`
				: ''}
			{seen ? ` · last opened ${seen}` : ' · never opened'}
		</span>
	{/snippet}
	{#snippet actions()}
		<form method="POST" action="?/touch" use:enhance>
			<Button type="submit" size="sm" variant="ghost">Mark revisited</Button>
		</form>
	{/snippet}
</PageHeader>

{#if form?.error}
	<p class="notice error" role="alert">{form.error}</p>
{:else if form?.saved}
	<p class="notice ok" role="status">Saved.</p>
{/if}

<div class="stack">
	{#if data.item.url}
		<Card>
			<p class="source">
				<!-- The household's own link, not an application route: resolve()
				     would rewrite it. -->
				<!-- eslint-disable svelte/no-navigation-without-resolve -->
				<a href={data.item.url} target="_blank" rel="noopener noreferrer">
					{data.item.url}
				</a>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
			</p>
		</Card>
	{/if}

	{#if data.tags.length > 0}
		<Card>
			<ul class="tags">
				{#each data.tags as tag (tag.id)}
					<li><Badge tone="neutral">{tag.name}</Badge></li>
				{/each}
			</ul>
		</Card>
	{/if}

	<Card>
		<form method="POST" action="?/save" class="edit" use:enhance>
			<!-- `.toISOString()`: the precondition compares to the millisecond,
			     which a Date rendered directly loses. -->
			<input type="hidden" name="updatedAt" value={data.item.updatedAt.toISOString()} />

			<Input label="Title" name="title" value={data.item.title} required />
			<Input label="Author" name="author" value={data.item.author ?? ''} />

			<div class="row">
				<Select label="Status" name="status" value={data.item.status} options={statusOptions} />
				<Select label="Type" name="entryType" value={data.item.entryType} options={typeOptions} />
			</div>

			<Textarea label="Summary" name="summary" value={data.item.summary ?? ''} rows={3} />
			<Textarea
				label="Notes"
				name="notes"
				value={data.item.notes ?? ''}
				rows={8}
				hint="Whatever you kept out of this."
			/>

			<label class="fav">
				<input type="checkbox" name="isFavourite" checked={data.item.isFavourite} />
				<span>Favourite</span>
			</label>

			<div class="save"><Button type="submit">Save</Button></div>
		</form>
	</Card>
</div>

<style>
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}
	.source {
		margin: 0;
		font-size: var(--fs-sm);
		overflow-wrap: anywhere;
	}
	.source a {
		color: var(--c-accent);
	}
	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.edit {
		display: grid;
		gap: var(--sp-4);
	}
	.row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr));
		gap: var(--sp-4);
	}
	.fav {
		display: flex;
		gap: var(--sp-2);
		align-items: center;
		font-size: var(--fs-sm);
	}
	.save {
		display: flex;
		justify-content: flex-end;
	}
	.notice {
		padding: var(--sp-2) var(--sp-3);
		border-radius: var(--radius-sm);
		margin-bottom: var(--sp-4);
		font-size: var(--fs-sm);
	}
	.notice.error {
		color: var(--c-crit);
		border: 1px solid color-mix(in srgb, var(--c-crit) 25%, transparent);
		background: color-mix(in srgb, var(--c-crit) 8%, transparent);
	}
	.notice.ok {
		color: var(--c-ok);
		border: 1px solid color-mix(in srgb, var(--c-ok) 25%, transparent);
		background: color-mix(in srgb, var(--c-ok) 8%, transparent);
	}
</style>
