<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import {
		Badge,
		Button,
		Card,
		EmptyState,
		Input,
		PageHeader,
		Select,
		Sheet,
		Textarea,
		appPath
	} from '$lib/components';

	let { data, form } = $props();

	const TIME_LABELS: Record<string, string> = {
		morning: 'Morning',
		afternoon: 'Afternoon',
		evening: 'Evening',
		anytime: 'Anytime'
	};
	const TIME_OPTIONS = [
		{ value: 'morning', label: 'Morning' },
		{ value: 'afternoon', label: 'Afternoon' },
		{ value: 'evening', label: 'Evening' },
		{ value: 'anytime', label: 'Anytime' }
	];

	const ENERGY_OPTIONS = [
		{ value: 'high', label: 'High' },
		{ value: 'average', label: 'Average' },
		{ value: 'minimal', label: '1% day' }
	];
	const VERSION_LABELS: Record<string, string> = {
		high: 'High',
		average: 'Average',
		minimal: '1% day'
	};

	let editOpen = $state(false);
	let editingStepId = $state<string | null>(null);

	/*
	 * Both counters exist for the same reason health-measurements' add-reading
	 * form documents (hard rule 5): each form below stays on screen after a
	 * save and contains a `<Select>`, so a plain reset after `update()` would
	 * put that control back on whatever the page was first served with rather
	 * than the value the save actually used.
	 */
	let routineFormKey = $state(0);
	let addStepFormKey = $state(0);

	type Step = (typeof data.steps)[number];
	const canMoveUp = (index: number) => index > 0;
	const canMoveDown = (index: number) => index < data.steps.length - 1;
</script>

<svelte:head><title>{data.routine.name} · LifeOS</title></svelte:head>

