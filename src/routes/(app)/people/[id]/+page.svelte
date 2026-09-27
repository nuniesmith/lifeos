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

	const person = $derived(data.person);
	const archived = $derived(person.archivedAt !== null);

	const KIND_LABELS: Record<string, string> = {
		me: 'Me',
		person: 'Person',
		place: 'Place',
		pet: 'Pet'
	};
	const KIND_OPTIONS = [
		{ value: 'me', label: 'Me' },
		{ value: 'person', label: 'Person' },
		{ value: 'place', label: 'Place' },
		{ value: 'pet', label: 'Pet' }
	];
	const RECURRENCE_LABELS: Record<string, string> = {
		none: 'One time',
		yearly: 'Every year',
		monthly: 'Every month',
		custom: 'Custom'
	};
	const RECURRENCE_OPTIONS = [
		{ value: 'yearly', label: 'Every year' },
		{ value: 'monthly', label: 'Every month' },
		{ value: 'none', label: 'Does not repeat' }
	];
	const STATUS_LABELS: Record<string, string> = {
		wanted: 'Wanted',
		bought: 'Bought',
		given: 'Given',
		declined: 'Declined'
	};
	const STATUS_TONE: Record<string, 'neutral' | 'accent' | 'ok' | 'warn'> = {
		wanted: 'accent',
		bought: 'ok',
		given: 'ok',
		declined: 'neutral'
	};

	/** A stored day as the household reads it, with no timezone in between. */
	const longDay = (value: string) =>
		new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, {
			day: 'numeric',
			month: 'long',
			year: 'numeric',
			timeZone: 'UTC'
		});

	const errorFor = (action: string) => (form?.action === action ? form.error : undefined);

	/*
	 * Whether the editor is unfolded. State the viewer owns, not something
	 * derived from the last result: derived, a successful save would fold the
	 * form away mid-edit. A refused save opens it, so the message and the
	 * values that were refused stay in view — on the server render too, for a
	 * browser without JavaScript.
	 */
	let editing = $state(Boolean(errorFor('save')));
	$effect.pre(() => {
		if (errorFor('save')) editing = true;
	});
</script>

<svelte:head><title>{person.name} · LifeOS</title></svelte:head>

