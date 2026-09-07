<script lang="ts">
	import { resolve } from '$app/paths';
	import { Card, LibraryList, PageHeader, appPath } from '$lib/components';

	let { data, form } = $props();
</script>

<svelte:head><title>Knowledge Hub · LifeOS</title></svelte:head>

<PageHeader title="Knowledge Hub" description="What you kept, and what is worth going back to.">
	{#snippet meta()}
		<span>{data.summary.highlights} highlights across {data.summary.total} entries</span>
	{/snippet}
</PageHeader>

{#if form?.error}<p class="notice error" role="alert">{form.error}</p>{/if}

<div class="stack">
	<section aria-labelledby="kept-heading">
		<h2 id="kept-heading" class="section-title">What you kept</h2>
		<LibraryList
			items={data.kept}
			emptyTitle="Nothing highlighted yet"
			emptyDescription="Entries you have taken passages out of show up here."
		/>
	</section>

	<section aria-labelledby="rediscover-heading">
		<h2 id="rediscover-heading" class="section-title">Worth rediscovering</h2>
		<p class="lede">
			Longest since you last opened it. Nothing here is overdue — it is just quiet.
		</p>
		<LibraryList
			items={data.rediscover}
			emptyTitle="Nothing to rediscover"
			emptyDescription="Once the library has some history, the things you have not opened in a while surface here."
		/>
	</section>

	{#if data.tags.length > 0}
		<section aria-labelledby="topics-heading">
			<h2 id="topics-heading" class="section-title">Topics</h2>
			<Card>
				<ul class="tags">
					{#each data.tags as tag (tag.id)}
						<li><a href={resolve(appPath('/topics'))}>{tag.name}</a></li>
					{/each}
				</ul>
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
		margin: 0 0 var(--sp-2);
		font-size: var(--fs-lg);
		font-weight: 650;
	}
	.lede {
		margin: 0 0 var(--sp-3);
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}
	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.tags a {
		display: inline-block;
		padding: 0.1rem var(--sp-3);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-pill);
		background: var(--c-surface-alt);
		font-size: var(--fs-xs);
		text-decoration: none;
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
