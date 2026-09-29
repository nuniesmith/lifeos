<script lang="ts">
	import { enhance } from '$app/forms';
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
		Sheet,
		Textarea
	} from '$lib/components';

	let { data, form } = $props();

	type IncomeEntry = (typeof data.income)[number];
	type SavingsContribution = (typeof data.savings)[number];

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

	/** A stored day as the household reads it, with no timezone in between. */
	const longDay = (value: string) =>
		new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, {
			day: 'numeric',
			month: 'short',
			year: 'numeric',
			timeZone: 'UTC'
		});

	const TYPE_OPTIONS = $derived(
		data.billTypes.map((t) => ({ value: t, label: t === 'bill' ? 'Bill' : 'Subscription' }))
	);
	const FREQUENCY_OPTIONS = $derived(
		data.billFrequencies.map((f) => ({ value: f, label: f.replace(/_/g, ' ') }))
	);
	const goalOptions = $derived([
		{ value: '', label: 'No particular goal' },
		...data.goals.map((g) => ({ value: g.id, label: g.title }))
	]);

	const errorFor = (action: string) => (form?.action === action ? form.error : undefined);

	/*
	 * Bumped after a successful add to draw that form afresh. Both add forms
	 * below carry a <Select> — a native form reset (SvelteKit's default after
	 * `use:enhance`) puts a <Select> back on whichever option it was first
	 * SERVED with, not on the option it was just reset away from, which is
	 * only right by accident. Redrawing with `{#key}` starts every control,
	 * Select included, from this component's own declared defaults instead.
	 * See the identical comment on health/measurements' add-a-reading form.
	 */
	let billFormKey = $state(0);
	let savingsFormKey = $state(0);

	let editingIncome = $state<IncomeEntry | null>(null);
	let incomeSheetOpen = $state(false);
	function startEditIncome(entry: IncomeEntry) {
		editingIncome = entry;
		incomeSheetOpen = true;
	}

	let editingSavings = $state<SavingsContribution | null>(null);
	let savingsSheetOpen = $state(false);
	function startEditSavings(contribution: SavingsContribution) {
		editingSavings = contribution;
		savingsSheetOpen = true;
	}
</script>

<svelte:head><title>Financial Hub · LifeOS</title></svelte:head>

<PageHeader
	title="Financial Hub"
	description="Bills, income and savings — not every transaction."
/>

