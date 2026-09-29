<script lang="ts">
	import { enhance } from '$app/forms';
	import {
		Button,
		Card,
		EmptyState,
		Input,
		List,
		ListRow,
		PageHeader,
		Select
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

	type Row = (typeof data.groups)[number]['routines'][number];
	const progress = (row: Row) => `${row.done} of ${row.total}`;

	/*
	 * Bumped after a successful create to draw the add form afresh. The form
	 * stays on the page for adding another routine right away, and it has a
	 * Select (time of day): a plain reset after `update()` would put that
	 * back on whatever the page was first served with rather than
	 * "Anytime" -- the exact failure health-measurements' add-reading form
	 * documents (hard rule 5).
	 */
	let addFormKey = $state(0);
</script>

<svelte:head><title>Routines · LifeOS</title></svelte:head>

<PageHeader title="Routines" description="A sequence of steps, done at a time of day.">
	{#snippet meta()}
		<Button href="/habits" size="sm" variant="ghost">Habits</Button>
	{/snippet}
</PageHeader>

{#if form?.error}
	<p class="notice error" role="alert">{form.error}</p>
{/if}

<div class="stack">
	{#if data.groups.length === 0}
		<Card flush>
			<EmptyState
				title="No routines yet"
				description="Add the first one below -- a name and when it happens is all it takes to start."
				icon="clock"
			/>
		</Card>
	{:else}
		{#each data.groups as group (group.timeOfDay)}
			<Card title={TIME_LABELS[group.timeOfDay] ?? group.timeOfDay} flush>
				<List label={`${TIME_LABELS[group.timeOfDay] ?? group.timeOfDay} routines`}>
					{#each group.routines as routine (routine.id)}
						<ListRow
							title={routine.name}
							href={`/routines/${routine.id}`}
							meta={progress(routine)}
						/>
					{/each}
				</List>
			</Card>
		{/each}
	{/if}

	<Card title="Add a routine">
		{#key addFormKey}
			<form
				method="POST"
				action="?/create"
				class="add"
				use:enhance={() => {
					return async ({ result, update }) => {
						await update();
						if (result.type === 'success') addFormKey += 1;
					};
				}}
			>
				<Input label="Name" name="name" placeholder="Morning" required autocomplete="off" />
				<Select label="Time of day" name="timeOfDay" options={TIME_OPTIONS} value="anytime" />
				<Button type="submit" variant="primary" full>Add routine</Button>
			</form>
		{/key}
	</Card>
</div>

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

	.add {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}
</style>
