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
		Textarea
	} from '$lib/components';

	let { data, form } = $props();

	const bill = $derived(data.bill);
	const archived = $derived(bill.archivedAt !== null);

	const money = (amount: number | null, currency: string): string =>
		amount === null
			? '—'
			: new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);

	/** A stored day as the household reads it, with no timezone in between. */
	const longDay = (value: string) =>
		new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, {
			day: 'numeric',
			month: 'long',
			year: 'numeric',
			timeZone: 'UTC'
		});

	const TYPE_LABELS: Record<string, string> = { bill: 'Bill', subscription: 'Subscription' };
	const STATUS_LABELS: Record<string, string> = {
		active: 'Active',
		free_trial: 'Free trial',
		paused: 'Paused',
		cancelled: 'Cancelled'
	};
	const STATUS_TONE: Record<string, 'neutral' | 'accent' | 'ok' | 'warn'> = {
		active: 'ok',
		free_trial: 'warn',
		paused: 'neutral',
		cancelled: 'neutral'
	};
	const typeOptions = $derived(
		data.billTypes.map((t) => ({ value: t, label: TYPE_LABELS[t] ?? t }))
	);
	const statusOptions = $derived(
		data.billStatuses.map((s) => ({ value: s, label: STATUS_LABELS[s] ?? s }))
	);
	const frequencyOptions = $derived(
		data.billFrequencies.map((f) => ({ value: f, label: f.replace(/_/g, ' ') }))
	);

	const errorFor = (action: string) => (form?.action === action ? form.error : undefined);

	/*
	 * Whether the editor is unfolded. State the viewer owns, not something
	 * derived from the last result — see the identical comment on the
	 * person's own page for why.
	 */
	let editing = $state(Boolean(errorFor('save')));
	$effect.pre(() => {
		if (errorFor('save')) editing = true;
	});

	// The newest payment only — see deleteBillPayment's own header for why an
	// older one cannot be undone safely.
	const latestPaymentId = $derived(data.payments[0]?.id ?? null);
</script>

<svelte:head><title>{bill.name} · LifeOS</title></svelte:head>

