<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import {
		Badge,
		Button,
		Card,
		EmptyState,
		Input,
		List,
		ListRow,
		PageHeader,
		appPath
	} from '$lib/components';
	import Progress from './Progress.svelte';
	import { PROJECT_STATUS_LABELS, PROJECT_STATUS_TONES, readableDay } from './status';

	let { data, form } = $props();

	const VIEW_LABELS: Record<string, string> = {
		open: 'Open',
		active: 'Active',
		on_hold: 'On hold',
		done: 'Finished',
		all: 'All',
		archived: 'Archived'
	};

	const openCount = $derived(data.projects.length);

	/** The due date line, or the area names when there is no date. */
	function line(project: (typeof data.projects)[number]): string {
		const due = readableDay(project.dueOn, data.today);
		const areas = project.areas.map((area) => area.name).join(', ');
		if (due && areas) return `Due ${due} · ${areas}`;
		if (due) return `Due ${due}`;
		return areas;
	}
</script>

<svelte:head><title>Projects · LifeOS</title></svelte:head>

<PageHeader title="Projects" description="What is running, and how far along it is.">
	{#snippet meta()}
		<Badge tone="neutral" dot>{openCount} shown</Badge>
		{#if data.overdue > 0}
			<Badge tone="crit" dot>{data.overdue} overdue task{data.overdue === 1 ? '' : 's'}</Badge>
		{/if}
	{/snippet}
</PageHeader>

{#if form?.error}
	<p class="notice error" role="alert">{form.error}</p>
{/if}

<nav class="views" aria-label="Project views">
	{#each data.views as view (view)}
		<a
			href={resolve(appPath(`/projects?view=${view}`))}
			class="chip"
			class:current={view === data.view}
			aria-current={view === data.view ? 'page' : undefined}
		>
			{VIEW_LABELS[view]}
		</a>
	{/each}
</nav>

<div class="stack">
	<Card>
		<form method="POST" action="?/create" class="add" use:enhance>
			<div class="grow">
				<Input
					label="New project"
					name="name"
					placeholder="Something with more than one step"
					required
				/>
			</div>
			<Button type="submit">Add</Button>
		</form>
	</Card>

	<Card flush>
		{#if data.projects.length === 0}
			<EmptyState
				title="Nothing here"
				description={data.view === 'open'
					? 'No open projects. Add one above.'
					: `No projects in ${VIEW_LABELS[data.view]?.toLowerCase()}.`}
				icon="projects"
			/>
		{:else}
			<List label="Projects">
				{#each data.projects as project (project.id)}
					<ListRow
						title={project.name}
						meta={line(project)}
						href={`/projects/${project.id}`}
						muted={project.archived}
					>
						{#snippet trail()}
							<Badge tone={PROJECT_STATUS_TONES[project.status]}>
								{PROJECT_STATUS_LABELS[project.status]}
							</Badge>
						{/snippet}
						<div class="bar">
							<Progress progress={project.progress} of={project.name} />
						</div>
					</ListRow>
				{/each}
			</List>
		{/if}
	</Card>
</div>

<style>
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}

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

	/* The bar is the width of the row on a phone; on a desk it would stretch to
	   a metre of screen and stop being readable, so it is capped. */
	.bar {
		width: 100%;
		max-width: 22rem;
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
