<script lang="ts">
	import { Badge, Card, EmptyState, List, ListRow, PageHeader } from '$lib/components';
	let { data } = $props();
</script>

<svelte:head><title>Etsy Store · LifeOS</title></svelte:head>

<PageHeader
	title={data.area?.name ?? 'Etsy Store'}
	description={data.area?.description ?? 'The making, listing and selling side of things.'}
>
	{#snippet meta()}
		{#if data.area}
			<span
				>{data.projects.length} project{data.projects.length === 1 ? '' : 's'} · {data.tasks.length} open</span
			>
		{/if}
	{/snippet}
</PageHeader>

<div class="stack">
	{#if !data.area}
		<Card>
			<!-- Said plainly rather than shown as an empty frame: an empty frame
			     reads as a broken feature, and this one is simply not set up. -->
			<EmptyState
				title="No store area yet"
				description="The Etsy Store Manager page in the source workspace holds no records — it is a dashboard shell. Make a life area called Etsy Store and the projects and tasks filed under it will show up here."
				icon="projects"
			/>
		</Card>
	{:else}
		<section aria-labelledby="projects-heading">
			<h2 id="projects-heading" class="section-title">Projects</h2>
			<Card flush>
				{#if data.projects.length === 0}
					<EmptyState title="No projects under this area" icon="projects" />
				{:else}
					<List label="Store projects">
						{#each data.projects as project (project.id)}
							<ListRow
								title={project.name}
								href={`/projects/${project.id}`}
								meta={project.dueOn ?? undefined}
							>
								{#snippet trail()}<Badge tone="neutral">{project.status}</Badge>{/snippet}
							</ListRow>
						{/each}
					</List>
				{/if}
			</Card>
		</section>

		<section aria-labelledby="tasks-heading">
			<h2 id="tasks-heading" class="section-title">Open work</h2>
			<Card flush>
				{#if data.tasks.length === 0}
					<EmptyState
						title="Nothing open"
						description="Everything filed under this area is done."
						icon="check"
					/>
				{:else}
					<List label="Open store tasks">
						{#each data.tasks as task (task.id)}
							<ListRow
								title={task.title}
								href={`/tasks/${task.id}`}
								meta={task.doOn ?? undefined}
							/>
						{/each}
					</List>
				{/if}
			</Card>
		</section>

		<p class="footnote">
			The source's Etsy Store Manager page holds no records of its own — it is a dashboard shell.
			This shows the work already filed under the matching life area instead.
		</p>
	{/if}
</div>

<style>
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-5);
	}
	.section-title {
		margin: 0 0 var(--sp-3);
		font-size: var(--fs-lg);
		font-weight: 650;
	}
	.footnote {
		margin: 0;
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
	}
</style>
