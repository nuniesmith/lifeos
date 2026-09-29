<script lang="ts">
	import { enhance } from '$app/forms';
	import { BookList, Button, Card, Input, LibraryList, PageHeader } from '$lib/components';

	let { data, form } = $props();

	/*
	 * Bumped after a successful "add a book" save to draw that form afresh —
	 * the same `{#key}` redraw health/measurements/+page.svelte uses, and for
	 * the same reason: the form stays on screen and a plain reset would be
	 * fine here (there is no Select to lose its position), but redrawing is
	 * what clears the title and author fields back to blank for the next one.
	 */
	let addFormKey = $state(0);

	const errorFor = (action: string): string | undefined =>
		form?.action === action ? form.error : undefined;
</script>

<svelte:head><title>Reading Tracker · LifeOS</title></svelte:head>

<PageHeader title="Reading Tracker" description="What you mean to get to, and what you got to.">
	{#snippet meta()}
		<span>{data.currentlyReading.length} reading now</span>
		<span>{data.upNext.length} up next</span>
	{/snippet}
	{#snippet actions()}
		<Button href="/reading/books/new" variant="primary" icon="plus">New book</Button>
	{/snippet}
</PageHeader>

<div class="stack">
	<nav class="shelf-links" aria-label="Reading Tracker sections">
		<Button href="/reading/books" size="sm">All books</Button>
		<Button href="/reading/authors" size="sm" variant="ghost">Authors</Button>
		<Button href="/reading/series" size="sm" variant="ghost">Series</Button>
		<Button href="/reading/genres" size="sm" variant="ghost">Genres</Button>
	</nav>

	<section aria-labelledby="reading-heading">
		<h2 id="reading-heading" class="section-title">Currently reading</h2>
		<BookList books={data.currentlyReading} emptyTitle="Nothing being read right now" />
	</section>

	<section aria-labelledby="next-heading">
		<h2 id="next-heading" class="section-title">Up next</h2>
		<BookList
			books={data.upNext}
			emptyTitle="Nothing on the TBR yet"
			emptyDescription="Add a book below, or from the catalogue, and it lands here."
		/>
	</section>

	<section aria-labelledby="recent-heading">
		<h2 id="recent-heading" class="section-title">Recently read</h2>
		<BookList books={data.recentlyRead} emptyTitle="Nothing finished yet" />
	</section>

	<section aria-labelledby="add-heading">
		<h2 id="add-heading" class="section-title">Add a book</h2>
		<Card>
			{#if errorFor('addBook')}
				<p class="notice error" role="alert">{errorFor('addBook')}</p>
			{/if}
			{#key addFormKey}
				<form
					method="POST"
					action="?/addBook"
					class="add-form"
					use:enhance={() => {
						return async ({ result, update }) => {
							await update();
							if (result.type === 'success') addFormKey += 1;
						};
					}}
				>
					<div class="row">
						<Input label="Title" name="title" required maxlength={300} />
						<Input label="Author" name="author" maxlength={200} />
					</div>
					<div class="actions">
						<Button type="submit" variant="primary">Add book</Button>
					</div>
				</form>
			{/key}
		</Card>
	</section>

	<section aria-labelledby="library-heading">
		<div class="section-head">
			<h2 id="library-heading" class="section-title">From the library</h2>
			<!-- Lands straight on the reading list rather than in the inbox
			     everything else added from /library starts in. -->
			<Button href="/library/new?status=reading_list" icon="plus">Add to reading list</Button>
		</div>

		{#if errorFor('finish') || errorFor('touch')}
			<p class="notice error" role="alert">{errorFor('finish') ?? errorFor('touch')}</p>
		{/if}

		<LibraryList
			items={data.items}
			emptyTitle="Nothing on the reading list"
			emptyDescription="Move something here from the library when you mean to read it."
		/>

		{#if data.finished.length > 0}
			<h3 class="subsection-title">Finished</h3>
			<LibraryList items={data.finished} emptyTitle="Nothing finished yet" trackOpens={false} />
		{/if}
	</section>
</div>

<style>
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-6);
	}
	.shelf-links {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-2);
	}
	.section-title {
		margin: 0 0 var(--sp-3);
		font-size: var(--fs-lg);
		font-weight: 650;
	}
	.subsection-title {
		margin: var(--sp-5) 0 var(--sp-3);
		font-size: var(--fs-base);
		font-weight: 650;
	}
	.section-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--sp-3);
		margin-bottom: var(--sp-3);
	}
	.section-head .section-title {
		margin: 0;
	}
	.add-form {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}
	.row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr));
		gap: var(--sp-3);
	}
	.actions {
		display: flex;
		justify-content: flex-end;
	}
	.notice {
		padding: var(--sp-2) var(--sp-3);
		border-radius: var(--radius-sm);
		margin-bottom: var(--sp-4);
	}
	.notice.error {
		color: var(--c-crit);
		border: 1px solid color-mix(in srgb, var(--c-crit) 25%, transparent);
		background: color-mix(in srgb, var(--c-crit) 8%, transparent);
	}
</style>
