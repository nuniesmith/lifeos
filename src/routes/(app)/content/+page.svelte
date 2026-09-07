<script lang="ts">
	import { resolve } from '$app/paths';
	import { Card, EmptyState, List, ListRow, PageHeader, appPath } from '$lib/components';
	let { data } = $props();
</script>

<svelte:head><title>Content Creation · LifeOS</title></svelte:head>

<PageHeader title="Content Creation" description="Nothing has been filed here yet." />

<div class="stack">
	<Card>
		<!-- The honest version. The alternative was a studio of tiles for drafts
		     and publishing that nothing stands behind, which reads as a broken
		     feature rather than an unused one. -->
		<EmptyState
			title="This page holds no records"
			description="The Content Creation page in the source workspace is a dashboard shell — no database, no entries. Rather than invent a drafts pipeline, here is where the creative work actually lives today."
			icon="journal"
		/>
	</Card>

	<Card>
		<ul class="links">
			<li>
				<a href={resolve(appPath('/inbox'))}>
					<strong>{data.waiting}</strong> idea{data.waiting === 1 ? '' : 's'} waiting in the inbox
				</a>
			</li>
			<li><a href={resolve(appPath('/brain-dump'))}>Brain dump — get a half-formed one down</a></li>
			<li>
				<a href={resolve(appPath('/projects'))}>Projects — where a piece of work gets a shape</a>
			</li>
		</ul>
	</Card>

	{#if data.references.length > 0}
		<section aria-labelledby="refs-heading">
			<h2 id="refs-heading" class="section-title">Worth drawing on</h2>
			<Card flush>
				<List label="Library entries you have kept something out of">
					{#each data.references as ref (ref.id)}
						<ListRow title={ref.title} href={`/library/${ref.id}`} meta={ref.author ?? undefined} />
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
		gap: var(--sp-4);
	}
	.section-title {
		margin: 0 0 var(--sp-3);
		font-size: var(--fs-lg);
		font-weight: 650;
	}
	.links {
		display: grid;
		gap: var(--sp-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.links a {
		color: var(--c-text);
		font-size: var(--fs-sm);
		text-decoration: none;
	}
	.links a:hover {
		text-decoration: underline;
	}
</style>
