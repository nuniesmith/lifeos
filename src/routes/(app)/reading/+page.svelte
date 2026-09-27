<script lang="ts">
	import { Button, LibraryList, PageHeader } from '$lib/components';

	let { data, form } = $props();
</script>

<svelte:head><title>Reading Tracker · LifeOS</title></svelte:head>

<PageHeader title="Reading Tracker" description="What you mean to get to, and what you got to.">
	{#snippet meta()}
		<span>{data.items.length} on the list</span>
	{/snippet}
	{#snippet actions()}
		<!-- Lands straight on the reading list rather than in the inbox
		     everything else added from /library starts in. -->
		<Button href="/library/new?status=reading_list" variant="primary" icon="plus">
			Add to reading list
		</Button>
	{/snippet}
</PageHeader>

{#if form?.error}<p class="notice error" role="alert">{form.error}</p>{/if}

<div class="stack">
	<section aria-labelledby="list-heading">
		<h2 id="list-heading" class="section-title">On the list</h2>
		<LibraryList
			items={data.items}
			emptyTitle="Nothing on the reading list"
			emptyDescription="Move something here from the library when you mean to read it."
		/>
	</section>

	{#if data.finished.length > 0}
		<section aria-labelledby="finished-heading">
			<h2 id="finished-heading" class="section-title">Finished</h2>
			<LibraryList items={data.finished} emptyTitle="Nothing finished yet" trackOpens={false} />
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
