<script lang="ts">
	import { enhance } from '$app/forms';
	import {
		Badge,
		Button,
		Card,
		EmptyState,
		Icon,
		Input,
		List,
		ListRow,
		PageHeader,
		Textarea
	} from '$lib/components';

	let { data, form } = $props();

	const archived = $derived(data.series.archivedAt !== null);
	const finishedCount = $derived(data.books.filter((b) => b.finished).length);

	const errorFor = (action: string): string | undefined =>
		form?.action === action ? form.error : undefined;
</script>

<svelte:head><title>{data.series.name} · Reading Tracker · LifeOS</title></svelte:head>

<PageHeader title={data.series.name} back={{ href: '/reading/series', label: 'Series' }}>
	{#snippet meta()}
		{#if archived}<Badge tone="neutral">Archived</Badge>{/if}
		<span>
			{data.books.length}
			{data.series.plannedCount !== null ? `of ${data.series.plannedCount}` : ''}
			book{data.books.length === 1 ? '' : 's'}
		</span>
		<span>{finishedCount} of {data.books.length} read</span>
	{/snippet}
</PageHeader>

<div class="stack">
	<Card flush>
		{#if data.books.length === 0}
			<EmptyState title="No books in this series yet" icon="journal" />
		{:else}
			<List label="Series books, in reading order">
				{#each data.books as book (book.id)}
					<ListRow
						title={book.title}
						href="/reading/books/{book.id}"
						meta={book.authorNames ?? undefined}
						muted={book.finished}
					>
						{#snippet lead()}
							{#if book.finished}
								<span class="check" title="You’ve finished this one">
									<Icon name="check" size={18} />
								</span>
							{/if}
						{/snippet}
						{#snippet trail()}
							{#if book.nextUp}<Badge tone="accent">Next up</Badge>{/if}
						{/snippet}
					</ListRow>
				{/each}
			</List>
		{/if}
	</Card>

	<Card title="Edit">
		<form
			method="POST"
			action="?/save"
			class="edit"
			use:enhance={() => {
				return async ({ update }) => {
					await update({ reset: false });
				};
			}}
		>
			<input type="hidden" name="updatedAt" value={data.series.updatedAt.toISOString()} />
			<Input label="Name" name="name" value={data.series.name} required maxlength={200} />
			<Input
				label="Planned count"
				name="plannedCount"
				type="number"
				inputmode="numeric"
				min="1"
				value={data.series.plannedCount?.toString() ?? ''}
				hint="How many books the series is expected to run to. Optional."
			/>
			<Textarea label="Notes" name="notes" value={data.series.notes ?? ''} rows={4} />

			{#if errorFor('save')}
				<p class="notice error" role="alert">{errorFor('save')}</p>
			{:else if form?.action === 'save' && form.saved}
				<p class="notice ok" role="status">Saved.</p>
			{/if}

			<div class="row-end"><Button type="submit" variant="primary">Save</Button></div>
		</form>
	</Card>

	<Card title={archived ? 'Restore' : 'Archive'}>
		<p class="muted">
			{archived
				? 'This series is archived. Restoring brings it back into the directory.'
				: 'Archiving takes this series out of the directory without deleting it. It waits in the Archive.'}
		</p>
		{#if errorFor('archive')}
			<p class="notice error" role="alert">{errorFor('archive')}</p>
		{/if}
		<form method="POST" action="?/archive" use:enhance>
			<input type="hidden" name="archived" value={archived ? 'false' : 'true'} />
			<Button type="submit" variant={archived ? 'primary' : 'secondary'}>
				{archived ? 'Restore series' : 'Archive series'}
			</Button>
		</form>
	</Card>
</div>

<style>
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}
	.edit {
		display: grid;
		gap: var(--sp-4);
	}
	.row-end {
		display: flex;
		justify-content: flex-end;
	}
	.muted {
		margin: 0 0 var(--sp-3);
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}
	.notice {
		padding: var(--sp-2) var(--sp-3);
		border-radius: var(--radius-sm);
		margin-top: var(--sp-3);
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
	.check {
		display: flex;
		color: var(--c-ok);
	}
</style>
