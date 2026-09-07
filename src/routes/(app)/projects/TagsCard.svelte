<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { Button, Card, Select, appPath } from '$lib/components';
	// Type only — planning.ts reaches into $lib/server and must not be bundled
	// into the browser build.
	import type { Chip } from './planning';

	interface Props {
		tags: Chip[];
		/** Household tags that are not on this record yet. */
		available: Chip[];
		/** The record's own name, so a remove control says what it removes from. */
		of: string;
	}

	let { tags, available, of }: Props = $props();
</script>

<!--
	Tags on one record (UI-007).

	The same card serves projects, goals and areas; the actions it posts to are
	spread into each route from `tagActions()`, so the three cannot drift. A tag
	is created on the tags page rather than here — inventing one from a select
	is how a workspace ends up with "Home", "home" and "Home ".
-->
<Card title="Tags">
	{#if tags.length > 0}
		<ul class="tags">
			{#each tags as tag (tag.id)}
				<li class="tag">
					<a href={resolve(appPath(`/topics`))}>{tag.name}</a>
					<form method="POST" action="?/detachTag" use:enhance>
						<input type="hidden" name="tagId" value={tag.id} />
						<button type="submit" class="remove" aria-label="Remove tag {tag.name} from {of}">
							×
						</button>
					</form>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="muted">No tags on this yet.</p>
	{/if}

	{#if available.length > 0}
		<form method="POST" action="?/attachTag" class="add" use:enhance>
			<div class="grow">
				<Select
					label="Add a tag"
					name="tagId"
					options={available.map((tag) => ({ value: tag.id, label: tag.name }))}
					placeholder="Choose a tag"
					required
				/>
			</div>
			<Button type="submit">Add</Button>
		</form>
	{:else if tags.length === 0}
		<!-- No control is offered when there is nothing to choose: a select with
		     one disabled placeholder is a button that cannot work. -->
		<p class="muted">
			<a href={resolve(appPath('/topics'))}>Make a tag</a> to group records across the household.
		</p>
	{/if}
</Card>

<style>
	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-2);
		margin: 0 0 var(--sp-4);
		padding: 0;
		list-style: none;
	}

	/* Shaped like the Tag component's pill. It cannot be that component here:
	   removal has to be a form submit so the card works without JavaScript,
	   and Tag's remove control is a click handler. */
	.tag {
		display: inline-flex;
		align-items: center;
		max-width: 100%;
		border: 1px solid var(--c-border);
		border-radius: var(--radius-pill);
		background: var(--c-surface-alt);
		font-size: var(--fs-xs);
		line-height: 1.6;
	}

	.tag a {
		display: block;
		padding: 0.1rem var(--sp-2) 0.1rem var(--sp-3);
		overflow: hidden;
		color: var(--c-text-muted);
		text-decoration: none;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tag a:hover {
		color: var(--c-accent);
		text-decoration: underline;
	}

	.remove {
		display: inline-flex;
		align-items: center;
		min-height: 0;
		padding: var(--sp-1) var(--sp-2) var(--sp-1) var(--sp-1);
		border: 0;
		background: none;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
		line-height: 1;
		cursor: pointer;
	}
	.remove:hover {
		color: var(--c-crit);
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

	.muted {
		margin: 0;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}
</style>
