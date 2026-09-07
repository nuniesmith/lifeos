<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { Badge, Button, Card, EmptyState, Input, PageHeader, appPath } from '$lib/components';
	import Progress from '../projects/Progress.svelte';
	import { reviewLabel, reviewTone } from '../projects/status';

	let { data, form } = $props();

	const VIEW_LABELS: Record<string, string> = {
		all: 'All areas',
		review: 'Needs review',
		archived: 'Archived'
	};
</script>

<svelte:head><title>Life areas · LifeOS</title></svelte:head>

<PageHeader title="Life areas" description="The parts of life that are never finished.">
	{#snippet meta()}
		<Badge tone={data.dueCount > 0 ? 'warn' : 'ok'} dot>
			{data.dueCount} due a review
		</Badge>
	{/snippet}
	{#snippet actions()}
		<Button size="sm" href="/topics">Tags</Button>
	{/snippet}
</PageHeader>

{#if form?.error}
	<p class="notice error" role="alert">{form.error}</p>
{/if}

<nav class="views" aria-label="Area views">
	{#each data.views as view (view)}
		<a
			href={resolve(appPath(`/areas?view=${view}`))}
			class="chip"
			class:current={view === data.view}
			aria-current={view === data.view ? 'page' : undefined}
		>
			{VIEW_LABELS[view]}
		</a>
	{/each}
</nav>

<Card>
	<form method="POST" action="?/create" class="add" use:enhance>
		<div class="grow">
			<Input label="New area" name="name" placeholder="Home, Health, Money…" required />
		</div>
		<Button type="submit">Add</Button>
	</form>
</Card>

{#if data.areas.length === 0}
	<div class="empty">
		<EmptyState
			title={data.view === 'review' ? 'Nothing is waiting on you' : 'No areas here'}
			description={data.view === 'review'
				? 'Every area with a cadence has been looked at recently.'
				: 'Areas group the projects, goals and habits that belong together.'}
			icon="areas"
		/>
	</div>
{:else}
	<!--
		A grid rather than a list. Areas are few and each carries four numbers, so
		on a phone they stack and on a desk they sit side by side — which is where
		this page is read, during a weekly or monthly review.
	-->
	<ul class="grid">
		{#each data.areas as area (area.id)}
			<li class="tile" class:muted={area.archived}>
				<div class="head">
					{#if area.icon}<span class="icon" aria-hidden="true">{area.icon}</span>{/if}
					<h2>
						<a class="stretched" href={resolve(appPath(`/areas/${area.id}`))}>{area.name}</a>
					</h2>
				</div>

				{#if area.description}<p class="description">{area.description}</p>{/if}

				<div class="badges">
					<Badge tone={reviewTone(area.review)}>{reviewLabel(area.review)}</Badge>
					{#if area.archived}<Badge tone="neutral">Archived</Badge>{/if}
				</div>

				<Progress progress={area.tasks} of="{area.name} direct tasks" />

				<p class="counts numeric">
					{area.tasks.open} open direct task{area.tasks.open === 1 ? '' : 's'} ·
					{area.openProjects} open project{area.openProjects === 1 ? '' : 's'}
				</p>
			</li>
		{/each}
	</ul>

	<p class="footnote">
		“Direct” means a task pointing at the area itself, not one reached through a project — the
		source workspace's own rollup could not be reproduced, so the strict reading is used and named.
	</p>
{/if}

<style>
	.views {
		display: flex;
		gap: var(--sp-2);
		overflow-x: auto;
		padding-bottom: var(--sp-2);
		margin-bottom: var(--sp-4);
	}
	.chip {
		flex: 0 0 auto;
		padding: var(--sp-1) var(--sp-3);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-pill);
		font-size: var(--fs-sm);
		text-decoration: none;
		color: var(--c-text-muted);
		background: var(--c-surface);
		min-height: var(--tap);
		display: inline-flex;
		align-items: center;
	}
	.chip.current {
		background: var(--c-accent-soft);
		border-color: var(--c-accent);
		color: var(--c-text);
		font-weight: 600;
	}

	.add {
		display: flex;
		gap: var(--sp-3);
		align-items: flex-end;
	}
	/* The wrapper grows, not the <label> inside it. Field lays a label and its
	   control out in a column, so a flex rule on the label stretches the label
	   itself and leaves a hole above the control. */
	.add .grow {
		flex: 1;
		min-width: 0;
	}

	.empty {
		margin-top: var(--sp-4);
	}

	.grid {
		display: grid;
		grid-template-columns: 1fr;
		gap: var(--sp-4);
		margin: var(--sp-4) 0 0;
		padding: 0;
		list-style: none;
	}
	@media (min-width: 40rem) {
		.grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	@media (min-width: 72rem) {
		.grid {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
	}

	.tile {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: var(--sp-2);
		min-width: 0;
		padding: var(--sp-4);
		border: 1px solid var(--c-border);
		border-radius: var(--radius);
		background: var(--c-surface);
		box-shadow: var(--shadow);
	}
	.tile:has(.stretched:hover),
	.tile:has(.stretched:focus-visible) {
		border-color: var(--c-accent);
	}
	/* The outline belongs to the tile, not to the invisible stretched link. */
	.tile:has(.stretched:focus-visible) {
		outline: 2px solid var(--c-accent);
		outline-offset: 2px;
	}
	.stretched:focus-visible {
		outline: none;
	}
	.stretched::after {
		content: '';
		position: absolute;
		inset: 0;
	}

	.muted {
		opacity: 0.7;
	}

	.head {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		min-width: 0;
	}
	.icon {
		font-size: var(--fs-lg);
		line-height: 1;
	}
	h2 {
		margin: 0;
		font-size: var(--fs-lg);
		overflow-wrap: anywhere;
	}
	h2 a {
		color: var(--c-text);
		text-decoration: none;
	}

	.description {
		margin: 0;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
		/* Two lines at most: a tile is a summary, and the area's own page is
		   where the whole description belongs. */
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
	}

	.badges {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-2);
	}

	.counts {
		margin: 0;
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
	}

	.footnote {
		margin-top: var(--sp-6);
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
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
