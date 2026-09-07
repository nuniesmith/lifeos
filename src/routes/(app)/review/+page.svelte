<script lang="ts">
	import { enhance } from '$app/forms';
	import { Badge, Button, Card, EmptyState, List, ListRow, PageHeader } from '$lib/components';

	let { data, form } = $props();

	type Item = (typeof data.due)[number];

	const KIND_LABELS: Record<Item['kind'], string> = {
		area: 'Area',
		goal: 'Goal',
		project: 'Project'
	};

	/** "Overdue by 8 days" reads better than a date nobody has to compute. */
	function overdueLabel(item: Item): string {
		if (item.lastReviewedOn === null) return 'Never reviewed';
		if (item.overdueDays === 0) return 'Due today';
		if (item.overdueDays > 0) {
			return `Overdue by ${item.overdueDays} day${item.overdueDays === 1 ? '' : 's'}`;
		}
		const days = Math.abs(item.overdueDays);
		return `Due in ${days} day${days === 1 ? '' : 's'}`;
	}

	const cadence = (days: number): string =>
		days === 1
			? 'daily'
			: days === 7
				? 'weekly'
				: days === 30
					? 'monthly'
					: days === 91
						? 'quarterly'
						: days === 365
							? 'yearly'
							: `every ${days} days`;
</script>

<svelte:head><title>For Review · LifeOS</title></svelte:head>

<PageHeader
	title="For Review"
	description="What is due to be looked at, and what will not survive being looked at."
>
	{#snippet actions()}
		<Button size="sm" variant="ghost" href={data.showUpcoming ? '/review' : '/review?view=all'}>
			{data.showUpcoming ? 'Only what is due' : 'Show what is coming'}
		</Button>
	{/snippet}
	{#snippet meta()}
		<span>{data.due.length} due</span>
	{/snippet}
</PageHeader>

{#if form?.error}
	<p class="notice error" role="alert">{form.error}</p>
{/if}

<div class="stack">
	<section aria-labelledby="due-heading">
		<h2 id="due-heading" class="section-title">Due now</h2>
		<Card flush>
			{#if data.due.length === 0}
				<EmptyState
					title="Nothing is due"
					description="Everything on a review cycle has been looked at recently."
					icon="check"
				/>
			{:else}
				<List label="Due for review">
					{#each data.due as item (item.kind + item.id)}
						<ListRow title={item.title} href={item.path} meta={cadence(item.reviewEveryDays)}>
							{#snippet lead()}
								<Badge tone="neutral">{KIND_LABELS[item.kind]}</Badge>
							{/snippet}
							{#snippet trail()}
								<div class="trail">
									<Badge tone={item.overdueDays > 0 ? 'warn' : 'accent'} dot>
										{overdueLabel(item)}
									</Badge>
									<form method="POST" action="?/markReviewed" use:enhance>
										<input type="hidden" name="kind" value={item.kind} />
										<input type="hidden" name="id" value={item.id} />
										<Button type="submit" size="sm" aria-label={`Mark ${item.title} reviewed`}>
											Reviewed
										</Button>
									</form>
								</div>
							{/snippet}
						</ListRow>
					{/each}
				</List>
			{/if}
		</Card>
	</section>

	<section aria-labelledby="setup-heading">
		<h2 id="setup-heading" class="section-title">Needs setup</h2>
		<Card flush>
			{#if data.unsupported.length === 0}
				<EmptyState
					title="Every goal has something behind it"
					description="Each one is linked to at least one project or habit."
					icon="goals"
				/>
			{:else}
				<List label="Goals with nothing behind them">
					{#each data.unsupported as goal (goal.id)}
						<ListRow
							title={goal.title}
							href={`/goals/${goal.id}`}
							meta="No projects or habits linked"
						>
							{#snippet trail()}
								<Badge tone="warn" dot>Needs setup</Badge>
							{/snippet}
						</ListRow>
					{/each}
				</List>
			{/if}
			<p class="footnote">
				A goal with no project and no habit behind it is a wish. The review is the moment to notice.
			</p>
		</Card>
	</section>

	{#if data.showUpcoming}
		<section aria-labelledby="upcoming-heading">
			<h2 id="upcoming-heading" class="section-title">Coming up</h2>
			<Card flush>
				{#if data.upcoming.length === 0}
					<EmptyState title="Nothing scheduled ahead" icon="clock" />
				{:else}
					<List label="Upcoming reviews">
						{#each data.upcoming as item (item.kind + item.id)}
							<ListRow title={item.title} href={item.path} meta={cadence(item.reviewEveryDays)}>
								{#snippet lead()}
									<Badge tone="neutral">{KIND_LABELS[item.kind]}</Badge>
								{/snippet}
								{#snippet trail()}
									<span class="when">{overdueLabel(item)}</span>
								{/snippet}
							</ListRow>
						{/each}
					</List>
				{/if}
			</Card>
		</section>
	{/if}
</div>

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

	.trail {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-2);
		align-items: center;
	}

	.when {
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}

	.footnote {
		margin: 0;
		padding: var(--sp-3) var(--sp-4);
		border-top: 1px solid var(--c-border);
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