<PageHeader title={data.routine.name} back={{ href: '/routines', label: 'Routines' }}>
	{#snippet meta()}
		<Badge tone="accent">{TIME_LABELS[data.routine.timeOfDay] ?? data.routine.timeOfDay}</Badge>
		{#if data.routine.archivedAt}<Badge tone="neutral">Archived</Badge>{/if}
		<Button size="sm" variant="ghost" onclick={() => (editOpen = true)}>Edit</Button>
	{/snippet}
</PageHeader>

{#if form?.error && form.action !== 'saveStep' && form.action !== 'addStep' && form.action !== 'moveStep' && form.action !== 'archiveStep'}
	<p class="notice error" role="alert">{form.error}</p>
{/if}

<div class="stack">
	{#if data.routine.notesHtml}
		<Card>
			<!--
				Safe for the same reason as the recipe method's {@html}:
				`data.routine.notesHtml` is built on the server by renderMarkdown
				($lib/server/markdown), which runs DOMPurify over an explicit tag
				and attribute allowlist. The routine's own notes never reach this
				tag; only that sanitized output does.
			-->
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			<div class="notes">{@html data.routine.notesHtml}</div>
		</Card>
	{/if}

	<div class="energy-picker" role="group" aria-label="Energy level">
		{#each ENERGY_OPTIONS as opt (opt.value)}
			<a
				class="energy-pill"
				class:active={data.energy === opt.value}
				href={resolve(appPath(`/routines/${data.routine.id}?energy=${opt.value}`))}
				aria-current={data.energy === opt.value ? 'true' : undefined}
			>
				{opt.label}
			</a>
		{/each}
	</div>

	<Card flush>
		{#if data.steps.length === 0}
			<EmptyState
				title="No steps yet"
				description="Open Edit to add the first step."
				icon="clock"
			/>
		{:else}
			<ul class="steps" aria-label="Steps">
				{#each data.steps as step (step.id)}
					<li>
						<form method="POST" action="?/toggleStep" use:enhance>
							<input type="hidden" name="id" value={step.id} />
							<input type="hidden" name="day" value={data.today} />
							<input type="hidden" name="version" value={data.energy} />
							<input type="hidden" name="done" value={step.completedVersion ? 'false' : 'true'} />
							<button
								type="submit"
								class="step"
								class:done={step.completedVersion}
								aria-pressed={Boolean(step.completedVersion)}
							>
								<span class="tick" aria-hidden="true">{step.completedVersion ? '✓' : ''}</span>
								<span class="body">
									<span class="title-row">
										<span class="title">{step.title}</span>
										{#if step.durationMinutes}
											<Badge tone="neutral">{step.durationMinutes} min</Badge>
										{/if}
									</span>
									<span class="version-text">{step.versionText}</span>
									{#if step.habitName}<span class="meta-line">Habit: {step.habitName}</span>{/if}
									{#if step.completedVersion}
										<span class="meta-line done-line"
											>Done ({VERSION_LABELS[step.completedVersion] ?? step.completedVersion})</span
										>
									{/if}
								</span>
							</button>
						</form>
					</li>
				{/each}
			</ul>
		{/if}
	</Card>
</div>

<Sheet bind:open={editOpen} title="Edit routine">
	<div class="edit-stack">
		{#if form?.error && form.action === 'saveRoutine'}
			<p class="notice error" role="alert">{form.error}</p>
		{/if}

		{#key routineFormKey}
			<form
				method="POST"
				action="?/saveRoutine"
				class="edit-form"
				use:enhance={() => {
					return async ({ result, update }) => {
						await update();
						if (result.type === 'success') routineFormKey += 1;
					};
				}}
			>
				<input type="hidden" name="updatedAt" value={data.routine.updatedAt} />
				<Input label="Name" name="name" value={data.routine.name} required />
				<Textarea label="Notes" name="notes" rows={3} value={data.routine.notes} hint="Markdown." />
				<Select
					label="Time of day"
					name="timeOfDay"
					options={TIME_OPTIONS}
					value={data.routine.timeOfDay}
				/>
				<Button type="submit" variant="primary" full>Save routine</Button>
			</form>
		{/key}

		<section class="manage-steps" aria-labelledby="steps-heading">
			<h3 id="steps-heading">Steps</h3>

			{#if form?.error && (form.action === 'saveStep' || form.action === 'addStep' || form.action === 'moveStep' || form.action === 'archiveStep')}
				<p class="notice error" role="alert">{form.error}</p>
			{/if}

			{#if data.steps.length === 0}
				<p class="muted">No steps yet. Add the first one below.</p>
			{:else}
				<ul class="step-manage-list">
					{#each data.steps as step, index (step.id)}
						<li>
							{#if editingStepId === step.id}
								{@render stepEditForm(step)}
							{:else}
								{@render stepSummary(step, index)}
							{/if}
						</li>
					{/each}
				</ul>
			{/if}

			{#key addStepFormKey}
				<form
					method="POST"
					action="?/addStep"
					class="edit-form add-step"
					use:enhance={() => {
						return async ({ result, update }) => {
							await update();
							if (result.type === 'success') addStepFormKey += 1;
						};
					}}
				>
					<Input label="Title" name="title" required autocomplete="off" />
					<Textarea label="Average version" name="averageVersion" rows={2} required />
					<Textarea label="High-energy version" name="highVersion" rows={2} hint="Optional." />
					<Textarea label="1% day version" name="minimalVersion" rows={2} hint="Optional." />
					<Input label="Duration (minutes)" name="durationMinutes" type="number" min="1" />
					<Select
						label="Linked habit"
						name="habitId"
						options={data.habitOptions}
						value=""
						placeholder="No habit"
					/>
					<Button type="submit" variant="secondary" full>Add step</Button>
				</form>
			{/key}
		</section>

		<section class="archive-routine">
			{#if form?.error && form.action === 'archiveRoutine'}
				<p class="notice error" role="alert">{form.error}</p>
			{/if}
			<form method="POST" action="?/archiveRoutine" use:enhance>
				<input type="hidden" name="archived" value={data.routine.archivedAt ? 'false' : 'true'} />
				<Button type="submit" variant={data.routine.archivedAt ? 'primary' : 'danger'} full>
					{data.routine.archivedAt ? 'Restore routine' : 'Archive routine'}
				</Button>
			</form>
		</section>
	</div>
</Sheet>

{#snippet stepSummary(step: Step, index: number)}
	<div class="step-summary">
		<span class="step-title">{index + 1}. {step.title}</span>
		<div class="step-buttons">
			<form method="POST" action="?/moveStep" use:enhance>
				<input type="hidden" name="id" value={step.id} />
				<input type="hidden" name="direction" value="up" />
				<Button
					type="submit"
					size="sm"
					variant="ghost"
					disabled={!canMoveUp(index)}
					aria-label={`Move ${step.title} up`}
				>
					Up
				</Button>
			</form>
			<form method="POST" action="?/moveStep" use:enhance>
				<input type="hidden" name="id" value={step.id} />
				<input type="hidden" name="direction" value="down" />
				<Button
					type="submit"
					size="sm"
					variant="ghost"
					disabled={!canMoveDown(index)}
					aria-label={`Move ${step.title} down`}
				>
					Down
				</Button>
			</form>
			<Button size="sm" variant="ghost" onclick={() => (editingStepId = step.id)}>Edit</Button>
			<form method="POST" action="?/archiveStep" use:enhance>
				<input type="hidden" name="id" value={step.id} />
				<Button type="submit" size="sm" variant="ghost" aria-label={`Archive ${step.title}`}>
					Archive
				</Button>
			</form>
		</div>
	</div>
{/snippet}

{#snippet stepEditForm(step: Step)}
	<form
		method="POST"
		action="?/saveStep"
		class="edit-form"
		use:enhance={() => {
			return async ({ result, update }) => {
				await update();
				if (result.type === 'success') editingStepId = null;
			};
		}}
	>
		<input type="hidden" name="id" value={step.id} />
		<Input label="Title" name="title" value={step.title} required />
		<Textarea
			label="Average version"
			name="averageVersion"
			rows={2}
			value={step.averageVersion}
			required
		/>
		<Textarea label="High-energy version" name="highVersion" rows={2} value={step.highVersion} />
		<Textarea label="1% day version" name="minimalVersion" rows={2} value={step.minimalVersion} />
		<Input
			label="Duration (minutes)"
			name="durationMinutes"
			type="number"
			min="1"
			value={step.durationMinutes?.toString() ?? ''}
		/>
		<Select
			label="Linked habit"
			name="habitId"
			options={data.habitOptions}
			value={step.habitId ?? ''}
			placeholder="No habit"
		/>
		<div class="row-actions">
			<Button type="button" variant="ghost" onclick={() => (editingStepId = null)}>Cancel</Button>
			<Button type="submit" variant="primary">Save step</Button>
		</div>
	</form>
{/snippet}

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

	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}

	.notes {
		color: var(--c-text);
		line-height: 1.5;
	}

	.energy-picker {
		display: flex;
		gap: var(--sp-2);
	}
	.energy-pill {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: var(--tap);
		padding: 0 var(--sp-2);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-pill);
		background: var(--c-surface);
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
		font-weight: 600;
		text-decoration: none;
		text-align: center;
	}
	.energy-pill.active {
		border-color: var(--c-accent);
		background: color-mix(in srgb, var(--c-accent) 14%, transparent);
		color: var(--c-text);
	}

	.steps {
		display: flex;
		flex-direction: column;
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.steps li + li {
		border-top: 1px solid var(--c-border);
	}
	.steps form {
		display: contents;
	}
	.step {
		display: flex;
		align-items: flex-start;
		width: 100%;
		gap: var(--sp-3);
		padding: var(--sp-3) var(--sp-4);
		border: none;
		background: transparent;
		color: var(--c-text);
		text-align: left;
		font: inherit;
		cursor: pointer;
	}
	.step.done {
		background: color-mix(in srgb, var(--c-ok) 6%, transparent);
	}
	.tick {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		justify-content: center;
		width: var(--tap);
		height: var(--tap);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-sm);
		font-size: var(--fs-lg);
		color: var(--c-ok);
	}
	.step.done .tick {
		border-color: color-mix(in srgb, var(--c-ok) 45%, transparent);
		background: color-mix(in srgb, var(--c-ok) 16%, transparent);
	}
	.body {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 0.2rem;
		min-width: 0;
	}
	.title-row {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		font-weight: 650;
	}
	.version-text {
		color: var(--c-text-muted);
	}
	.meta-line {
		font-size: var(--fs-sm);
		color: var(--c-text-muted);
	}
	.done-line {
		color: var(--c-ok);
		font-weight: 600;
	}

	.edit-stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-5);
	}
	.edit-form {
		display: flex;
		flex-direction: column;
		gap: var(--sp-3);
	}

	.manage-steps h3 {
		margin: 0 0 var(--sp-2);
		font-size: var(--fs-base);
	}
	.step-manage-list {
		display: flex;
		flex-direction: column;
		gap: var(--sp-2);
		list-style: none;
		margin: 0 0 var(--sp-3);
		padding: 0;
	}
	.step-manage-list li {
		border: 1px solid var(--c-border);
		border-radius: var(--radius-sm);
		padding: var(--sp-2) var(--sp-3);
	}
	.step-summary {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--sp-2);
	}
	.step-title {
		font-weight: 600;
	}
	.step-buttons {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-1);
	}
	.step-buttons form {
		display: contents;
	}

	.row-actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--sp-2);
	}

	.muted {
		margin: 0 0 var(--sp-3);
		color: var(--c-text-muted);
	}

	.archive-routine {
		border-top: 1px solid var(--c-border);
		padding-top: var(--sp-4);
	}
</style>
