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
	let { data, form } = $props();

	/** Taken from the load's own type rather than imported from the server
	    module, so nothing server-side is named in a file that ships to the
	    browser. */
	type Carrier = (typeof data.tags)[number]['carriers'][number];

	/** How many carriers are shown before the row stops listing them. */
	const SHOWN = 12;

	const PLURALS: Record<string, [string, string]> = {
		area: ['area', 'areas'],
		goal: ['goal', 'goals'],
		project: ['project', 'projects'],
		habit: ['habit', 'habits'],
		task: ['task', 'tasks']
	};

	/** "2 projects · 1 area · 9 tasks", in a fixed order rather than by count. */
	function summarise(carriers: Carrier[]): string {
		const order = ['area', 'goal', 'project', 'habit', 'task'] as const;
		const parts: string[] = [];
		for (const kind of order) {
			const n = carriers.filter((carrier) => carrier.kind === kind).length;
			if (n === 0) continue;
			const [one, many] = PLURALS[kind] ?? [kind, kind];
			parts.push(`${n} ${n === 1 ? one : many}`);
		}
		return parts.join(' · ');
	}
</script>

<svelte:head><title>Tags · LifeOS</title></svelte:head>

<PageHeader
	title="Tags"
	description="One label across areas, goals, projects, habits and tasks."
	back={{ href: '/areas', label: 'Life areas' }}
>
	{#snippet actions()}
		<Button size="sm" href={data.showArchived ? '/areas/tags' : '/areas/tags?view=archived'}>
			{data.showArchived ? 'In use' : 'Archived'}
		</Button>
	{/snippet}
</PageHeader>

{#if form?.error}
	<p class="notice error" role="alert">{form.error}</p>
{/if}

<div class="stack">
	{#if !data.showArchived}
		<Card>
			<form method="POST" action="?/create" class="add" use:enhance>
				<div class="grow">
					<Input label="New tag" name="name" placeholder="Cabin, Winter, Someday…" required />
				</div>
				<Button type="submit">Add</Button>
			</form>
		</Card>
	{/if}

	<Card flush>
		{#if data.tags.length === 0}
			<EmptyState
				title={data.showArchived ? 'No archived tags' : 'No tags yet'}
				description={data.showArchived
					? 'Tags you archive are kept here, with everything they were on.'
					: 'Make one above, then add it from a project, goal or area.'}
				icon="tasks"
			/>
		{:else}
			<List label="Tags">
				{#each data.tags as tag (tag.id)}
					<ListRow
						title={tag.name}
						meta={data.showArchived
							? 'Archived'
							: tag.total === 0
								? 'Not on anything yet'
								: summarise(tag.carriers)}
						muted={tag.archived}
					>
						{#snippet trail()}
							<form method="POST" action="?/setArchived" use:enhance>
								<input type="hidden" name="id" value={tag.id} />
								<!-- `.toISOString()`: the precondition compares to the
								     millisecond, which a Date rendered directly loses. -->
								<input type="hidden" name="updatedAt" value={tag.updatedAt.toISOString()} />
								<input type="hidden" name="archived" value={tag.archived ? 'false' : 'true'} />
								<!-- The tag's name is in the accessible name but not in the
								     visible one: a column of controls each reading "Archive
								     Cabin" is unreadable, while five identical "Archive"
								     buttons are unusable with a screen reader. -->
								<Button
									type="submit"
									size="sm"
									variant="ghost"
									aria-label={tag.archived ? `Restore ${tag.name}` : `Archive ${tag.name}`}
								>
									{tag.archived ? 'Restore' : 'Archive'}
								</Button>
							</form>
						{/snippet}

						{#if tag.carriers.length > 0}
							<ul class="carriers">
								{#each tag.carriers.slice(0, SHOWN) as carrier (carrier.kind + carrier.id)}
									<li>
										<a href={resolve(appPath(carrier.href))}>{carrier.name}</a>
									</li>
								{/each}
								{#if tag.carriers.length > SHOWN}
									<li class="more">
										<Badge tone="neutral">+{tag.carriers.length - SHOWN} more</Badge>
									</li>
								{/if}
							</ul>
						{/if}
					</ListRow>
				{/each}
			</List>
		{/if}
	</Card>

	{#if !data.showArchived}
		<p class="footnote">
			Journal entries can carry tags as well and are not listed here: a daily log is private to
			whoever wrote it, and a shared page has no business naming one.
		</p>
	{/if}
</div>

<style>
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
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

	.carriers {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.carriers a {
		display: inline-block;
		padding: 0.1rem var(--sp-3);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-pill);
		background: var(--c-surface-alt);
		font-size: var(--fs-xs);
		text-decoration: none;
	}
	.more {
		display: inline-flex;
		align-items: center;
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
</style>
