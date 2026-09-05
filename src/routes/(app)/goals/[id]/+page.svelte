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
		Textarea,
		appPath
	} from '$lib/components';
	import Progress from '../../projects/Progress.svelte';
	import TagsCard from '../../projects/TagsCard.svelte';
	import {
		GOAL_STATUS_LABELS,
		GOAL_STATUS_TONES,
		PROJECT_STATUS_LABELS,
		PROJECT_STATUS_TONES,
		optionsOf,
		readableDay
	} from '../../projects/status';

	let { data, form } = $props();

	const STATUSES = optionsOf(GOAL_STATUS_LABELS);
	const archived = $derived(data.goal.archivedAt !== null);

	const PER: Record<string, string> = { day: 'a day', week: 'a week', month: 'a month' };
</script>

<svelte:head><title>{data.goal.title} · LifeOS</title></svelte:head>

<PageHeader title={data.goal.title} back={{ href: '/goals', label: 'Goals' }}>
	{#snippet meta()}
		<Badge tone={GOAL_STATUS_TONES[data.goal.status]} dot>
			{GOAL_STATUS_LABELS[data.goal.status]}
		</Badge>
		{#if archived}<Badge tone="neutral">Archived</Badge>{/if}
		{#if data.goal.targetDate}<span>By {readableDay(data.goal.targetDate, data.today)}</span>{/if}
		{#if data.goal.achievedOn}<span>Achieved {data.goal.achievedOn}</span>{/if}
	{/snippet}
</PageHeader>

{#if form?.error}
	<p class="notice error" role="alert">{form.error}</p>
{:else if form?.saved}
	<p class="notice ok" role="status">Saved.</p>
{/if}

<div class="columns">
	<div class="column">
		<Card title="Details">
			<form method="POST" action="?/save" class="edit" use:enhance>
				<!-- The version this form was rendered from. `.toISOString()` is
				     required: a Date interpolated directly loses its milliseconds,
				     which the precondition compares, and every save then 409s. -->
				<input type="hidden" name="updatedAt" value={data.goal.updatedAt.toISOString()} />

				<Input label="Goal" name="title" value={data.goal.title} required />
				<Textarea
					label="Description"
					name="description"
					rows={3}
					value={data.goal.description ?? ''}
				/>
				<div class="grid">
					<Select label="Status" name="status" options={STATUSES} value={data.goal.status} />
					<Input
						label="Target date"
						name="targetDate"
						type="date"
						value={data.goal.targetDate ?? ''}
					/>
				</div>
				<div>
					<Button type="submit" variant="primary">Save</Button>
				</div>
			</form>
		</Card>

		<Card title="Projects" subtitle="The work this goal is made of" flush>
			{#if data.projects.length === 0}
				<EmptyState
					title="No projects yet"
					description="Projects are linked to a goal in the source workspace; that link is not editable here yet."
					icon="projects"
				/>
			{:else}
				<List label="Projects for this goal">
					{#each data.projects as project (project.id)}
						<ListRow
							title={project.name}
							meta={project.dueOn ? `Due ${readableDay(project.dueOn, data.today)}` : ''}
							href={`/projects/${project.id}`}
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

		<Card
			title="Habits in these areas"
			subtitle="A habit belongs to a life area, so these are the habits under this goal's areas"
			flush
		>
			{#if data.habits.length === 0}
				<EmptyState
					title="No habits here"
					description="Habits are attached to an area from the habit itself."
					icon="habits"
				/>
			{:else}
				<List label="Habits">
					{#each data.habits as habit (habit.id)}
						<ListRow
							title={habit.name}
							meta={`${habit.targetCount}× ${PER[habit.targetPeriod] ?? habit.targetPeriod}`}
							href={`/habits/${habit.id}`}
							muted={!habit.active}
						>
							{#snippet trail()}
								{#if !habit.active}<Badge tone="neutral">Paused</Badge>{/if}
							{/snippet}
						</ListRow>
					{/each}
				</List>
			{/if}
		</Card>
	</div>

	<div class="column">
		<Card title="Progress" subtitle="Added up from the tasks in this goal's projects">
			<Progress progress={data.progress} of={data.goal.title} />
			{#if data.progress.total > 0}
				<p class="note">
					{data.progress.open} open · {data.progress.closed} closed of {data.progress.total} across {data
						.projects.length}
					project{data.projects.length === 1 ? '' : 's'}.
					<span class="muted">Closed means done or dropped.</span>
				</p>
			{:else}
				<p class="note muted">
					Nothing countable underneath this goal yet, so there is no percentage to show.
				</p>
			{/if}
		</Card>

		<Card title="Life areas" subtitle="Where this goal sits">
			{#if data.areas.length === 0}
				<p class="muted">Not in an area yet.</p>
			{:else}
				<ul class="chips">
					{#each data.areas as area (area.id)}
						<li><a href={resolve(appPath(`/areas/${area.id}`))}>{area.name}</a></li>
					{/each}
				</ul>
			{/if}
			<p class="muted small">Set when this was imported.</p>
		</Card>

		<TagsCard tags={data.tags.tags} available={data.tags.available} of={data.goal.title} />

		<Card title={archived ? 'Restore' : 'Archive'}>
			<p class="muted">
				{archived
					? 'This goal is archived and hidden from the lists. Restoring brings it back.'
					: 'Archiving hides this goal without deleting it. Its projects are untouched.'}
			</p>
			<form method="POST" action="?/archive" use:enhance>
				<input type="hidden" name="updatedAt" value={data.goal.updatedAt.toISOString()} />
				<input type="hidden" name="archived" value={archived ? 'false' : 'true'} />
				<Button type="submit" variant={archived ? 'primary' : 'ghost'}>
					{archived ? 'Restore goal' : 'Archive goal'}
				</Button>
			</form>
		</Card>
	</div>
</div>

<style>
	.columns {
		display: grid;
		grid-template-columns: 1fr;
		gap: var(--sp-4);
		align-items: start;
	}
	/* Two columns at a desk, where a goal is actually reviewed. */
	@media (min-width: 60rem) {
		.columns {
			grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr);
		}
	}

	.column {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
		min-width: 0;
	}

	.edit {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}
	/* Auto-fit rather than a media query: these forms sit in a column whose
	   width depends on the layout, not on the viewport, so asking for two
	   columns at a viewport size squeezes them in a narrow aside. */
	.grid {
		display: grid;
		gap: var(--sp-3);
		grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
	}

	.bar {
		width: 100%;
		max-width: 22rem;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-2);
		margin: 0 0 var(--sp-3);
		padding: 0;
		list-style: none;
	}
	.chips a {
		display: inline-block;
		padding: 0.1rem var(--sp-3);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-pill);
		background: var(--c-surface-alt);
		font-size: var(--fs-xs);
		text-decoration: none;
	}

	.note {
		margin: var(--sp-3) 0 0;
		font-size: var(--fs-sm);
	}
	.muted {
		margin: 0;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}
	.small {
		margin-top: var(--sp-2);
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
	.notice.ok {
		color: var(--c-ok);
		border: 1px solid color-mix(in srgb, var(--c-ok) 25%, transparent);
		background: color-mix(in srgb, var(--c-ok) 8%, transparent);
	}
</style>
