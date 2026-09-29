<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { Button, Card, EmptyState, Input, PageHeader, appPath } from '$lib/components';

	let { data, form } = $props();

	const errorFor = (id: string, action: string): string | undefined =>
		form?.action === action && form.id === id ? form.error : undefined;
</script>

<svelte:head><title>Genres · Reading Tracker · LifeOS</title></svelte:head>

<PageHeader title="Genres" back={{ href: '/reading', label: 'Reading Tracker' }}>
	{#snippet meta()}
		<span>{data.genres.length} genre{data.genres.length === 1 ? '' : 's'}</span>
	{/snippet}
</PageHeader>

<Card flush>
	{#if data.genres.length === 0}
		<EmptyState
			title="No genres yet"
			description="A genre is added from a book's own page."
			icon="journal"
		/>
	{:else}
		<ul class="genres">
			{#each data.genres as genre (genre.id)}
				<li class="row">
					<form
						method="POST"
						action="?/rename"
						class="rename"
						use:enhance={() => {
							return async ({ update }) => {
								await update({ reset: false });
							};
						}}
					>
						<input type="hidden" name="id" value={genre.id} />
						<input type="hidden" name="updatedAt" value={genre.updatedAt.toISOString()} />
						<Input
							label={`Rename ${genre.name}`}
							name="name"
							labelHidden
							value={genre.name}
							required
							maxlength={100}
						/>
						<Button type="submit" size="sm" aria-label={`Rename ${genre.name}`}>Rename</Button>
					</form>

					<a class="count" href={resolve(appPath(`/reading/books?genre=${genre.id}`))}>
						{genre.bookCount} book{genre.bookCount === 1 ? '' : 's'}
					</a>

					<form method="POST" action="?/archive" use:enhance>
						<input type="hidden" name="id" value={genre.id} />
						<input type="hidden" name="archived" value="true" />
						<Button type="submit" size="sm" variant="ghost" aria-label={`Archive ${genre.name}`}>
							Archive
						</Button>
					</form>

					{#if errorFor(genre.id, 'rename')}
						<p class="notice error" role="alert">{errorFor(genre.id, 'rename')}</p>
					{/if}
					{#if errorFor(genre.id, 'archive')}
						<p class="notice error" role="alert">{errorFor(genre.id, 'archive')}</p>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</Card>

<style>
	.genres {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--sp-3);
		padding: var(--sp-3) var(--sp-4);
	}
	.row + .row {
		border-top: 1px solid var(--c-border);
	}
	.rename {
		display: flex;
		flex: 1 1 14rem;
		align-items: flex-end;
		gap: var(--sp-2);
		min-width: 0;
	}
	.rename :global(.field) {
		flex: 1;
		min-width: 0;
	}
	.count {
		flex: none;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
		text-decoration: none;
		white-space: nowrap;
	}
	.count:hover {
		text-decoration: underline;
	}
	.notice {
		flex: 1 0 100%;
		margin: 0;
		padding: var(--sp-1) var(--sp-2);
		border-radius: var(--radius-sm);
		font-size: var(--fs-xs);
	}
	.notice.error {
		color: var(--c-crit);
		border: 1px solid color-mix(in srgb, var(--c-crit) 25%, transparent);
		background: color-mix(in srgb, var(--c-crit) 8%, transparent);
	}
</style>