<PageHeader title={person.name} back={{ href: '/people', label: 'People & Places' }}>
	{#snippet meta()}
		<Badge tone="neutral">{KIND_LABELS[person.kind] ?? person.kind}</Badge>
		{#if archived}<Badge tone="neutral">Archived</Badge>{/if}
		{#if person.groups.length > 0}<span>{person.groups.join(' · ')}</span>{/if}
		{#if person.birthday}<span>Born {longDay(person.birthday)}</span>{/if}
	{/snippet}
</PageHeader>

{#if form?.error && form.action !== 'save' && form.action !== 'addDate'}
	<p class="notice error" role="alert">{form.error}</p>
{:else if form?.action === 'archive' && form.restored}
	<p class="notice ok" role="status">Restored. They are back on People &amp; Places.</p>
{/if}

<div class="stack">
	{#if person.notes}
		<Card title="Notes"><p class="notes">{person.notes}</p></Card>
	{/if}

	<Card title="Gifts" flush>
		{#if data.gifts.length === 0}
			<EmptyState
				title="Nothing on the wishlist for them"
				description="Add an idea from the wishlist and choose this person."
				icon="goals"
			/>
		{:else}
			<List label="Gifts">
				{#each data.gifts as gift (gift.id)}
					<ListRow
						title={gift.name}
						href={`/wishlist/${gift.id}`}
						meta={gift.occasion ?? undefined}
					>
						{#snippet trail()}<Badge tone={STATUS_TONE[gift.status]}
								>{STATUS_LABELS[gift.status] ?? gift.status}</Badge
							>{/snippet}
					</ListRow>
				{/each}
			</List>
		{/if}
	</Card>

	<Card title="Important dates" flush>
		{#if data.dates.length === 0}
			<EmptyState title="No dates recorded" icon="today" />
		{:else}
			<List label="Important dates">
				{#each data.dates as d (d.id)}
					{@const removed = d.archivedAt !== null}
					<ListRow
						title={d.title}
						meta={`${longDay(d.onDate)}${d.recurrence !== 'none' ? ` · ${RECURRENCE_LABELS[d.recurrence]}` : ''}`}
						muted={removed}
					>
						{#snippet trail()}
							{#if removed}<Badge tone="neutral">Removed</Badge>{/if}
							{#if data.canEdit}
								<form method="POST" action="?/archiveDate" use:enhance>
									<input type="hidden" name="id" value={d.id} />
									<input type="hidden" name="archived" value={removed ? 'false' : 'true'} />
									<Button
										type="submit"
										size="sm"
										variant="ghost"
										aria-label={`${removed ? 'Restore' : 'Remove'} ${d.title}`}
									>
										{removed ? 'Restore' : 'Remove'}
									</Button>
								</form>
							{/if}
						{/snippet}
					</ListRow>
				{/each}
			</List>
		{/if}
	</Card>

	{#if data.canEdit}
		<Card title="Add an important date">
			<form method="POST" action="?/addDate" use:enhance>
				<div class="grid">
					<Input label="Title" name="title" placeholder="Birthday" required maxlength={300} />
					<Input label="Date" name="onDate" type="date" required value={data.today} />
					<Select label="Repeats" name="recurrence" options={RECURRENCE_OPTIONS} value="yearly" />
				</div>
				{#if errorFor('addDate')}
					<p class="notice error" role="alert">{errorFor('addDate')}</p>
				{/if}
				<div class="row-end">
					<Button type="submit" variant="primary">Add date</Button>
				</div>
			</form>
		</Card>

		<details class="panel" bind:open={editing}>
			<summary>Edit {KIND_LABELS[person.kind]?.toLowerCase() ?? 'record'}</summary>
			<form
				method="POST"
				action="?/save"
				class="edit"
				use:enhance={() =>
					async ({ update }) =>
						// Not reset: the fields should show what was saved, and this form
						// carries a <Select> — a native reset() would otherwise put it
						// back on whichever option the page was first served with.
						update({ reset: false })}
			>
				<!-- The version this form was rendered from; `.toISOString()`
				     because the precondition compares to the millisecond. -->
				<input type="hidden" name="updatedAt" value={person.updatedAt.toISOString()} />

				<Input label="Name" name="name" value={person.name} required maxlength={200} />
				<div class="grid">
					<Select label="Kind" name="kind" options={KIND_OPTIONS} value={person.kind} />
					<Input
						label="Groups"
						name="groups"
						value={person.groups.join(', ')}
						hint="Comma separated: Family, Friends"
					/>
					<Input label="Birthday" name="birthday" type="date" value={person.birthday ?? ''} />
				</div>
				<Textarea label="Notes" name="notes" rows={3} value={person.notes ?? ''} />

				<div class="contacts">
					<h3>Contact details</h3>
					<p class="muted">
						Shown only on this page — never on People &amp; Places, in search, or on a card.
					</p>
					<div class="grid">
						<Input label="Email" name="email" type="email" value={person.email ?? ''} />
						<Input label="Phone" name="phone" type="tel" value={person.phone ?? ''} />
					</div>
					<Textarea label="Address" name="address" rows={2} value={person.address ?? ''} />
				</div>

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
					? 'Archived: off People & Places and out of search. Restoring brings them back.'
					: 'Archiving takes them off People & Places without deleting anything. They wait in the Archive.'}
			</p>
			<form method="POST" action="?/archive" use:enhance>
				<input type="hidden" name="archived" value={archived ? 'false' : 'true'} />
				<Button type="submit" variant={archived ? 'primary' : 'secondary'}>
					{archived ? 'Restore' : 'Archive'}
				</Button>
			</form>
		</Card>
	{:else}
		<p class="muted">
			This record belongs to someone else in the household, so only they can change it.
		</p>
	{/if}
</div>

<style>
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}
	.notes {
		margin: 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 9rem), 1fr));
		gap: var(--sp-3);
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
		text-transform: capitalize;
	}
	.panel[open] summary {
		border-bottom: 1px solid var(--c-border);
	}
	.edit {
		display: grid;
		gap: var(--sp-4);
		padding: var(--sp-4);
	}
	.contacts {
		display: flex;
		flex-direction: column;
		gap: var(--sp-3);
		padding-top: var(--sp-3);
		border-top: 1px solid var(--c-border);
	}
	.contacts h3 {
		margin: 0;
		font-size: var(--fs-base);
		font-weight: 650;
	}
	.contacts .muted {
		margin: calc(var(--sp-1) * -1) 0 0;
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
