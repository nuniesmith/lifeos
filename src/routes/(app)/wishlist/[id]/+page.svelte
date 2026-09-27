<script lang="ts">
	import { enhance } from '$app/forms';
	import { Badge, Button, Card, Input, PageHeader, Select, Textarea } from '$lib/components';

	let { data, form } = $props();

	const item = $derived(data.item);
	const archived = $derived(item.archivedAt !== null);

	const STATUS_LABELS: Record<string, string> = {
		wanted: 'Wanted',
		bought: 'Bought',
		given: 'Given',
		declined: 'Declined'
	};
	const STATUS_TONE: Record<string, 'neutral' | 'accent' | 'ok'> = {
		wanted: 'accent',
		bought: 'ok',
		given: 'ok',
		declined: 'neutral'
	};

	const personOptions = $derived([
		{ value: '', label: 'Nobody in particular' },
		...data.people.map((p) => ({ value: p.id, label: p.name }))
	]);

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
</script>

<svelte:head><title>{item.name} · LifeOS</title></svelte:head>

<PageHeader title={item.name} back={{ href: '/wishlist', label: 'Wishlist' }}>
	{#snippet meta()}
		<Badge tone={STATUS_TONE[item.status]}>{STATUS_LABELS[item.status] ?? item.status}</Badge>
		{#if archived}<Badge tone="neutral">Archived</Badge>{/if}
		{#if item.isFavourite && !data.canEdit}
			<Badge tone="accent"><span aria-hidden="true">★</span> Favourite</Badge>
		{/if}
		{#if item.forPersonName}<span>For {item.forPersonName}</span>{/if}
	{/snippet}
	{#snippet actions()}
		{#if data.canEdit}
			<form method="POST" action="?/favourite" use:enhance>
				<input type="hidden" name="favourite" value={item.isFavourite ? 'false' : 'true'} />
				<!-- One label, and the state in aria-pressed and the star's shape:
				     see the identical control on a recipe's own page. -->
				<Button
					type="submit"
					variant={item.isFavourite ? 'primary' : 'secondary'}
					aria-pressed={item.isFavourite}
				>
					<span aria-hidden="true">{item.isFavourite ? '★' : '☆'}</span> Favourite
				</Button>
			</form>
		{/if}
	{/snippet}
</PageHeader>

{#if form?.error && form.action !== 'save'}
	<p class="notice error" role="alert">{form.error}</p>
{/if}

<div class="stack">
	<Card title="Details">
		{#if item.itemType || item.priceRange || item.occasion}
			<dl class="facts">
				{#if item.itemType}<div>
						<dt>Type</dt>
						<dd>{item.itemType}</dd>
					</div>{/if}
				{#if item.priceRange}<div>
						<dt>Price</dt>
						<dd>{item.priceRange}</dd>
					</div>{/if}
				{#if item.occasion}<div>
						<dt>Occasion</dt>
						<dd>{item.occasion}</dd>
					</div>{/if}
			</dl>
		{/if}
		{#if item.purpose}<p class="note"><strong>Why:</strong> {item.purpose}</p>{/if}
		{#if item.shopSource}<p class="note"><strong>Where:</strong> {item.shopSource}</p>{/if}
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
		{#if item.forPersonId}
			<div class="row-end">
				<Button variant="ghost" href={`/people/${item.forPersonId}`}>
					See {item.forPersonName}&rsquo;s page
				</Button>
			</div>
		{/if}
	</Card>

	{#if data.canEdit}
		<Card title="Status">
			<div class="status-actions">
				{#if item.status !== 'bought'}
					<form method="POST" action="?/status" use:enhance>
						<input type="hidden" name="status" value="bought" />
						<Button type="submit" variant="secondary">Mark bought</Button>
					</form>
				{/if}
				{#if item.status !== 'given'}
					<form method="POST" action="?/status" use:enhance>
						<input type="hidden" name="status" value="given" />
						<Button type="submit" variant="secondary">Mark given</Button>
					</form>
				{/if}
				{#if item.status !== 'declined'}
					<form method="POST" action="?/status" use:enhance>
						<input type="hidden" name="status" value="declined" />
						<Button type="submit" variant="ghost">Decline</Button>
					</form>
				{/if}
				{#if item.status !== 'wanted'}
					<form method="POST" action="?/status" use:enhance>
						<input type="hidden" name="status" value="wanted" />
						<Button type="submit" variant="ghost">Move back to wanted</Button>
					</form>
				{/if}
			</div>
			{#if errorFor('status')}<p class="notice error" role="alert">{errorFor('status')}</p>{/if}
		</Card>

		<details class="panel" bind:open={editing}>
			<summary>Edit item</summary>
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
				<input type="hidden" name="updatedAt" value={item.updatedAt.toISOString()} />

				<Input label="Name" name="name" value={item.name} required maxlength={300} />
				<div class="grid">
					<Input label="Type" name="itemType" value={item.itemType ?? ''} />
					<Input label="Price range" name="priceRange" value={item.priceRange ?? ''} />
					<Input label="Occasion" name="occasion" value={item.occasion ?? ''} />
					<Select
						label="For"
						name="forPersonId"
						options={personOptions}
						value={item.forPersonId ?? ''}
					/>
				</div>
				<Input
					label="Link"
					name="url"
					type="url"
					inputmode="url"
					placeholder="https://"
					value={item.url ?? ''}
				/>
				<Textarea label="Why" name="purpose" rows={2} value={item.purpose ?? ''} />
				<Input label="Where to buy it" name="shopSource" value={item.shopSource ?? ''} />

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
	{:else if !data.canEdit}
		<p class="muted">
			This item belongs to someone else in the household, so only they can change it.
		</p>
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
		grid-template-columns: repeat(auto-fill, minmax(7rem, 1fr));
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
	.row-end {
		display: flex;
		justify-content: flex-end;
	}
	.status-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-2);
	}
	.muted {
		margin: 0;
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
	}
	.panel[open] summary {
		border-bottom: 1px solid var(--c-border);
	}
	.edit {
		display: grid;
		gap: var(--sp-4);
		padding: var(--sp-4);
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 9rem), 1fr));
		gap: var(--sp-3);
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
