<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button, Card, EmptyState, Input, List, ListRow, PageHeader } from '$lib/components';

	let { data, form } = $props();

	/**
	 * The triage select posts `kind:id` in one field, so filing is one form
	 * submission rather than a destination picker plus a confirm.
	 */
	const destinations = $derived([
		{ value: '', label: 'Just a to-do' },
		...data.projects.map((p) => ({ value: `project:${p.id}`, label: `Project · ${p.name}` })),
		...data.areas.map((a) => ({ value: `area:${a.id}`, label: `Area · ${a.name}` }))
	]);
</script>

<svelte:head><title>Quick Drop | Inbox · LifeOS</title></svelte:head>

<PageHeader
	title="Quick Drop | Inbox"
	description="Get it out of your head now. Figure out where it belongs later."
>
	{#snippet meta()}
		<span>{data.tasks.length} waiting</span>
	{/snippet}
</PageHeader>

{#if form?.error}
	<p class="notice error" role="alert">{form.error}</p>
{/if}

<div class="stack">
	<Card>
		<form
			method="POST"
			action="?/capture"
			class="capture"
			use:enhance={() =>
				async ({ update }) => {
					// Reset so the box is empty for the next thought; the whole
					// point of this page is that capturing twice in a row is free.
					await update({ reset: true });
				}}
		>
			<div class="grow">
				<Input
					label="What is on your mind?"
					name="title"
					placeholder="Anything at all — sort it out later"
					required
					autocomplete="off"
				/>
			</div>
			<Button type="submit">Drop it in</Button>
		</form>
	</Card>

	<Card flush>
		{#if data.tasks.length === 0}
			<EmptyState
				title="Inbox is clear"
				description="Nothing waiting to be sorted. Anything you drop in above lands here until you decide where it goes."
				icon="inbox"
			/>
		{:else}
			<List label="Waiting to be sorted">
				{#each data.tasks as task (task.id)}
					<ListRow title={task.title} href={`/tasks/${task.id}`}>
						{#snippet trail()}
							<div class="triage">
								<form method="POST" action="?/file" class="file" use:enhance>
									<input type="hidden" name="id" value={task.id} />
									<!-- `.toISOString()`: the precondition compares to the
									     millisecond, which a Date rendered directly loses. -->
									<input type="hidden" name="updatedAt" value={task.updatedAt.toISOString()} />
									<label class="visually-hidden" for={`dest-${task.id}`}>
										File “{task.title}” under
									</label>
									<select id={`dest-${task.id}`} name="destination">
										{#each destinations as option (option.value)}
											<option value={option.value}>{option.label}</option>
										{/each}
									</select>
									<Button type="submit" size="sm" aria-label={`File ${task.title}`}>File</Button>
								</form>

								<form method="POST" action="?/complete" use:enhance>
									<input type="hidden" name="id" value={task.id} />
									<input type="hidden" name="updatedAt" value={task.updatedAt.toISOString()} />
									<Button
										type="submit"
										size="sm"
										variant="ghost"
										aria-label={`Complete ${task.title}`}
									>
										Done
									</Button>
								</form>

								<form method="POST" action="?/discard" use:enhance>
									<input type="hidden" name="id" value={task.id} />
									<Button
										type="submit"
										size="sm"
										variant="ghost"
										aria-label={`Discard ${task.title}`}
									>
										Discard
									</Button>
								</form>
							</div>
						{/snippet}
					</ListRow>
				{/each}
			</List>
		{/if}
	</Card>

	<p class="footnote">
		Discarding moves a task to the archive rather than deleting it — nothing here leaves the
		database.
	</p>
</div>

<style>
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}

	.capture {
		display: flex;
		gap: var(--sp-3);
		align-items: flex-end;
	}
	/* The wrapper grows, not the <label> inside it: Field lays a label and its
	   control out in a column, so a flex rule on the label leaves a hole. */
	.capture .grow {
		flex: 1;
		min-width: 0;
	}

	.triage {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-2);
		align-items: center;
	}
	.file {
		display: flex;
		gap: var(--sp-2);
		align-items: center;
	}
	select {
		max-width: 12rem;
		min-height: var(--tap);
		padding: 0 var(--sp-2);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-sm);
		background: var(--c-surface);
		color: var(--c-text);
		font: inherit;
		font-size: var(--fs-sm);
	}

	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	.footnote {
		margin: 0;
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

	@media (max-width: 40rem) {
		.capture {
			flex-direction: column;
			align-items: stretch;
		}
	}
</style>
