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
	import { KIND_OPTIONS, progressLabel, progressPercent } from './form';

	let { data, form } = $props();

	type Challenge = (typeof data.challenges)[number];

	const thisYear = $derived(data.challenges.filter((c) => c.year === data.currentYear));
	const olderYears = $derived(data.challenges.filter((c) => c.year !== data.currentYear));

	const errorFor = (action: string): string | undefined =>
		form?.action === action ? form.error : undefined;

	// Redrawn fresh after a successful add, the same reason /reading's own
	// add-a-book form is (hard rule 6): this form holds a <Select> and must
	// not be reset back to whatever the page first loaded with.
	let addFormKey = $state(0);
</script>

<svelte:head><title>Reading Challenges · LifeOS</title></svelte:head>

<PageHeader
	title="Reading Challenges"
	description="A yearly goal, or a prompt sheet to fill."
	back={{ href: '/reading', label: 'Reading Tracker' }}
>
	{#snippet actions()}
		<Button href="/reading/insights" variant="ghost">Insights</Button>
	{/snippet}
</PageHeader>

<div class="stack">
	<section aria-labelledby="this-year-heading">
		<h2 id="this-year-heading" class="section-title">{data.currentYear}</h2>
		{#if thisYear.length === 0}
			<Card>
				<EmptyState
					title="No challenges yet for {data.currentYear}"
					description="Add one below — a count to hit, or a sheet of prompts to fill."
					icon="journal"
				/>
			</Card>
		{:else}
			<Card flush>
				<List label="This year's challenges">
					{#each thisYear as challenge (challenge.id)}
						{@render challengeRow(challenge)}
					{/each}
				</List>
			</Card>
		{/if}
	</section>

	{#if olderYears.length > 0}
		<section aria-labelledby="older-heading">
			<h2 id="older-heading" class="section-title">Earlier years</h2>
			<Card flush>
				<List label="Earlier challenges">
					{#each olderYears as challenge (challenge.id)}
						{@render challengeRow(challenge)}
					{/each}
				</List>
			</Card>
		</section>
	{/if}

	<section aria-labelledby="add-heading">
		<h2 id="add-heading" class="section-title">Add a challenge</h2>
		<Card>
			{#if errorFor('add')}
				<p class="notice error" role="alert">{errorFor('add')}</p>
			{/if}
			{#key addFormKey}
				<form
					method="POST"
					action="?/add"
					class="add-form"
					use:enhance={() => {
						return async ({ result, update }) => {
							await update();
							if (result.type === 'success') addFormKey += 1;
						};
					}}
				>
					<Input label="Title" name="title" required maxlength={200} />
					<div class="row">
						<Input
							label="Year"
							name="year"
							type="number"
							value={data.currentYear.toString()}
							min="1900"
							max="2200"
							required
						/>
						<Select label="Kind" name="kind" options={KIND_OPTIONS} value="count" />
						<Input
							label="Target (for a count challenge)"
							name="targetCount"
							type="number"
							min="1"
						/>
					</div>
					<div class="actions">
						<Button type="submit" variant="primary">Add challenge</Button>
					</div>
				</form>
			{/key}
		</Card>
	</section>
</div>

{#snippet challengeRow(challenge: Challenge)}
	<ListRow
		title={challenge.title}
		href="/reading/challenges/{challenge.id}"
		meta={challenge.year.toString()}
	>
		{#snippet trail()}
			<span class="progress-text">{progressLabel(challenge.kind, challenge.progress)}</span>
		{/snippet}
		<div
			class="track"
			role="progressbar"
			aria-valuenow={progressPercent(challenge.progress)}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-label="{challenge.title}: {progressLabel(challenge.kind, challenge.progress)}"
		>
			<span class="fill" style:width="{progressPercent(challenge.progress)}%"></span>
		</div>
	</ListRow>
{/snippet}

<style>
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-6);
	}
	.section-title {
		margin: 0 0 var(--sp-3);
		font-size: var(--fs-lg);
		font-weight: 650;
	}
	.add-form {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}
	.row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 10rem), 1fr));
		gap: var(--sp-3);
	}
	.actions {
		display: flex;
		justify-content: flex-end;
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
	.track {
		margin-top: var(--sp-1);
		height: 6px;
		border-radius: var(--radius-pill);
		background: var(--c-surface-alt);
		border: 1px solid var(--c-border);
		overflow: hidden;
	}
	.fill {
		display: block;
		height: 100%;
		background: var(--c-accent);
	}
	.progress-text {
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
		white-space: nowrap;
	}
</style>
