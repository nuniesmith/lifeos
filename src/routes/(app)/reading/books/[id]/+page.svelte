<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { Badge, Button, Card, EmptyState, PageHeader, appPath } from '$lib/components';
	import BookFields from '../BookFields.svelte';

	let { data, form } = $props();

	const archived = $derived(data.book.archivedAt !== null);

	const errorFor = (action: string): string | undefined =>
		form?.action === action ? form.error : undefined;

	/*
	 * Bumped after a successful save to redraw the edit form fresh from the
	 * reloaded `data` rather than resetting it — the form holds several
	 * <Select>s (status, category, rating…), and a plain reset after save
	 * would put each one back on whatever the page was first served with,
	 * exactly the bug documented on `addFormKey` in
	 * health/measurements/+page.svelte.
	 */
	let saveFormKey = $state(0);

	const seriesLabel = $derived(
		data.series
			? `${data.series.name}${data.book.seriesPosition !== null ? ` #${data.book.seriesPosition}` : ''}`
			: null
	);
</script>

<svelte:head><title>{data.book.title} · Reading Tracker · LifeOS</title></svelte:head>

<PageHeader
	title={data.book.title}
	description={data.book.subtitle ?? undefined}
	back={{ href: '/reading/books', label: 'Books' }}
>
	{#snippet meta()}
		{#if archived}<Badge tone="neutral">Archived</Badge>{/if}
		{#if data.book.favourite}<Badge tone="accent">Favourite</Badge>{/if}
		<span>
			{#if data.authors.length > 0}
				by {#each data.authors as author, i (author.id)}{i > 0 ? ', ' : ''}<a
						href={resolve(appPath(`/reading/authors/${author.id}`))}>{author.name}</a
					>{/each}
			{/if}
			{#if seriesLabel && data.series}
				· <a href={resolve(appPath(`/reading/series/${data.series.id}`))}>{seriesLabel}</a>
			{/if}
		</span>
	{/snippet}
</PageHeader>

<div class="stack">
	<Card>
		<div class="badges">
			<Badge>{data.book.status}</Badge>
			{#if data.book.format}<Badge tone="neutral">{data.book.format}</Badge>{/if}
			{#if data.book.category}<Badge tone="neutral">{data.book.category}</Badge>{/if}
			{#if data.book.owned}<Badge tone="neutral">Owned</Badge>{/if}
			{#if data.book.rating !== null}<Badge tone="accent">{data.book.rating} ★</Badge>{/if}
		</div>
		{#if data.genres.length > 0}
			<p class="genres">
				{#each data.genres as genre, i (genre.id)}{i > 0 ? ', ' : ''}<a
						href={resolve(appPath(`/reading/books?genre=${genre.id}`))}>{genre.name}</a
					>{/each}
			</p>
		{/if}
		{#if data.storygraphHref}
			<p class="source">
				<!-- The household's own link, not an application route: resolve()
				     would rewrite it. -->
				<!-- eslint-disable svelte/no-navigation-without-resolve -->
				<a href={data.storygraphHref} target="_blank" rel="noopener noreferrer">
					{data.storygraphHref}
				</a>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
			</p>
		{/if}
	</Card>

	<Card title="Description">
		{#if data.descriptionHtml}
			<!-- Safe for the same reason /library/[id]'s notes are: this is
			     `renderMarkdown`'s sanitized output, and the book's own raw
			     field never reaches {@html} directly. -->
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			<div class="prose">{@html data.descriptionHtml}</div>
		{:else}
			<EmptyState title="No description yet" icon="journal" />
		{/if}
	</Card>

	<Card title="Notes">
		{#if data.notesHtml}
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			<div class="prose">{@html data.notesHtml}</div>
		{:else}
			<EmptyState
				title="No notes yet"
				description={data.canEdit
					? 'Add notes below. Markdown works: headings, lists, links.'
					: undefined}
				icon="journal"
			/>
		{/if}
	</Card>

	{#if data.canEdit}
		{#key saveFormKey}
			<Card title="Edit">
				<form
					method="POST"
					action="?/save"
					class="edit"
					use:enhance={() => {
						return async ({ result, update }) => {
							// Not reset: the fields should show what was just saved, not
							// the values the page first loaded with (hard rule 5).
							await update({ reset: false });
							if (result.type === 'success') saveFormKey += 1;
						};
					}}
				>
					<!-- .toISOString(): the precondition compares to the millisecond,
					     which a Date rendered directly loses. -->
					<input type="hidden" name="updatedAt" value={data.book.updatedAt.toISOString()} />

					<BookFields values={data.values} />

					{#if errorFor('save')}
						<p class="notice error" role="alert">{errorFor('save')}</p>
					{:else if form?.action === 'save' && form.saved}
						<p class="notice ok" role="status">Saved.</p>
					{/if}

					<div class="row-end"><Button type="submit" variant="primary">Save</Button></div>
				</form>
			</Card>
		{/key}

		<Card title={archived ? 'Restore' : 'Archive'}>
			<p class="muted">
				{archived
					? 'This book is archived: it is off the catalogue. Restoring brings it back.'
					: 'Archiving takes this book off the catalogue without deleting it. It waits in the Archive.'}
			</p>
			{#if errorFor('archive')}
				<p class="notice error" role="alert">{errorFor('archive')}</p>
			{/if}
			<form method="POST" action="?/archive" use:enhance>
				<input type="hidden" name="archived" value={archived ? 'false' : 'true'} />
				<Button type="submit" variant={archived ? 'primary' : 'secondary'}>
					{archived ? 'Restore book' : 'Archive book'}
				</Button>
			</form>
		</Card>
	{:else}
		<Card>
			<p class="muted">
				This book belongs to someone else in the household, so only they can change it.
			</p>
		</Card>
	{/if}
</div>

<style>
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}
	.badges {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-2);
	}
	.genres {
		margin: var(--sp-3) 0 0;
		font-size: var(--fs-sm);
	}
	.source {
		margin: var(--sp-2) 0 0;
		font-size: var(--fs-sm);
		overflow-wrap: anywhere;
	}
	.source a {
		color: var(--c-accent);
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
		margin: 0;
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

	/* The rendered Markdown body. Copied from /library/[id], the pattern's
	   first user for this pack — see that file for why each rule exists. */
	.prose {
		max-width: var(--measure);
		overflow-wrap: anywhere;
		line-height: 1.6;
	}
	.prose > :global(:first-child) {
		margin-top: 0;
	}
	.prose > :global(:last-child) {
		margin-bottom: 0;
	}
	.prose :global(h3),
	.prose :global(h4),
	.prose :global(h5),
	.prose :global(h6) {
		margin: var(--sp-6) 0 var(--sp-2);
		font-size: var(--fs-base);
		font-weight: 650;
	}
	.prose :global(h3) {
		font-size: var(--fs-lg);
	}
	.prose :global(p),
	.prose :global(ul),
	.prose :global(ol),
	.prose :global(blockquote),
	.prose :global(pre),
	.prose :global(.md-table) {
		margin: 0 0 var(--sp-4);
	}
	.prose :global(ul),
	.prose :global(ol) {
		padding-left: 1.4rem;
	}
	.prose :global(li) {
		margin: var(--sp-1) 0;
	}
	.prose :global(blockquote) {
		padding: var(--sp-2) var(--sp-3);
		border-left: 3px solid var(--c-accent);
		border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
		background: var(--c-surface-alt);
		color: var(--c-text-muted);
	}
	.prose :global(code) {
		padding: 0.05rem 0.3rem;
		border-radius: 4px;
		background: var(--c-surface-alt);
		font-family: var(--font-mono);
		font-size: 0.9em;
	}
	.prose :global(pre) {
		padding: var(--sp-3);
		border-radius: var(--radius-sm);
		background: var(--c-surface-alt);
		overflow-x: auto;
	}
	.prose :global(pre code) {
		padding: 0;
		background: none;
	}
	.prose :global(img) {
		display: block;
		max-width: 100%;
		height: auto;
		margin: var(--sp-2) 0;
		border-radius: var(--radius-sm);
	}
</style>
