<script lang="ts">
	import Badge from './Badge.svelte';
	import Card from './Card.svelte';
	import EmptyState from './EmptyState.svelte';
	import List from './List.svelte';
	import ListRow from './ListRow.svelte';

	/**
	 * A shelf of books.
	 *
	 * Shared by the Reading Tracker home page's three lists, the catalogue and
	 * the author/series detail pages, the same reason `LibraryList` is shared
	 * by Library/Reading/Knowledge Hub: one component means a book cannot be
	 * shown five different ways by accident.
	 */

	export interface BookListEntry {
		id: string;
		title: string;
		authorNames: string | null;
		seriesName: string | null;
		seriesPosition: number | null;
		status: string;
		favourite: boolean;
	}

	interface Props {
		books: readonly BookListEntry[];
		emptyTitle: string;
		emptyDescription?: string;
	}

	let { books, emptyTitle, emptyDescription }: Props = $props();

	const STATUS_LABELS: Record<string, string> = {
		tbr: 'TBR',
		reading: 'Reading',
		paused: 'Paused',
		read: 'Read',
		dnf: 'DNF'
	};

	const seriesOf = (book: BookListEntry): string | null =>
		book.seriesName
			? `${book.seriesName}${book.seriesPosition !== null ? ` #${book.seriesPosition}` : ''}`
			: null;

	const meta = (book: BookListEntry): string =>
		[book.authorNames, seriesOf(book)].filter(Boolean).join(' · ');
</script>

<Card flush>
	{#if books.length === 0}
		<EmptyState title={emptyTitle} description={emptyDescription} icon="journal" />
	{:else}
		<List label={emptyTitle}>
			{#each books as book (book.id)}
				<ListRow title={book.title} href="/reading/books/{book.id}" meta={meta(book)}>
					{#snippet trail()}
						<div class="trail">
							{#if book.favourite}<Badge tone="accent">Favourite</Badge>{/if}
							<Badge tone="neutral">{STATUS_LABELS[book.status] ?? book.status}</Badge>
						</div>
					{/snippet}
				</ListRow>
			{/each}
		</List>
	{/if}
</Card>

<style>
	.trail {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
	}
</style>
