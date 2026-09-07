<script lang="ts">
	import { Badge, Card, EmptyState, List, ListRow, PageHeader } from '$lib/components';

	let { data } = $props();

	const money = (amount: number | null, currency: string): string =>
		amount === null
			? '—'
			: new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);

	/** Days until due; negative means it has already passed. */
	const dueIn = (on: string | null): number | null =>
		on === null
			? null
			: Math.round(
					(Date.parse(`${on}T00:00:00Z`) - Date.parse(`${data.today}T00:00:00Z`)) / 86_400_000
				);
</script>

<svelte:head><title>Financial Hub · LifeOS</title></svelte:head>

<PageHeader title="Financial Hub" description="What goes out, and when.">
	{#snippet meta()}
		<span
			>{money(data.commitment.total, data.commitment.currency)} a month across {data.commitment
				.count}</span
		>
	{/snippet}
</PageHeader>

<div class="stack">
	<Card flush>
		{#if data.bills.length === 0}
			<EmptyState
				title="No bills recorded"
				description="Subscriptions and recurring bills, with what they come to in a month."
				icon="audit"
			/>
		{:else}
			<List label="Bills and subscriptions">
				{#each data.bills as bill (bill.id)}
					{@const days = dueIn(bill.nextDueOn)}
					<ListRow
						title={bill.name}
						meta={[
							bill.frequency?.replace(/_/g, ' '),
							bill.category,
							bill.autopay ? 'autopay' : null
						]
							.filter(Boolean)
							.join(' · ')}
					>
						{#snippet trail()}
							<div class="trail">
								{#if bill.status === 'free_trial'}<Badge tone="warn" dot>Free trial</Badge>{/if}
								{#if days !== null}
									<span class="due" class:soon={days <= 7}>
										{days < 0
											? `${Math.abs(days)}d overdue`
											: days === 0
												? 'due today'
												: `in ${days}d`}
									</span>
								{/if}
								<span class="amount">{money(bill.amount, bill.currency)}</span>
							</div>
						{/snippet}
						{#if bill.monthlyEquivalent !== null && bill.frequency !== 'monthly'}
							<p class="equiv">
								{money(bill.monthlyEquivalent, bill.currency)} a month
							</p>
						{/if}
					</ListRow>
				{/each}
			</List>
		{/if}
	</Card>

	<p class="footnote">
		The source's Income database holds only rollup formulas and no records, so there is nothing to
		show for it here yet.
	</p>
</div>

<style>
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}
	.trail {
		display: flex;
		gap: var(--sp-3);
		align-items: center;
	}
	.amount {
		font-variant-numeric: tabular-nums;
		font-weight: 600;
	}
	.due {
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
		white-space: nowrap;
	}
	.due.soon {
		color: var(--c-warn);
	}
	.equiv {
		margin: 0.2rem 0 0;
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
	}
	.footnote {
		margin: 0;
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
	}
</style>
