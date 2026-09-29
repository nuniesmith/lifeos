<script lang="ts">
	import { enhance } from '$app/forms';
	import { Badge, BookList, Button, Card, Input, PageHeader, Textarea } from '$lib/components';

	let { data, form } = $props();

	const archived = $derived(data.author.archivedAt !== null);

	const errorFor = (action: string): string | undefined =>
		form?.action === action ? form.error : undefined;
</script>

<svelte:head><title>{data.author.name} · Reading Tracker · LifeOS</title></svelte:head>

<PageHeader title={data.author.name} back={{ href: '/reading/authors', label: 'Authors' }}>
	{#snippet meta()}
		{#if archived}<Badge tone="neutral">Archived</Badge>{/if}
		<span>{data.books.length} book{data.books.length === 1 ? '' : 's'}</span>
	{/snippet}
</PageHeader>

<div class="stack">
	<BookList books={data.books} emptyTitle="No books by this author yet" />

	<!-- No owner on an author, so there is no other-member's-record case to
	     branch on here the way /library/[id] and /reading/books/[id] do. -->
	<Card title="Edit">
		<form
			method="POST"
			action="?/save"
			class="edit"
			use:enhance={() => {
				return async ({ update }) => {
					// Not reset: the fields should show what was just saved.
					await update({ reset: false });
				};
			}}
		>
			<input type="hidden" name="updatedAt" value={data.author.updatedAt.toISOString()} />
			<Input label="Name" name="name" value={data.author.name} required maxlength={200} />
			<Textarea label="Notes" name="notes" value={data.author.notes ?? ''} rows={4} />

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
				? 'This author is archived. Restoring brings them back into the directory.'
				: 'Archiving takes this author out of the directory without deleting them. They wait in the Archive.'}
		</p>
		{#if errorFor('archive')}
			<p class="notice error" role="alert">{errorFor('archive')}</p>
		{/if}
		<form method="POST" action="?/archive" use:enhance>
			<input type="hidden" name="archived" value={archived ? 'false' : 'true'} />
			<Button type="submit" variant={archived ? 'primary' : 'secondary'}>
				{archived ? 'Restore author' : 'Archive author'}
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
</style>
