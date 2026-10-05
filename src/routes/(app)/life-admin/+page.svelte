<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
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
		appPath
	} from '$lib/components';

	let { data, form } = $props();

	type Doc = (typeof data.documents)[number];

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

	const needsAttention = $derived(
		data.documents.filter((d) => d.state === 'expired' || d.state === 'due')
	);
	const upcoming = $derived(data.documents.filter((d) => d.state === 'ok'));
	const noExpiry = $derived(data.documents.filter((d) => d.state === 'none'));

	/** A stored day as the household reads it, with no timezone in between. */
	const longDay = (value: string) =>
		new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, {
			day: 'numeric',
			month: 'short',
			year: 'numeric',
			timeZone: 'UTC'
		});

	const metaFor = (doc: Doc): string =>
		[KIND_LABELS[doc.kind] ?? doc.kind, doc.holderName].filter(Boolean).join(' · ');

	/** Builds `/life-admin?kind=...&holder=...`, preserving whichever of the
	 *  two dimensions a filter chip does not itself change. */
	const filterHref = (next: { kind?: string | null; holder?: string | null }): string => {
		const kind = next.kind !== undefined ? next.kind : data.kind;
		const holder = next.holder !== undefined ? next.holder : data.holder;
		const parts = [kind ? `kind=${kind}` : '', holder ? `holder=${holder}` : ''].filter(Boolean);
		return parts.length ? `/life-admin?${parts.join('&')}` : '/life-admin';
	};

	const errorFor = (action: string) => (form?.action === action ? form.error : undefined);

	/*
	 * Bumped after a successful add to draw the quick-add form afresh. It
	 * carries two <Select>s (kind, holder) -- a native form reset
	 * (SvelteKit's default after `use:enhance`) would put each back on
	 * whichever option it was first SERVED with, not the one it was just
	 * reset away from. Redrawing with `{#key}` starts every control fresh
	 * from this component's own declared defaults instead -- the identical
	 * device finance's own "Add bill" form uses.
	 */
	let quickAddKey = $state(0);
</script>

<svelte:head><title>Life Admin HQ · LifeOS</title></svelte:head>

<PageHeader
	title="Life Admin HQ"
	description="Documents and renewals: IDs, insurance, warranties, licences and the like."
/>

<div class="stack">
	<Card title="Filter">
		<div class="filter-group">
			<span class="filter-label">Kind</span>
			<div class="filters">
				<a class="chip" class:on={!data.kind} href={resolve(appPath(filterHref({ kind: null })))}>
					All
				</a>
				{#each data.kinds as k (k)}
					<a
						class="chip"
						class:on={data.kind === k}
						href={resolve(appPath(filterHref({ kind: k })))}
					>
						{KIND_LABELS[k] ?? k}
					</a>
				{/each}
			</div>
		</div>
		{#if data.people.length > 0}
			<div class="filter-group">
				<span class="filter-label">Holder</span>
				<div class="filters">
					<a
						class="chip"
						class:on={!data.holder}
						href={resolve(appPath(filterHref({ holder: null })))}
					>
						Anyone
					</a>
					{#each data.people as p (p.id)}
						<a
							class="chip"
							class:on={data.holder === p.id}
							href={resolve(appPath(filterHref({ holder: p.id })))}
						>
							{p.name}
						</a>
					{/each}
				</div>
			</div>
		{/if}
	</Card>

	<Card title="Add a document">
		{#if errorFor('create')}<p class="notice error" role="alert">{errorFor('create')}</p>{/if}
		{#key quickAddKey}
			<form
				method="POST"
				action="?/create"
				use:enhance={() => {
					return async ({ result, update }) => {
						await update();
						if (result.type === 'success') quickAddKey += 1;
					};
				}}
			>
				<div class="grid">
					<Input
						label="Title"
						name="title"
						placeholder="Fictional Passport"
						required
						maxlength={200}
					/>
					<Select label="Kind" name="kind" options={kindOptions} value="other" />
					<Select
						label="Holder"
						name="holderPersonId"
						options={holderOptions}
						placeholder="Nobody in particular"
					/>
					<Input label="Expires on" name="expiresOn" type="date" />
				</div>
				<div class="actions">
					<Button type="submit" variant="primary">Add document</Button>
				</div>
			</form>
		{/key}
	</Card>

	<section aria-labelledby="attention-heading">
		<h2 id="attention-heading" class="section-title">Needs attention</h2>
		<Card flush>
			{#if needsAttention.length === 0}
				<EmptyState
					title="Nothing needs attention"
					description="Expired and soon-to-expire documents will show up here."
					icon="clock"
				/>
			{:else}
				<List label="Needs attention">
					{#each needsAttention as doc (doc.id)}
						<ListRow title={doc.title} href={`/life-admin/${doc.id}`} meta={metaFor(doc)}>
							{#snippet trail()}
								<Badge tone={doc.state === 'expired' ? 'crit' : 'warn'}>{doc.dueLabel}</Badge>
							{/snippet}
						</ListRow>
					{/each}
				</List>
			{/if}
		</Card>
	</section>

	<section aria-labelledby="everything-else-heading">
		<h2 id="everything-else-heading" class="section-title">Everything else</h2>
		<Card flush>
			{#if upcoming.length === 0}
				<EmptyState title="Nothing else yet" />
			{:else}
				<List label="Everything else">
					{#each upcoming as doc (doc.id)}
						<ListRow title={doc.title} href={`/life-admin/${doc.id}`} meta={metaFor(doc)}>
							{#snippet trail()}
								{#if doc.expiresOn}<span class="expiry">{longDay(doc.expiresOn)}</span>{/if}
							{/snippet}
						</ListRow>
					{/each}
				</List>
			{/if}
		</Card>
	</section>

	<section aria-labelledby="no-expiry-heading">
		<h2 id="no-expiry-heading" class="section-title">No expiry</h2>
		<Card flush>
			{#if noExpiry.length === 0}
				<EmptyState title="Nothing here" />
			{:else}
				<List label="No expiry">
					{#each noExpiry as doc (doc.id)}
						<ListRow title={doc.title} href={`/life-admin/${doc.id}`} meta={metaFor(doc)} />
					{/each}
				</List>
			{/if}
		</Card>
	</section>
</div>

<style>
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}
	.section-title {
		margin: 0 0 var(--sp-2);
		font-size: var(--fs-lg);
		font-weight: 650;
	}
	.filter-group {
		display: flex;
		flex-direction: column;
		gap: var(--sp-1);
		margin-bottom: var(--sp-3);
	}
	.filter-group:last-child {
		margin-bottom: 0;
	}
	.filter-label {
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
		letter-spacing: 0.03em;
		text-transform: uppercase;
	}
	.filters {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-2);
	}
	.chip {
		display: inline-flex;
		align-items: center;
		min-height: var(--tap);
		padding: 0 var(--sp-3);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-pill);
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
		text-decoration: none;
	}
	.chip.on {
		border-color: var(--c-accent);
		background: var(--c-accent-soft);
		color: var(--c-accent);
		font-weight: 600;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 9rem), 1fr));
		gap: var(--sp-3);
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		margin-top: var(--sp-3);
	}
	.expiry {
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}
	.notice {
		padding: var(--sp-2) var(--sp-3);
		border-radius: var(--radius-sm);
		margin: 0 0 var(--sp-3);
		font-size: var(--fs-sm);
	}
	.notice.error {
		color: var(--c-crit);
		border: 1px solid color-mix(in srgb, var(--c-crit) 25%, transparent);
		background: color-mix(in srgb, var(--c-crit) 8%, transparent);
	}
</style>
