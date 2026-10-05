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

	// Named `doc`, not `document`: the latter would shadow the DOM global.
	const doc = $derived(data.document);
	const archived = $derived(doc.archivedAt !== null);

	const KIND_LABELS: Record<string, string> = {
		id: 'ID',
		insurance: 'Insurance',
		warranty: 'Warranty',
		licence: 'Licence',
		registration: 'Registration',
		membership: 'Membership',
		certificate: 'Certificate',
		other: 'Other'
	};
	const kindOptions = $derived(data.kinds.map((k) => ({ value: k, label: KIND_LABELS[k] ?? k })));
	const holderOptions = $derived(data.people.map((p) => ({ value: p.id, label: p.name })));

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
	 * derived from the last result -- the identical reasoning /people/[id]
	 * and /finance/bills/[id] give their own equivalent flag.
	 */
	let editing = $state(Boolean(errorFor('save')));
	$effect.pre(() => {
		if (errorFor('save')) editing = true;
	});

	// The renewal entered last, which is not always the top row: the list is
	// in `renewedOn` order, and a renewal can be entered late for an earlier
	// document. See deleteRenewal's header for why only this one can be undone.
	const latestRenewalId = $derived(
		data.renewals.reduce<(typeof data.renewals)[number] | null>(
			(latest, renewal) =>
				latest === null || renewal.createdAt > latest.createdAt ? renewal : latest,
			null
		)?.id ?? null
	);
</script>

<svelte:head><title>{doc.title} · LifeOS</title></svelte:head>

<PageHeader title={doc.title} back={{ href: '/life-admin', label: 'Life Admin HQ' }}>
	{#snippet meta()}
		<Badge tone="neutral">{KIND_LABELS[doc.kind] ?? doc.kind}</Badge>
		{#if archived}<Badge tone="neutral">Archived</Badge>{/if}
	{/snippet}
</PageHeader>

{#if form?.error && form.action !== 'save'}
	<p class="notice error" role="alert">{form.error}</p>
{:else if form?.action === 'archive' && form.restored}
	<p class="notice ok" role="status">Restored. It is back on Life Admin HQ.</p>
{:else if form?.action === 'renew'}
	<p class="notice ok" role="status">Renewed.</p>
{:else if form?.action === 'undoRenewal'}
	<p class="notice ok" role="status">Renewal undone.</p>
{/if}

<div class="stack">
	<Card title="Details">
		<dl class="facts">
			{#if doc.holderName}
				<div>
					<dt>Holder</dt>
					<dd>{doc.holderName}</dd>
				</div>
			{/if}
			{#if doc.issuer}
				<div>
					<dt>Issuer</dt>
					<dd>{doc.issuer}</dd>
				</div>
			{/if}
			{#if doc.issuedOn}
				<div>
					<dt>Issued</dt>
					<dd>{longDay(doc.issuedOn)}</dd>
				</div>
			{/if}
			<div>
				<dt>Expires</dt>
				<dd>{doc.expiresOn ? longDay(doc.expiresOn) : 'Never'}</dd>
			</div>
			{#if doc.expiresOn}
				<div>
					<dt>Renewal notice</dt>
					<dd>{doc.renewLeadDays} day{doc.renewLeadDays === 1 ? '' : 's'} before</dd>
				</div>
			{/if}
			{#if doc.location}
				<div>
					<dt>Location</dt>
					<dd>{doc.location}</dd>
				</div>
			{/if}
			{#if doc.reference}
				<div>
					<dt>Reference</dt>
					<dd>{doc.reference}</dd>
				</div>
			{/if}
		</dl>
		{#if data.notesHtml}
			<!--
				Safe for the same reason as the routine's own notes: `data.notesHtml`
				is built on the server by renderMarkdown ($lib/server/markdown),
				which runs DOMPurify over an explicit tag and attribute allowlist.
				The document's own notes never reach this tag; only that sanitized
				output does.
			-->
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			<div class="notes">{@html data.notesHtml}</div>
		{/if}
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
		<Card title="Renew">
			{#if errorFor('renew')}<p class="notice error" role="alert">{errorFor('renew')}</p>{/if}
			<form method="POST" action="?/renew" use:enhance>
				<div class="grid">
					<Input label="New expiry date" name="newExpiresOn" type="date" required />
					<Input label="Renewed on" name="renewedOn" type="date" value={data.today} />
				</div>
				<Input label="Note" name="note" placeholder="Optional" />
				<div class="actions">
					<Button type="submit" variant="primary">Renew</Button>
				</div>
			</form>
		</Card>
	{/if}

	<Card title="Renewal history" flush>
		{#if data.renewals.length === 0}
			<EmptyState title="No renewals recorded" description="Renew it above to start a history." />
		{:else}
			<List label="Renewal history">
				{#each data.renewals as renewal (renewal.id)}
					<ListRow
						title={longDay(renewal.newExpiresOn)}
						meta={`Renewed ${longDay(renewal.renewedOn)}`}
					>
						{#snippet trail()}
							{#if data.canEdit && renewal.id === latestRenewalId}
								<form method="POST" action="?/undoRenewal" use:enhance>
									<input type="hidden" name="renewalId" value={renewal.id} />
									<Button type="submit" size="sm" variant="ghost">Undo</Button>
								</form>
							{/if}
						{/snippet}
						{#if renewal.note}<p class="row-notes">{renewal.note}</p>{/if}
					</ListRow>
				{/each}
			</List>
		{/if}
	</Card>

	{#if data.canEdit}
		<details class="panel" bind:open={editing}>
			<summary>Edit document</summary>
			<form
				method="POST"
				action="?/save"
				class="edit"
				use:enhance={() =>
					async ({ update }) =>
						// Not reset: the fields should show what was saved, and this
						// form carries two <Select>s -- a native reset() would
						// otherwise put them back on whichever option the page was
						// first served with.
						update({ reset: false })}
			>
				<input type="hidden" name="updatedAt" value={doc.updatedAt.toISOString()} />

				<Input label="Title" name="title" value={doc.title} required maxlength={200} />
				<div class="grid">
					<Select label="Kind" name="kind" options={kindOptions} value={doc.kind} />
					<Select
						label="Holder"
						name="holderPersonId"
						options={holderOptions}
						placeholder="Nobody in particular"
						value={doc.holderPersonId ?? ''}
					/>
					<Input label="Issuer" name="issuer" value={doc.issuer ?? ''} />
					<Input label="Issued on" name="issuedOn" type="date" value={doc.issuedOn ?? ''} />
					<Input label="Expires on" name="expiresOn" type="date" value={doc.expiresOn ?? ''} />
					<Input
						label="Renewal notice (days)"
						name="renewLeadDays"
						type="number"
						min="0"
						max="365"
						value={doc.renewLeadDays.toString()}
					/>
					<Input label="Location" name="location" value={doc.location ?? ''} />
				</div>
				<Input
					label="Reference"
					name="reference"
					hint="The last 4 digits only is plenty"
					value={doc.reference ?? ''}
				/>
				<Input
					label="Link"
					name="url"
					type="url"
					inputmode="url"
					placeholder="https://"
					value={doc.url ?? ''}
				/>
				<Textarea label="Notes" name="notes" rows={4} value={doc.notes ?? ''} />

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
					? 'Archived: off Life Admin HQ. Restoring brings it back.'
					: 'Archiving takes it off Life Admin HQ without deleting anything. It waits in the Archive.'}
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
	.notes {
		margin: 0 0 var(--sp-3);
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
