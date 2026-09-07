<script lang="ts">
	import { enhance } from '$app/forms';
	import Badge from './Badge.svelte';
	import Button from './Button.svelte';
	import Card from './Card.svelte';
	import EmptyState from './EmptyState.svelte';
	import List from './List.svelte';
	import ListRow from './ListRow.svelte';

	/**
	 * A shelf of library entries.
	 *
	 * Shared by Library, Reading and the Knowledge Hub because they show the
	 * same rows under different filters — one component means the three cannot
	 * drift into rendering an entry three different ways.
	 */

	export interface ShelfItem {
		id: string;
		title: string;
		author: string | null;
		url: string | null;
		summary: string | null;
		entryType: string;
		format: string | null;
		status: string;
		highlightCount: number;
		lastInteractionAt: Date | null;
		isFavourite: boolean;
	}

	interface Props {
		items: readonly ShelfItem[];
		emptyTitle: string;
		emptyDescription?: string;
		/** Shows the "Open" control, which stamps the interaction time. */
		trackOpens?: boolean;
	}

	let { items, emptyTitle, emptyDescription, trackOpens = true }: Props = $props();

	const TYPE_LABELS: Record<string, string> = {
		book: 'Book',
		note: 'Note',
		reference: 'Reference'
	};

	/** "3 months ago" — the number the rediscover ordering is built on. */
	function since(date: Date | null): string | null {
		if (!date) return null;
		const days = Math.round((Date.now() - date.getTime()) / 86_400_000);
		if (days <= 0) return 'today';
		if (days === 1) return 'yesterday';
		if (days < 30) return `${days} days ago`;
		const months = Math.round(days / 30);
		if (months < 24) return `${months} month${months === 1 ? '' : 's'} ago`;
		return `${Math.round(months / 12)} years ago`;
	}

	const meta = (item: ShelfItem): string =>
		[
			item.author,
			item.format,
			item.highlightCount > 0
				? `${item.highlightCount} highlight${item.highlightCount === 1 ? '' : 's'}`
				: null,
			since(item.lastInteractionAt)
		]
			.filter(Boolean)
			.join(' · ');
</script>

<Card flush>
	{#if items.length === 0}
		<EmptyState title={emptyTitle} description={emptyDescription} icon="journal" />
	{:else}
		<List label={emptyTitle}>
			{#each items as item (item.id)}
				<ListRow title={item.title} meta={meta(item)}>
					{#snippet lead()}
						<Badge tone="neutral">{TYPE_LABELS[item.entryType] ?? item.entryType}</Badge>
					{/snippet}
					{#snippet trail()}
						<div class="actions">
							{#if item.isFavourite}<Badge tone="accent">Favourite</Badge>{/if}
							<!-- An arbitrary external URL the household saved, not an
							     application route: resolve() would rewrite someone's own
							     link, so the rule is off for this block only.
							     rel=noreferrer as well as noopener, because an outbound
							     link from a private workspace should not announce where it
							     came from. -->
							<!-- eslint-disable svelte/no-navigation-without-resolve -->
							{#if item.url}
								<a
									class="out"
									href={item.url}
									target="_blank"
									rel="noopener noreferrer"
									aria-label={`Open ${item.title} in a new tab`}
								>
									Open ↗
								</a>
							{/if}
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
							{#if trackOpens}
								<form method="POST" action="?/touch" use:enhance>
									<input type="hidden" name="id" value={item.id} />
									<Button
										type="submit"
										size="sm"
										variant="ghost"
										aria-label={`Mark ${item.title} as revisited`}
									>
										Revisited
									</Button>
								</form>
							{/if}
						</div>
					{/snippet}

					{#if item.summary}
						<p class="summary">{item.summary}</p>
					{/if}
				</ListRow>
			{/each}
		</List>
	{/if}
</Card>

<style>
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-2);
		align-items: center;
	}
	.out {
		color: var(--c-accent);
		font-size: var(--fs-xs);
		text-decoration: none;
		white-space: nowrap;
	}
	.out:hover {
		text-decoration: underline;
	}
	.summary {
		margin: 0.2rem 0 0;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}
</style>
