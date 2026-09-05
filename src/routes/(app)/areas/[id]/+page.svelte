<script lang="ts">
	import { enhance } from '$app/forms';
	import {
		Badge,
		Button,
		Card,
		EmptyState,
		Input,
		List,
		ListRow,
		PageHeader,
		Textarea
	} from '$lib/components';
	import Progress from '../../projects/Progress.svelte';
	import TagsCard from '../../projects/TagsCard.svelte';
	import {
		GOAL_STATUS_LABELS,
		GOAL_STATUS_TONES,
		PROJECT_STATUS_LABELS,
		PROJECT_STATUS_TONES,
		readableDay,
		reviewLabel,
		reviewTone
	} from '../../projects/status';

	let { data, form } = $props();

	const archived = $derived(data.area.archivedAt !== null);
	const isDone = (status: string) => status === 'done' || status === 'dropped';
	const due = (day: string | null) => (day ? readableDay(day, data.today) : '');

	const PER: Record<string, string> = { day: 'a day', week: 'a week', month: 'a month' };
</script>

<svelte:head><title>{data.area.name} · LifeOS</title></svelte:head>

<PageHeader
	title={data.area.icon ? `${data.area.icon} ${data.area.name}` : data.area.name}
	description={data.area.description ?? undefined}
	back={{ href: '/areas', label: 'Life areas' }}
