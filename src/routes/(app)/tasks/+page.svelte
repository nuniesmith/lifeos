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
		Select,
		appPath
	} from '$lib/components';
	import { TASK_CATEGORY_OPTIONS, WORKDAY_THEME_OPTIONS } from '$lib/daily-planning';

	let { data, form } = $props();

	const VIEW_LABELS: Record<string, string> = {
		today: 'Today',
		week: 'This week',
		overdue: 'Overdue',
		open: 'Open',
		done: 'Done',
		dropped: 'Dropped',
		all: 'All'
	};

	/** A due date read the way a person reads it, not as an ISO string. */
	function due(task: { doOn: string | null; deadlineOn: string | null }): string {
		const day = task.doOn ?? task.deadlineOn;
		if (!day) return '';
		if (day === data.today) return 'Today';
		const delta = Math.round(
			(Date.parse(`${day}T00:00:00Z`) - Date.parse(`${data.today}T00:00:00Z`)) / 86_400_000
		);
		if (delta === 1) return 'Tomorrow';
		if (delta === -1) return 'Yesterday';
		if (delta < 0) return `${Math.abs(delta)} days ago`;
		if (delta < 7) return `in ${delta} days`;
		return day;
	}

	const isDone = (status: string) => status === 'done' || status === 'dropped';
</script>

<svelte:head><title>Tasks · LifeOS</title></svelte:head>

<PageHeader title="Tasks" />

{#if form?.error}
	<p class="error" role="alert">{form.error}</p>
{/if}

<nav class="views" aria-label="Task views">
	{#each data.views as view (view)}
		<a
			href={resolve(appPath(`/tasks?view=${view}`))}
			class="chip"
			class:current={view === data.view}
			aria-current={view === data.view ? 'page' : undefined}
		>
			{VIEW_LABELS[view]}
		</a>
	{/each}
</nav>

<form method="GET" class="theme-filters">
	<input type="hidden" name="view" value={data.view} />
	{#if data.search}<input type="hidden" name="q" value={data.search} />{/if}
	<Select
		label="Theme"
		name="theme"
		options={WORKDAY_THEME_OPTIONS}
		value={data.theme}
		placeholder="Any theme"
	/>
	<Select
		label="List"
		name="category"
		options={TASK_CATEGORY_OPTIONS}
		value={data.category}
		placeholder="Any list"
	/>
	<Button type="submit" size="sm">Filter</Button>
</form>

<Card>
	<form method="POST" action="?/create" class="add" use:enhance>
		<Input label="New task" name="title" placeholder="What needs doing?" required />
		<Button type="submit">Add</Button>
	</form>
</Card>

{#if data.tasks.length === 0}
	<EmptyState
		title="Nothing here"
		description={data.view === 'open'
			? 'No open tasks. Add one above.'
			: `No tasks in ${VIEW_LABELS[data.view]?.toLowerCase()}.`}
	/>
{:else}
	<List>
		{#each data.tasks as task (task.id)}
			<ListRow
				title={task.title}
				meta={due(task)}
				href={`/tasks/${task.id}`}
				muted={isDone(task.status)}
			>
				{#snippet lead()}
					<form method="POST" action="?/toggle" use:enhance>
						<input type="hidden" name="id" value={task.id} />
						<input type="hidden" name="updatedAt" value={task.updatedAt.toISOString()} />
						<input type="hidden" name="done" value={isDone(task.status) ? 'false' : 'true'} />
						<button
							class="tick"
							type="submit"
							aria-pressed={isDone(task.status)}
							aria-label={isDone(task.status) ? `Reopen ${task.title}` : `Complete ${task.title}`}
						>
							{isDone(task.status) ? '✓' : ''}
						</button>
					</form>
				{/snippet}
				{#snippet trail()}
					{#if task.isImportant}<Badge tone="warn">Important</Badge>{/if}
				{/snippet}
			</ListRow>
		{/each}
	</List>
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
		/* Comfortable to hit with a thumb without making the strip tall. */
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
	.add :global(label) {
		flex: 1;
	}
	.theme-filters {
		display: flex;
		gap: var(--sp-3);
		align-items: flex-end;
		margin-bottom: var(--sp-4);
	}
	.theme-filters :global(.field) {
		flex: 1;
		min-width: 0;
	}
	/* The whole row is a link; the tick has to sit above it and stay a
	   44px target without making every row that tall. */
	.tick {
		width: var(--tap);
		height: var(--tap);
		min-height: var(--tap);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-sm);
		background: var(--c-surface);
		cursor: pointer;
		font-size: var(--fs-lg);
		line-height: 1;
		color: var(--c-ok);
	}
	.error {
		color: var(--c-crit);
		border: 1px solid color-mix(in srgb, var(--c-crit) 25%, transparent);
		background: color-mix(in srgb, var(--c-crit) 8%, transparent);
		border-radius: var(--radius-sm);
		padding: var(--sp-2) var(--sp-3);
	}
</style>