<PageHeader title={bill.name} back={{ href: '/finance', label: 'Financial Hub' }}>
	{#snippet meta()}
		<Badge tone="neutral">{TYPE_LABELS[bill.type] ?? bill.type}</Badge>
		<Badge tone={STATUS_TONE[bill.status]}>{STATUS_LABELS[bill.status] ?? bill.status}</Badge>
		{#if archived}<Badge tone="neutral">Archived</Badge>{/if}
		{#if bill.autopay}<span>Autopay</span>{/if}
	{/snippet}
</PageHeader>

{#if form?.error && form.action !== 'save'}
	<p class="notice error" role="alert">{form.error}</p>
{:else if form?.action === 'archive' && form.restored}
	<p class="notice ok" role="status">Restored. It is back on the Financial Hub.</p>
{/if}

<div class="stack">
	<Card title="Details">
		<dl class="facts">
			<div>
				<dt>Amount</dt>
				<dd>{money(bill.amount, bill.currency)}</dd>
			</div>
			{#if bill.frequency}
				<div>
					<dt>Frequency</dt>
					<dd>{bill.frequency.replace(/_/g, ' ')}</dd>
				</div>
			{/if}
			{#if bill.nextDueOn}
				<div>
					<dt>Next due</dt>
					<dd>{longDay(bill.nextDueOn)}</dd>
				</div>
			{/if}
			{#if bill.category}
				<div>
					<dt>Category</dt>
					<dd>{bill.category}</dd>
				</div>
			{/if}
			{#if bill.account}
				<div>
					<dt>Account</dt>
					<dd>{bill.account}</dd>
				</div>
			{/if}
			{#if bill.status === 'free_trial' && (bill.trialPrice !== null || bill.freeTrialEndsOn)}
				<div>
					<dt>After the trial</dt>
					<dd>
						{bill.trialPrice !== null ? money(bill.trialPrice, bill.currency) : '—'}
						{#if bill.freeTrialEndsOn}from {longDay(bill.freeTrialEndsOn)}{/if}
					</dd>
				</div>
			{/if}
		</dl>
		{#if bill.notes}<p class="note">{bill.notes}</p>{/if}
		{#if data.source}
			<p class="note">
				<!-- The household's own link, not an application route, and
				     already checked to be http(s) on the server. -->
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
				<a href={data.source.href ?? undefined} target="_blank" rel="noopener noreferrer">
					{data.source.label}<span class="sr-only"> (opens in a new tab)</span>
				</a>
			</p>
		{/if}
	</Card>

	{#if data.canEdit && !archived}
		<Card title="Mark paid">
			{#if errorFor('markPaid')}<p class="notice error" role="alert">{errorFor('markPaid')}</p>{/if}
			<form method="POST" action="?/markPaid" use:enhance>
				<div class="grid">
					<Input
						label="Amount paid"
						name="amountPaid"
						type="number"
						inputmode="decimal"
						step="0.01"
						min="0.01"
						value={bill.amount?.toString() ?? ''}
					/>
					<Input label="Date paid" name="paidOn" type="date" value={data.today} />
				</div>
				<Input label="Note" name="note" placeholder="Optional" />
				<div class="actions">
					<Button type="submit" variant="primary">Mark paid</Button>
				</div>
			</form>
		</Card>
	{/if}

	<Card title="Payment history" flush>
		{#if data.payments.length === 0}
			<EmptyState
				title="No payments recorded"
				description="Mark it paid above to start a history."
			/>
		{:else}
			<List label="Payment history">
				{#each data.payments as payment (payment.id)}
					<ListRow title={money(payment.amountPaid, bill.currency)} meta={longDay(payment.paidOn)}>
						{#snippet trail()}
							{#if data.canEdit && payment.id === latestPaymentId}
								<form method="POST" action="?/undoPayment" use:enhance>
									<input type="hidden" name="paymentId" value={payment.id} />
									<Button type="submit" size="sm" variant="ghost">Undo</Button>
								</form>
							{/if}
						{/snippet}
						{#if payment.note}<p class="row-notes">{payment.note}</p>{/if}
					</ListRow>
				{/each}
			</List>
		{/if}
	</Card>

	{#if data.canEdit}
		<details class="panel" bind:open={editing}>
			<summary>Edit bill</summary>
			<form
				method="POST"
				action="?/save"
				class="edit"
				use:enhance={() =>
					async ({ update }) =>
						// Not reset: the fields should show what was saved, and this form
						// carries several <Select>s — a native reset() would otherwise put
						// them back on whichever option the page was first served with.
						update({ reset: false })}
			>
				<input type="hidden" name="updatedAt" value={bill.updatedAt.toISOString()} />

				<Input label="Name" name="name" value={bill.name} required maxlength={200} />
				<div class="grid">
					<Select label="Type" name="type" options={typeOptions} value={bill.type} />
					<Input
						label="Amount"
						name="amount"
						type="number"
						inputmode="decimal"
						step="0.01"
						min="0"
						value={bill.amount?.toString() ?? ''}
					/>
					<Input label="Currency" name="currency" value={bill.currency} maxlength={3} />
					<Select
						label="Frequency"
						name="frequency"
						options={frequencyOptions}
						placeholder="No fixed schedule"
						value={bill.frequency ?? ''}
					/>
					<Input label="Next due" name="nextDueOn" type="date" value={bill.nextDueOn ?? ''} />
					<Input label="Category" name="category" value={bill.category ?? ''} />
					<Input label="Account" name="account" value={bill.account ?? ''} />
					<Select label="Status" name="status" options={statusOptions} value={bill.status} />
					<Input
						label="Trial ends"
						name="freeTrialEndsOn"
						type="date"
						value={bill.freeTrialEndsOn ?? ''}
					/>
					<Input
						label="Price after trial"
						name="trialPrice"
						type="number"
						inputmode="decimal"
						step="0.01"
						min="0"
						value={bill.trialPrice?.toString() ?? ''}
					/>
				</div>
				<Input
					label="Link"
					name="url"
					type="url"
					inputmode="url"
					placeholder="https://"
					value={bill.url ?? ''}
				/>
				<label class="check">
					<input type="checkbox" name="autopay" checked={bill.autopay} />
					Autopay
				</label>
				<Textarea label="Notes" name="notes" rows={2} value={bill.notes ?? ''} />

				{#if errorFor('save')}
					<p class="notice error" role="alert">{errorFor('save')}</p>
				{:else if form?.action === 'save' && form.saved}
					<p class="notice ok" role="status">Saved.</p>
				{/if}

				<div class="row-end">
					<Button type="submit" variant="primary">Save changes</Button>
				</div>
			</form>
		</details>

		<Card title={archived ? 'Restore' : 'Archive'}>
			<p class="muted">
				{archived
					? 'Archived: off the Financial Hub. Restoring brings it back.'
					: 'Archiving takes it off the Financial Hub without deleting anything. It waits in the Archive.'}
			</p>
			<form method="POST" action="?/archive" use:enhance>
				<input type="hidden" name="archived" value={archived ? 'false' : 'true'} />
				<Button type="submit" variant={archived ? 'primary' : 'secondary'}>
					{archived ? 'Restore' : 'Archive'}
				</Button>
			</form>
		</Card>
	{/if}
</div>

<style>
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}
	.facts {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
		gap: var(--sp-3);
		margin: 0 0 var(--sp-3);
	}
	.facts div {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}
	dt {
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
		letter-spacing: 0.03em;
		text-transform: uppercase;
	}
	dd {
		margin: 0;
		font-weight: 600;
	}
	.note {
		margin: 0 0 var(--sp-2);
		overflow-wrap: anywhere;
	}
	.note a {
		display: inline-flex;
		align-items: center;
		min-height: var(--tap);
	}
	.row-notes {
		margin: var(--sp-1) 0 0;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}
	.row-end {
		display: flex;
		justify-content: flex-end;
	}
	.muted {
		margin: 0 0 var(--sp-3);
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}

	form {
		display: flex;
		flex-direction: column;
		gap: var(--sp-3);
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 9rem), 1fr));
		gap: var(--sp-3);
	}
	.actions {
		display: flex;
		justify-content: flex-end;
	}
	.check {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		min-height: var(--tap);
		font-size: var(--fs-sm);
	}
	.check input {
		width: 20px;
		height: 20px;
		min-height: 0;
		accent-color: var(--c-accent);
	}

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
		font-size: var(--fs-lg);
		font-weight: 650;
		cursor: pointer;
	}
	.panel[open] summary {
		border-bottom: 1px solid var(--c-border);
	}
	.edit {
		gap: var(--sp-4);
		padding: var(--sp-4);
	}

	.notice {
		padding: var(--sp-2) var(--sp-3);
		border-radius: var(--radius-sm);
		margin: 0 0 var(--sp-4);
		font-size: var(--fs-sm);
	}
	.edit .notice {
		margin: 0;
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