>
	{#snippet meta()}
		<Badge tone={reviewTone(data.review)} dot>{reviewLabel(data.review)}</Badge>
		{#if archived}<Badge tone="neutral">Archived</Badge>{/if}
	{/snippet}
</PageHeader>

{#if form?.error}
	<p class="notice error" role="alert">{form.error}</p>
{:else if form?.saved}
	<p class="notice ok" role="status">Saved.</p>
{:else if form?.reviewed}
	<p class="notice ok" role="status">Marked as reviewed today.</p>
{/if}

<div class="columns">
	<div class="column">
		<Card
			title="Direct tasks"
			subtitle="Tasks pointing at this area rather than at one of its projects"
			flush
		>
			{#if data.tasks.length === 0}
				<EmptyState
					title="Nothing open here"
					description="Anything you put straight onto this area shows up here."
					icon="tasks"
				/>
			{:else}
				<List label="Direct tasks">
					{#each data.tasks as task (task.id)}
						<ListRow
							title={task.title}
							meta={due(task.due)}
							href={`/tasks/${task.id}`}
							muted={isDone(task.status)}
						>
							{#snippet lead()}
								<form method="POST" action="?/toggleTask" use:enhance>
									<input type="hidden" name="id" value={task.id} />
									<input type="hidden" name="updatedAt" value={task.updatedAt.toISOString()} />
									<input type="hidden" name="done" value={isDone(task.status) ? 'false' : 'true'} />
									<button
										class="tick"
										type="submit"
										aria-pressed={isDone(task.status)}
										aria-label={isDone(task.status)
											? `Reopen ${task.title}`
											: `Complete ${task.title}`}>{isDone(task.status) ? '✓' : ''}</button
									>
								</form>
							{/snippet}
						</ListRow>
					{/each}
				</List>
			{/if}

			<form method="POST" action="?/addTask" class="add" use:enhance>
				<div class="grow">
					<Input
						label="Add a task to this area"
						name="title"
						placeholder="Something to do"
						required
					/>
				</div>
				<Button type="submit">Add</Button>
			</form>
		</Card>

		<Card title="Projects" subtitle="Work that belongs to this area" flush>
			{#if data.projects.length === 0}
				<EmptyState
					title="No projects here"
					description="A project is linked to an area in the source workspace; that link is not editable here yet."
					icon="projects"
				/>
			{:else}
				<List label="Projects in this area">
					{#each data.projects as project (project.id)}
						<ListRow
							title={project.name}
							meta={project.dueOn ? `Due ${due(project.dueOn)}` : ''}
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

		<Card title="Goals" flush>
			{#if data.goals.length === 0}
				<EmptyState
					title="No goals here"
					description="Goals are linked to an area in the source workspace."
					icon="goals"
				/>
			{:else}
				<List label="Goals in this area">
					{#each data.goals as goal (goal.id)}
						<ListRow
							title={goal.title}
							meta={goal.targetDate ? `By ${due(goal.targetDate)}` : ''}
							href={`/goals/${goal.id}`}
						>
							{#snippet trail()}
								<Badge tone={GOAL_STATUS_TONES[goal.status]}>
									{GOAL_STATUS_LABELS[goal.status]}
								</Badge>
							{/snippet}
						</ListRow>
					{/each}
				</List>
			{/if}
		</Card>

		<Card title="Habits" flush>
			{#if data.habits.length === 0}
				<EmptyState
					title="No habits here"
					description="A habit is put into an area from the habit's own page."
					icon="habits"
				/>
			{:else}
				<List label="Habits in this area">
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
		<Card title="Review" subtitle="An area is never finished, so it gets looked at instead">
			<p class="state">
				<Badge tone={reviewTone(data.review)} dot>{reviewLabel(data.review)}</Badge>
			</p>
			<dl class="facts">
				<div>
					<dt>Last reviewed</dt>
					<dd>{data.area.lastReviewedOn ?? 'Never'}</dd>
				</div>
				<div>
					<dt>Cadence</dt>
					<dd>
						{data.area.reviewEveryDays ? `Every ${data.area.reviewEveryDays} days` : 'Not set'}
					</dd>
				</div>
				{#if data.review.nextDueOn}
					<div>
						<dt>Next due</dt>
						<dd>{data.review.nextDueOn}</dd>
					</div>
				{/if}
			</dl>

			<form method="POST" action="?/markReviewed" use:enhance>
				<!-- The version this form was rendered from. `.toISOString()` keeps
				     the milliseconds the precondition compares to. -->
				<input type="hidden" name="updatedAt" value={data.area.updatedAt.toISOString()} />
				<Button type="submit" variant="primary">Mark reviewed today</Button>
			</form>
		</Card>

		<Card title="Open direct tasks">
			<Progress progress={data.tasksProgress} of="{data.area.name} direct tasks" />
			<p class="note">
				{data.tasksProgress.open} open · {data.tasksProgress.closed} closed of {data.tasksProgress
					.total}.
				<span class="muted">Tasks reached through a project are counted on the project.</span>
			</p>
		</Card>

		<Card title="Details">
			<form method="POST" action="?/save" class="edit" use:enhance>
				<input type="hidden" name="updatedAt" value={data.area.updatedAt.toISOString()} />

				<Input label="Name" name="name" value={data.area.name} required />
				<Textarea
					label="Description"
					name="description"
					rows={3}
					value={data.area.description ?? ''}
				/>
				<div class="grid">
					<Input
						label="Icon"
						name="icon"
						value={data.area.icon ?? ''}
						maxlength={40}
						hint="One character or emoji"
					/>
					<Input
						label="Review every"
						name="reviewEveryDays"
						type="number"
						min={1}
						max={3650}
						value={data.area.reviewEveryDays === null ? '' : String(data.area.reviewEveryDays)}
						hint="Days between reviews"
					/>
					<Input
						label="Order"
						name="sortOrder"
						type="number"
						value={String(data.area.sortOrder)}
						hint="Lower comes first"
					/>
				</div>
				<div>
					<Button type="submit" variant="primary">Save</Button>
				</div>
			</form>
		</Card>

		<TagsCard tags={data.tags.tags} available={data.tags.available} of={data.area.name} />

		<Card title={archived ? 'Restore' : 'Archive'}>
			<p class="muted">
				{archived
					? 'This area is archived and hidden from the list. Restoring brings it back.'
					: 'Archiving hides this area without deleting it. Its projects, goals and tasks are untouched.'}
			</p>
			<form method="POST" action="?/archive" use:enhance>
				<input type="hidden" name="updatedAt" value={data.area.updatedAt.toISOString()} />
				<input type="hidden" name="archived" value={archived ? 'false' : 'true'} />
				<Button type="submit" variant={archived ? 'primary' : 'ghost'}>
					{archived ? 'Restore area' : 'Archive area'}
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
	/* Two columns at a desk: what the area contains on the left, what to do
	   about it on the right. */
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
		grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
	}

	.add {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-3);
		align-items: flex-end;
		padding: var(--sp-3);
		border-top: 1px solid var(--c-border);
	}
	/* The wrapper grows, not the <label> inside it. Field lays a label and its
	   control out in a column, so a flex rule on the label stretches the label
	   itself and leaves a hole above the control. */
	.add .grow {
		flex: 1 1 12rem;
		min-width: 0;
	}

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

	.bar {
		width: 100%;
		max-width: 22rem;
	}

	.state {
		margin: 0 0 var(--sp-3);
	}

	.facts {
		margin: 0 0 var(--sp-4);
	}
	.facts div {
		display: flex;
		justify-content: space-between;
		gap: var(--sp-3);
		padding: var(--sp-1) 0;
		border-bottom: 1px solid var(--c-border);
	}
	.facts dt {
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}
	.facts dd {
		margin: 0;
		font-size: var(--fs-sm);
		font-weight: 600;
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
