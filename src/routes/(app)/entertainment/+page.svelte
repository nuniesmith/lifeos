<script lang="ts">
	import { enhance } from '$app/forms';
	import {
		Badge,
		Button,
		Card,
		CoverThumb,
		EmptyState,
		List,
		ListRow,
		PageHeader
	} from '$lib/components';

	let { data, form } = $props();

	type Item = (typeof data.watching)[number];

	const meta = (item: Item): string =>
		[
			item.streamingService,
			item.releaseYear ? String(item.releaseYear) : null,
			item.currentSeason
				? `S${item.currentSeason}${item.currentEpisode ? `E${item.currentEpisode}` : ''}`
				: null,
			item.timesWatched > 0 ? `watched ${item.timesWatched}×` : null
		]
			.filter(Boolean)
			.join(' · ');
</script>

<svelte:head><title>Entertainment · LifeOS</title></svelte:head>

<PageHeader title="Entertainment" description="What is on, what is queued, what was good.">
	{#snippet meta()}<span>{data.watching.length} on the go</span>{/snippet}
	{#snippet actions()}
		<Button href="/entertainment/pick" icon="search">What should we watch?</Button>
		<Button href="/entertainment/new" icon="plus">New title</Button>
	{/snippet}
</PageHeader>

{#if form?.error}<p class="notice error" role="alert">{form.error}</p>{/if}

<div class="stack">
	<section aria-labelledby="watching-heading">
		<h2 id="watching-heading" class="section-title">Currently watching</h2>
		<Card flush>
			{#if data.watching.length === 0}
				<EmptyState
					title="Nothing on the go"
					description="Start something from the queue below."
					icon="today"
				/>
			{:else}
				<List label="Currently watching">
					{#each data.watching as item (item.id)}
						<ListRow title={item.name} meta={meta(item)} href={`/entertainment/${item.id}`}>
							{#snippet lead()}
								<CoverThumb cover={item.cover} />
							{/snippet}
							{#snippet trail()}
								<form method="POST" action="?/setStatus" use:enhance>
									<input type="hidden" name="id" value={item.id} />
									<input type="hidden" name="status" value="watched" />
									<Button
										type="submit"
										size="sm"
										variant="ghost"
										aria-label={`Mark ${item.name} watched`}
									>
										Finished
									</Button>
								</form>
							{/snippet}
						</ListRow>
					{/each}
				</List>
			{/if}
		</Card>
	</section>

	<section aria-labelledby="queue-heading">
		<h2 id="queue-heading" class="section-title">Up next</h2>
		<Card flush>
			{#if data.queued.length === 0}
				<EmptyState title="Nothing queued" icon="today" />
			{:else}
				<List label="Up next">
					{#each data.queued as item (item.id)}
						<ListRow title={item.name} meta={meta(item)} href={`/entertainment/${item.id}`}>
							{#snippet lead()}
								<CoverThumb cover={item.cover} />
							{/snippet}
							{#snippet trail()}
								<form method="POST" action="?/setStatus" use:enhance>
									<input type="hidden" name="id" value={item.id} />
									<input type="hidden" name="status" value="watching" />
									<Button type="submit" size="sm" aria-label={`Start ${item.name}`}>Start</Button>
								</form>
							{/snippet}
						</ListRow>
					{/each}
				</List>
			{/if}
		</Card>
	</section>

	{#if data.watched.length > 0}
		<section aria-labelledby="seen-heading">
			<h2 id="seen-heading" class="section-title">Seen</h2>
			<Card flush>
				<List label="Seen">
					{#each data.watched as item (item.id)}
						<ListRow title={item.name} meta={meta(item)} href={`/entertainment/${item.id}`} muted>
							{#snippet lead()}
								<CoverThumb cover={item.cover} />
							{/snippet}
							{#snippet trail()}
								{#if item.rating}
									<!-- The rating is a count, so the stars are presentation
									     over the stored number. The number is also given as
									     text, because a screen reader announcing five
									     identical glyphs says nothing useful. -->
									<Badge tone="accent">
										<span aria-hidden="true">{'★'.repeat(item.rating)}</span>
										<span class="visually-hidden">{item.rating} out of 5</span>
									</Badge>
								{/if}
							{/snippet}
						</ListRow>
					{/each}
				</List>
			</Card>
		</section>
	{/if}
</div>

<style>
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-6);
	}
	.section-title {
		margin: 0 0 var(--sp-3);
		font-size: var(--fs-lg);
		font-weight: 650;
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
