<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button, Card, EmptyState, List, ListRow, PageHeader, Textarea } from '$lib/components';

	let { data, form } = $props();

	let thoughts = $state('');

	/** Held in a constant because it carries newlines: one example per line is
	    the whole instruction, and it reads better than any hint text. */
	const PLACEHOLDER = [
		'ring the dentist',
		'what was that book Kate mentioned',
		'the hall light keeps flickering'
	].join('\n');

	/** Live count, so the ceiling is visible before the submit rejects it. */
	const lines = $derived(
		thoughts
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.length > 0).length
	);
</script>

<svelte:head><title>Brain Dump · LifeOS</title></svelte:head>

<PageHeader title="Brain Dump" description="It doesn't have to make sense yet.">
	{#snippet actions()}
		<Button size="sm" variant="ghost" href="/inbox">Open the inbox</Button>
	{/snippet}
</PageHeader>

{#if form?.error}
	<p class="notice error" role="alert">{form.error}</p>
{:else if form?.captured}
	<p class="notice ok" role="status">
		{form.captured} dropped into the inbox. Sort them whenever you like.
	</p>
{/if}

<div class="stack">
	<Card>
		<p class="lede">
			Fragments count. Questions count. Half-formed ideas count. Get it down first — one per line,
			and every line becomes something waiting in your inbox.
		</p>

		<form
			method="POST"
			action="?/dump"
			use:enhance={() =>
				async ({ update }) => {
					await update({ reset: true });
					thoughts = '';
				}}
		>
			<Textarea
				label="Everything on your mind"
				name="thoughts"
				bind:value={thoughts}
				rows={10}
				placeholder={PLACEHOLDER}
			/>
			<div class="row">
				<span class="count" aria-live="polite">
					{lines === 0 ? 'Nothing yet' : `${lines} line${lines === 1 ? '' : 's'}`}
				</span>
				<Button type="submit" disabled={lines === 0}>Drop it all in</Button>
			</div>
		</form>
	</Card>

	<Card flush>
		{#if data.recent.length === 0}
			<EmptyState
				title="Nothing waiting"
				description="What you write above lands in the inbox, and the most recent will show up here."
				icon="inbox"
			/>
		{:else}
			<List label="Most recently dropped in">
				{#each data.recent as task (task.id)}
					<ListRow title={task.title} href={`/tasks/${task.id}`} />
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

	.lede {
		margin: 0 0 var(--sp-4);
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}

	.row {
		display: flex;
		gap: var(--sp-3);
		align-items: center;
		justify-content: space-between;
		margin-top: var(--sp-3);
	}
	.count {
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
		font-variant-numeric: tabular-nums;
	}

	.notice {
		padding: var(--sp-2) var(--sp-3);
		border-radius: var(--radius-sm);
		margin-bottom: var(--sp-4);
		font-size: var(--fs-sm);
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
