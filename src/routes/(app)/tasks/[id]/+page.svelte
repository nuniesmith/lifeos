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

	let { data, form } = $props();

	const STATUSES = [
		{ value: 'todo', label: 'To do' },
		{ value: 'in_progress', label: 'In progress' },
		{ value: 'blocked', label: 'Blocked' },
		{ value: 'done', label: 'Done' },
		{ value: 'dropped', label: 'Dropped' }
	];

	const ENERGY = [
		{ value: 'low', label: 'Low' },
		{ value: 'medium', label: 'Medium' },
		{ value: 'high', label: 'High' }
	];

	const projectOptions = $derived(data.projects.map((p) => ({ value: p.id, label: p.name })));
	const areaOptions = $derived(data.areas.map((a) => ({ value: a.id, label: a.name })));

	const isDone = (status: string) => status === 'done' || status === 'dropped';
	const archived = $derived(data.task.archivedAt !== null);
</script>

<svelte:head><title>{data.task.title} · LifeOS</title></svelte:head>

<PageHeader title={data.task.title}>
	{#snippet meta()}
		{#if archived}<Badge tone="neutral">Archived</Badge>{/if}
		{#if data.task.isImportant}<Badge tone="warn">Important</Badge>{/if}
		{#if data.task.isUrgent}<Badge tone="crit">Urgent</Badge>{/if}
	{/snippet}
	{#snippet actions()}
		<Button size="sm" variant="ghost" href="/tasks">Back to tasks</Button>
	{/snippet}
</PageHeader>

{#if form?.error}
	<p class="notice error" role="alert">{form.error}</p>
{:else if form?.saved}
	<p class="notice ok" role="status">Saved.</p>
{/if}

{#if data.parent}
	<p class="parent">
		Subtask of
		<a href={resolve(appPath(`/tasks/${data.parent.id}`))}>{data.parent.title}</a>
	</p>
{/if}

<Card title="Details">
	<form method="POST" action="?/save" class="edit" use:enhance>
		<!-- Carries the version the form was rendered from, so a save from a
		     stale tab is refused rather than silently overwriting. -->
		<input type="hidden" name="updatedAt" value={data.task.updatedAt} />

		<Input label="Title" name="title" value={data.task.title} required />
		<Textarea label="Notes" name="notes" rows={4} value={data.task.notes ?? ''} />

		<div class="grid">
			<Select label="Status" name="status" options={STATUSES} value={data.task.status} />
			<Select
				label="Energy"
				name="energy"
				options={ENERGY}
				value={data.task.energy ?? ''}
				placeholder="Any"
			/>
			<Input label="Do on" name="doOn" type="date" value={data.task.doOn ?? ''} />
			<Input label="Deadline" name="deadlineOn" type="date" value={data.task.deadlineOn ?? ''} />
			<Select
				label="Project"
				name="projectId"
				options={projectOptions}
				value={data.task.projectId ?? ''}
				placeholder="No project"
			/>
			<Select
				label="Life area"
				name="areaId"
				options={areaOptions}
				value={data.task.areaId ?? ''}
				placeholder="No area"
			/>
			<Input label="Context" name="context" value={data.task.context ?? ''} />
		</div>

		<div class="flags">
			<label
				><input type="checkbox" name="isImportant" checked={data.task.isImportant} /> Important</label
			>
			<label><input type="checkbox" name="isUrgent" checked={data.task.isUrgent} /> Urgent</label>
		</div>

		<div class="row-actions">
			<Button type="submit" variant="primary">Save</Button>
		</div>
	</form>
</Card>

<Card title="Subtasks" flush>
	{#if data.subtasks.length === 0}
		<EmptyState title="No subtasks" description="Break this down if it helps." />
	{:else}
		<List label="Subtasks">
			{#each data.subtasks as sub (sub.id)}
				<ListRow title={sub.title} href="/tasks/{sub.id}" muted={isDone(sub.status)}>
					{#snippet lead()}
						<form method="POST" action="?/toggleSubtask" use:enhance>
							<input type="hidden" name="id" value={sub.id} />
							<input type="hidden" name="updatedAt" value={sub.updatedAt} />
							<input type="hidden" name="done" value={isDone(sub.status) ? 'false' : 'true'} />
							<button
								class="tick"
								type="submit"
								aria-pressed={isDone(sub.status)}
								aria-label={isDone(sub.status) ? `Reopen ${sub.title}` : `Complete ${sub.title}`}
								>{isDone(sub.status) ? '✓' : ''}</button
							>
						</form>
					{/snippet}
				</ListRow>
			{/each}
		</List>
	{/if}

	<form method="POST" action="?/addSubtask" class="add-sub" use:enhance>
		<Input label="Add a subtask" name="title" placeholder="Next small step" required />
		<Button type="submit">Add</Button>
	</form>
</Card>

<Card title={archived ? 'Restore' : 'Archive'}>
	<p class="muted">
		{archived
			? 'This task is archived and hidden from the lists. Restoring brings it back.'
			: 'Archiving hides this task without deleting it. Nothing is lost.'}
	</p>
	<form method="POST" action="?/archive" use:enhance>
		<input type="hidden" name="archived" value={archived ? 'false' : 'true'} />
		<Button type="submit" variant={archived ? 'primary' : 'ghost'}>
			{archived ? 'Restore task' : 'Archive task'}
		</Button>
	</form>
</Card>

<style>
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
	.parent {
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
		margin-bottom: var(--sp-4);
	}
	.edit {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}
	/* One column on a phone; two once there is room, which is where the seven
	   short fields stop looking like a long scroll. */
	.grid {
		display: grid;
		gap: var(--sp-3);
		grid-template-columns: 1fr;
	}
	@media (min-width: 32rem) {
		.grid {
			grid-template-columns: 1fr 1fr;
		}
	}
	.flags {
		display: flex;
		gap: var(--sp-4);
		flex-wrap: wrap;
	}
	.flags label {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-2);
		min-height: var(--tap);
	}
	.row-actions {
		display: flex;
		gap: var(--sp-3);
	}
	.add-sub {
		display: flex;
		gap: var(--sp-3);
		align-items: flex-end;
		padding: var(--sp-3);
		border-top: 1px solid var(--c-border);
	}
	.add-sub :global(label) {
		flex: 1;
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
	.muted {
		color: var(--c-text-muted);
	}
</style>
