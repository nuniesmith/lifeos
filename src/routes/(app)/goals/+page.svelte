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
	import { GOAL_STATUS_LABELS, GOAL_STATUS_TONES, readableDay } from '../projects/status';

	let { data, form } = $props();

	const VIEW_LABELS: Record<string, string> = {
		active: 'Active',
		paused: 'Paused',
		achieved: 'Achieved',
		all: 'All',
		archived: 'Archived'
	};

	/** Target date and areas, on the one line a row can carry. */
	function line(goal: (typeof data.goals)[number]): string {
		const target = goal.targetDate ? `By ${readableDay(goal.targetDate, data.today)}` : '';
		const areas = goal.areas.map((area) => area.name).join(', ');
		if (target && areas) return `${target} · ${areas}`;
		return target || areas;
	}
</script>

<svelte:head><title>Goals · LifeOS</title></svelte:head>

<PageHeader title="Goals" description="What the projects are in aid of.">
	{#snippet meta()}
		<Badge tone="neutral" dot>{data.goals.length} shown</Badge>
	{/snippet}
</PageHeader>

{#if form?.error}
	<p class="notice error" role="alert">{form.error}</p>
{/if}

<nav class="views" aria-label="Goal views">
	{#each data.views as view (view)}
		<a
			href={resolve(appPath(`/goals?view=${view}`))}
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
				<Input label="New goal" name="title" placeholder="Something worth a year" required />
			</div>
			<Button type="submit">Add</Button>
		</form>
	</Card>

	<Card flush>
		{#if data.goals.length === 0}
			<EmptyState
				title="Nothing here"
				description={data.view === 'active'
					? 'No active goals. Add one above.'
					: `No goals in ${VIEW_LABELS[data.view]?.toLowerCase()}.`}
				icon="goals"
			/>
		{:else}
			<List label="Goals">
				{#each data.goals as goal (goal.id)}
					<ListRow
						title={goal.title}
						meta={line(goal)}
						href={`/goals/${goal.id}`}
						muted={goal.archived}
					>
						{#snippet trail()}
							<Badge tone={GOAL_STATUS_TONES[goal.status]}>{GOAL_STATUS_LABELS[goal.status]}</Badge>
						{/snippet}
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
