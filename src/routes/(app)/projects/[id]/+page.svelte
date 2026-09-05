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
	import Progress from '../Progress.svelte';
	import TagsCard from '../TagsCard.svelte';
	import { PROJECT_STATUS_LABELS, PROJECT_STATUS_TONES, optionsOf, readableDay } from '../status';

	let { data, form } = $props();

	const STATUSES = optionsOf(PROJECT_STATUS_LABELS);

	const archived = $derived(data.project.archivedAt !== null);
	const isDone = (status: string) => status === 'done' || status === 'dropped';

	const due = (day: string | null) => (day ? readableDay(day, data.today) : '');
</script>

<svelte:head><title>{data.project.name} · LifeOS</title></svelte:head>

<PageHeader title={data.project.name} back={{ href: '/projects', label: 'Projects' }}>
	{#snippet meta()}
		<Badge tone={PROJECT_STATUS_TONES[data.project.status]} dot>
			{PROJECT_STATUS_LABELS[data.project.status]}
		</Badge>
		{#if archived}<Badge tone="neutral">Archived</Badge>{/if}
		{#if data.project.dueOn}<span>Due {due(data.project.dueOn)}</span>{/if}
		{#if data.project.completedOn}<span>Finished {data.project.completedOn}</span>{/if}
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
				<!-- The version this form was rendered from, so a save from a stale
				     tab is refused rather than silently overwriting.
				     `.toISOString()` is required: interpolating the Date uses its
				     toString(), which drops the milliseconds the precondition
				     compares — and then every save returns 409. -->
				<input type="hidden" name="updatedAt" value={data.project.updatedAt.toISOString()} />

				<Input label="Name" name="name" value={data.project.name} required />
				<Textarea
					label="Description"
					name="description"
					rows={3}
					value={data.project.description ?? ''}
				/>

				<div class="grid">
					<Select label="Status" name="status" options={STATUSES} value={data.project.status} />
					<Input label="Starts" name="startOn" type="date" value={data.project.startOn ?? ''} />
					<Input label="Due" name="dueOn" type="date" value={data.project.dueOn ?? ''} />
				</div>

				<div>
					<Button type="submit" variant="primary">Save</Button>
				</div>
			</form>
		</Card>

		<Card
			title="Milestones"
			subtitle="The moments worth naming. They are tasks, and they count towards progress."
			flush
		>
			{#if data.milestones.length === 0}
				<EmptyState
					title="No milestones"
					description="Add one for a point this project has to pass."
					icon="goals"
				/>
			{:else}
				<List label="Milestones">
					{#each data.milestones as milestone (milestone.id)}
						<ListRow
							title={milestone.title}
							meta={due(milestone.due)}
							href={`/tasks/${milestone.id}`}
							muted={isDone(milestone.status)}
						>
							{#snippet lead()}
								<form method="POST" action="?/toggleTask" use:enhance>
									<input type="hidden" name="id" value={milestone.id} />
									<input type="hidden" name="updatedAt" value={milestone.updatedAt.toISOString()} />
									<input
										type="hidden"
										name="done"
										value={isDone(milestone.status) ? 'false' : 'true'}
									/>
									<button
										class="tick"
										type="submit"
										aria-pressed={isDone(milestone.status)}
										aria-label={isDone(milestone.status)
											? `Reopen ${milestone.title}`
											: `Complete ${milestone.title}`}>{isDone(milestone.status) ? '✓' : ''}</button
									>
								</form>
							{/snippet}
						</ListRow>
					{/each}
				</List>
			{/if}

			<form method="POST" action="?/addTask" class="add" use:enhance>
				<input type="hidden" name="kind" value="milestone" />
				<div class="grow">
					<Input
						label="Add a milestone"
						name="title"
						placeholder="Kitchen ready to paint"
						required
					/>
				</div>
				<div class="when">
					<Input label="By" name="deadlineOn" type="date" />
				</div>
				<Button type="submit">Add</Button>
			</form>
		</Card>

		<Card title="Tasks" flush>
			{#if data.tasks.length === 0}
				<EmptyState
					title="No tasks yet"
					description="A project with no tasks is a wish. Add the first step."
					icon="tasks"
				/>
			{:else}
				<List label="Tasks">
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
				<input type="hidden" name="kind" value="task" />
				<div class="grow">
					<Input label="Add a task" name="title" placeholder="Next small step" required />
				</div>
				<Button type="submit">Add</Button>
			</form>
		</Card>
	</div>

	<div class="column">
		<Card title="Progress" subtitle="Counted from the tasks themselves, every time this page loads">
			<Progress progress={data.progress} of={data.project.name} />
			<p class="note">
				{data.progress.open} open · {data.progress.closed} closed of {data.progress.total}.
				<span class="muted">Closed means done or dropped.</span>
			</p>
			{#if data.progress.overdue > 0}
				<p class="note">
					<Badge tone="crit" dot
						>{data.progress.overdue} overdue task{data.progress.overdue === 1 ? '' : 's'}</Badge
					>
				</p>
			{/if}
		</Card>

		<Card title="Life areas" subtitle="Where this project sits">
			{#if data.areas.length === 0}
				<p class="muted">Not in an area yet.</p>
			{:else}
				<ul class="chips">
					{#each data.areas as area (area.id)}
						<li><a href={resolve(appPath(`/areas/${area.id}`))}>{area.name}</a></li>
					{/each}
				</ul>
			{/if}
			<!-- Read-only on purpose: project-to-area links live in a join table
			     that only the importer writes. Offering an "add" here would be a
			     control that cannot do anything. -->
			<p class="muted small">Set when this was imported.</p>
		</Card>

		<TagsCard tags={data.tags.tags} available={data.tags.available} of={data.project.name} />

		<Card title={archived ? 'Restore' : 'Archive'}>
			<p class="muted">
				{archived
					? 'This project is archived and hidden from the lists. Restoring brings it back.'
					: 'Archiving hides this project without deleting it. Its tasks are untouched.'}
			</p>
			<form method="POST" action="?/archive" use:enhance>
				<input type="hidden" name="updatedAt" value={data.project.updatedAt.toISOString()} />
				<input type="hidden" name="archived" value={archived ? 'false' : 'true'} />
				<Button type="submit" variant={archived ? 'primary' : 'ghost'}>
					{archived ? 'Restore project' : 'Archive project'}
				</Button>
			</form>
		</Card>
	</div>
</div>

<style>
	/*
	 * One column on a phone. At 60rem the review columns split: the work on the
	 * left, the settings and roll-ups on the right, which is how this page is
	 * actually used — at a desk, on a Sunday, deciding what happens next.
	 */
	.columns {
		display: grid;
		grid-template-columns: 1fr;
		gap: var(--sp-4);
		align-items: start;
	}
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
	/* The date beside it keeps its own width. */
	.add .when {
		flex: 0 1 11rem;
	}

	/* The row is one big link; the tick has to sit above it and stay a 44px
	   target without making every row that tall. */
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