<div class="stack">
	<section aria-labelledby="glance-heading">
		<h2 id="glance-heading" class="section-title">Money at a glance</h2>
		<div class="glance">
			<div class="stat">
				<span class="value">{money(data.incomeMonth.actualTotal, data.incomeMonth.currency)}</span>
				<span class="label">received this month</span>
				<span class="sub"
					>of {money(data.incomeMonth.expectedTotal, data.incomeMonth.currency)} expected</span
				>
			</div>
			<div class="stat">
				<span class="value">{money(data.commitment.total, data.commitment.currency)}</span>
				<span class="label">monthly commitments</span>
				<span class="sub">{data.commitment.count} active</span>
			</div>
			<div class="stat">
				{#if data.nextBill}
					<span class="value name">{data.nextBill.name}</span>
					<span class="label"
						>{money(data.nextBill.amount, data.nextBill.currency)} · next bill due</span
					>
					<span class="sub">{longDay(data.nextBill.nextDueOn ?? data.today)}</span>
				{:else}
					<span class="value name">—</span>
					<span class="label">no bill due</span>
				{/if}
			</div>
			<div class="stat">
				<span class="value">{money(data.savingsTotals.thisMonth, 'CAD')}</span>
				<span class="label">saved this month</span>
			</div>
			<div class="stat">
				<span class="value">{money(data.savingsTotals.total, 'CAD')}</span>
				<span class="label">saved in total</span>
			</div>
		</div>
	</section>

	<section aria-labelledby="bills-heading">
		<h2 id="bills-heading" class="section-title">Bills and subscriptions</h2>
		<Card>
			{#if errorFor('addBill')}<p class="notice error" role="alert">{errorFor('addBill')}</p>{/if}
			{#key billFormKey}
				<form
					method="POST"
					action="?/addBill"
					use:enhance={() => {
						return async ({ result, update }) => {
							await update();
							if (result.type === 'success') billFormKey += 1;
						};
					}}
				>
					<div class="grid">
						<Input label="Name" name="name" placeholder="Internet" required maxlength={200} />
						<Select label="Type" name="type" options={TYPE_OPTIONS} value="bill" />
						<Input
							label="Amount"
							name="amount"
							type="number"
							inputmode="decimal"
							step="0.01"
							min="0"
						/>
						<Select
							label="Frequency"
							name="frequency"
							options={FREQUENCY_OPTIONS}
							placeholder="No fixed schedule"
						/>
						<Input label="Next due" name="nextDueOn" type="date" />
						<Input label="Category" name="category" placeholder="Utilities" />
					</div>
					<div class="actions">
						<Button type="submit" variant="primary">Add bill</Button>
					</div>
				</form>
			{/key}
		</Card>

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
							href={`/finance/bills/${bill.id}`}
							meta={[
								bill.type === 'subscription' ? 'subscription' : null,
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
	</section>

	<section aria-labelledby="income-heading">
		<h2 id="income-heading" class="section-title">Income</h2>
		<Card>
			{#if errorFor('addIncome')}<p class="notice error" role="alert">
					{errorFor('addIncome')}
				</p>{/if}
			<form
				method="POST"
				action="?/addIncome"
				use:enhance={() => {
					return async ({ result, update }) => {
						await update();
						if (result.type !== 'success') return;
					};
				}}
			>
				<div class="grid">
					<Input label="Title" name="title" placeholder="Paycheque" required maxlength={200} />
					<Input label="Source" name="source" placeholder="Employer" />
					<Input
						label="Expected"
						name="expectedAmount"
						type="number"
						inputmode="decimal"
						step="0.01"
						min="0"
					/>
					<Input
						label="Actual"
						name="actualAmount"
						type="number"
						inputmode="decimal"
						step="0.01"
						min="0"
					/>
					<Input label="Date" name="receivedOn" type="date" required value={data.today} />
				</div>
				<div class="actions">
					<Button type="submit" variant="primary">Add income</Button>
				</div>
			</form>
		</Card>

		<Card flush>
			{#if data.income.length === 0}
				<EmptyState
					title="No income recorded"
					description="What came in, and what was expected."
					icon="today"
				/>
			{:else}
				<List label="Income">
					{#each data.income as entry (entry.id)}
						<ListRow
							title={entry.title}
							meta={[entry.source, longDay(entry.receivedOn)].filter(Boolean).join(' · ')}
						>
							{#snippet trail()}
								<div class="trail">
									{#if entry.difference !== null}
										<span class="due" class:soon={entry.difference < 0}>
											{entry.difference >= 0 ? '+' : ''}{money(entry.difference, entry.currency)}
										</span>
									{/if}
									<span class="amount"
										>{money(entry.actualAmount ?? entry.expectedAmount, entry.currency)}</span
									>
									<Button size="sm" variant="ghost" onclick={() => startEditIncome(entry)}
										>Edit</Button
									>
								</div>
							{/snippet}
						</ListRow>
					{/each}
				</List>
			{/if}
		</Card>

		{#if data.archivedIncome.length > 0}
			<details class="panel">
				<summary>Archived ({data.archivedIncome.length})</summary>
				<List label="Archived income">
					{#each data.archivedIncome as entry (entry.id)}
						<ListRow title={entry.title} meta={longDay(entry.receivedOn)} muted>
							{#snippet trail()}
								<form method="POST" action="?/archiveIncome" use:enhance>
									<input type="hidden" name="id" value={entry.id} />
									<input type="hidden" name="archived" value="false" />
									<Button type="submit" size="sm" variant="ghost">Restore</Button>
								</form>
							{/snippet}
						</ListRow>
					{/each}
				</List>
			</details>
		{/if}
	</section>

	<section aria-labelledby="savings-heading">
		<h2 id="savings-heading" class="section-title">Savings</h2>
		<Card>
			{#if errorFor('addSavings')}<p class="notice error" role="alert">
					{errorFor('addSavings')}
				</p>{/if}
			{#key savingsFormKey}
				<form
					method="POST"
					action="?/addSavings"
					use:enhance={() => {
						return async ({ result, update }) => {
							await update();
							if (result.type === 'success') savingsFormKey += 1;
						};
					}}
				>
					<div class="grid">
						<Input
							label="Title"
							name="title"
							placeholder="Transfer to savings"
							required
							maxlength={200}
						/>
						<Input
							label="Amount"
							name="amount"
							type="number"
							inputmode="decimal"
							step="0.01"
							min="0.01"
							required
						/>
						<Input label="Date" name="contributedOn" type="date" required value={data.today} />
						<Select label="Goal" name="goalId" options={goalOptions} value="" />
					</div>
					<div class="actions">
						<Button type="submit" variant="primary">Add contribution</Button>
					</div>
				</form>
			{/key}
		</Card>

		{#if data.savingsTotals.perGoal.length > 0}
			<Card title="Saved by goal">
				<ul class="per-goal">
					{#each data.savingsTotals.perGoal as row (row.goalId)}
						<li>
							<span class="goal-title">{row.goalTitle}</span>
							<span class="goal-total">{money(row.total, 'CAD')}</span>
						</li>
					{/each}
				</ul>
			</Card>
		{/if}

		<Card flush>
			{#if data.savings.length === 0}
				<EmptyState
					title="No contributions recorded"
					description="Every transfer toward savings, and what it added up to."
					icon="goals"
				/>
			{:else}
				<List label="Savings contributions">
					{#each data.savings as contribution (contribution.id)}
						<ListRow
							title={contribution.title}
							meta={[contribution.goalTitle, longDay(contribution.contributedOn)]
								.filter(Boolean)
								.join(' · ')}
						>
							{#snippet trail()}
								<div class="trail">
									<span class="amount">{money(contribution.amount, 'CAD')}</span>
									<Button size="sm" variant="ghost" onclick={() => startEditSavings(contribution)}
										>Edit</Button
									>
								</div>
							{/snippet}
						</ListRow>
					{/each}
				</List>
			{/if}
		</Card>

		{#if data.archivedSavings.length > 0}
			<details class="panel">
				<summary>Archived ({data.archivedSavings.length})</summary>
				<List label="Archived savings">
					{#each data.archivedSavings as contribution (contribution.id)}
						<ListRow title={contribution.title} meta={longDay(contribution.contributedOn)} muted>
							{#snippet trail()}
								<form method="POST" action="?/archiveSavings" use:enhance>
									<input type="hidden" name="id" value={contribution.id} />
									<input type="hidden" name="archived" value="false" />
									<Button type="submit" size="sm" variant="ghost">Restore</Button>
								</form>
							{/snippet}
						</ListRow>
					{/each}
				</List>
			</details>
		{/if}
	</section>
</div>

<Sheet bind:open={incomeSheetOpen} title="Edit income">
	{#if editingIncome}
		{@const entry = editingIncome}
		<form
			method="POST"
			action="?/saveIncome"
			use:enhance={() =>
				async ({ result, update }) => {
					// Not reset: this form carries no <Select>, but the fields should
					// still show what was saved rather than whatever a native reset
					// would put back — the same rule every edit form in this pack
					// follows. Closed only on success, so a refused save stays open
					// with its error and the values that were refused, the same
					// shape the bill's own edit panel uses.
					await update({ reset: false });
					if (result.type === 'success') incomeSheetOpen = false;
				}}
		>
			<input type="hidden" name="id" value={entry.id} />
			<input type="hidden" name="updatedAt" value={entry.updatedAt.toISOString()} />

			{#if errorFor('saveIncome')}<p class="notice error" role="alert">
					{errorFor('saveIncome')}
				</p>{/if}

			<Input label="Title" name="title" value={entry.title} required maxlength={200} />
			<div class="grid">
				<Input label="Source" name="source" value={entry.source ?? ''} />
				<Input label="Type" name="type" value={entry.type ?? ''} />
				<Input
					label="Expected"
					name="expectedAmount"
					type="number"
					inputmode="decimal"
					step="0.01"
					min="0"
					value={entry.expectedAmount?.toString() ?? ''}
				/>
				<Input
					label="Actual"
					name="actualAmount"
					type="number"
					inputmode="decimal"
					step="0.01"
					min="0"
					value={entry.actualAmount?.toString() ?? ''}
				/>
				<Input label="Date" name="receivedOn" type="date" required value={entry.receivedOn} />
				<Input label="Currency" name="currency" value={entry.currency} maxlength={3} />
			</div>
			<Textarea label="Notes" name="notes" rows={2} value={entry.notes ?? ''} />

			<div class="actions">
				<Button variant="ghost" type="button" onclick={() => (incomeSheetOpen = false)}
					>Cancel</Button
				>
				<Button type="submit" variant="primary">Save changes</Button>
			</div>
		</form>

		<form
			method="POST"
			action="?/archiveIncome"
			use:enhance={() =>
				async ({ result, update }) => {
					await update();
					if (result.type === 'success') incomeSheetOpen = false;
				}}
		>
			<input type="hidden" name="id" value={entry.id} />
			<input type="hidden" name="archived" value="true" />
			<div class="actions">
				<Button type="submit" variant="ghost">Archive</Button>
			</div>
		</form>
	{/if}
</Sheet>

<Sheet bind:open={savingsSheetOpen} title="Edit contribution">
	{#if editingSavings}
		{@const contribution = editingSavings}
		<form
			method="POST"
			action="?/saveSavings"
			use:enhance={() =>
				async ({ result, update }) => {
					// Not reset: this form carries a <Select> (the goal), which a
					// native reset would otherwise put back on whichever option the
					// page was first served with. Closed only on success, so a
					// refused save stays open with its error.
					await update({ reset: false });
					if (result.type === 'success') savingsSheetOpen = false;
				}}
		>
			<input type="hidden" name="id" value={contribution.id} />
			<input type="hidden" name="updatedAt" value={contribution.updatedAt.toISOString()} />

			{#if errorFor('saveSavings')}<p class="notice error" role="alert">
					{errorFor('saveSavings')}
				</p>{/if}

			<Input label="Title" name="title" value={contribution.title} required maxlength={200} />
			<div class="grid">
				<Input
					label="Amount"
					name="amount"
					type="number"
					inputmode="decimal"
					step="0.01"
					min="0.01"
					required
					value={contribution.amount.toString()}
				/>
				<Input
					label="Date"
					name="contributedOn"
					type="date"
					required
					value={contribution.contributedOn}
				/>
				<Select
					label="Goal"
					name="goalId"
					options={goalOptions}
					value={contribution.goalId ?? ''}
				/>
			</div>
			<Textarea label="Notes" name="notes" rows={2} value={contribution.notes ?? ''} />

			<div class="actions">
				<Button variant="ghost" type="button" onclick={() => (savingsSheetOpen = false)}
					>Cancel</Button
				>
				<Button type="submit" variant="primary">Save changes</Button>
			</div>
		</form>

		<form
			method="POST"
			action="?/archiveSavings"
			use:enhance={() =>
				async ({ result, update }) => {
					await update();
					if (result.type === 'success') savingsSheetOpen = false;
				}}
		>
			<input type="hidden" name="id" value={contribution.id} />
			<input type="hidden" name="archived" value="true" />
			<div class="actions">
				<Button type="submit" variant="ghost">Archive</Button>
			</div>
		</form>
	{/if}
</Sheet>

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

	.glance {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
		gap: var(--sp-3);
	}
	.stat {
		display: grid;
		gap: 0.15rem;
		padding: var(--sp-4);
		border: 1px solid var(--c-border);
		border-radius: var(--radius);
		background: var(--c-surface);
	}
	.value {
		font-size: 1.5rem;
		font-weight: 650;
		font-variant-numeric: tabular-nums;
		line-height: 1.15;
	}
	.value.name {
		font-size: var(--fs-base);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.label {
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}
	.sub {
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
	}

	form {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
		gap: var(--sp-3);
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--sp-2);
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

	.per-goal {
		display: grid;
		gap: var(--sp-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.per-goal li {
		display: flex;
		justify-content: space-between;
		gap: var(--sp-3);
		font-size: var(--fs-sm);
	}
	.goal-total {
		font-variant-numeric: tabular-nums;
		font-weight: 600;
	}

	/* The same disclosure the bill page uses for its edit form: archived
	   entries stay one tap away without taking room from the live list. */
	.panel {
		border: 1px solid var(--c-border);
		border-radius: var(--radius);
		background: var(--c-surface);
	}
	.panel summary {
		display: flex;
		align-items: center;
		min-height: var(--tap);
		padding: var(--sp-2) var(--sp-4);
		font-weight: 650;
		cursor: pointer;
	}
	.panel[open] summary {
		border-bottom: 1px solid var(--c-border);
	}
	.notice {
		padding: var(--sp-2) var(--sp-3);
		border-radius: var(--radius-sm);
		margin: 0 0 var(--sp-3);
	}
	.notice.error {
		color: var(--c-crit);
		border: 1px solid color-mix(in srgb, var(--c-crit) 25%, transparent);
		background: color-mix(in srgb, var(--c-crit) 8%, transparent);
	}
</style>
