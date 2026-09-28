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
		Textarea,
		appPath
	} from '$lib/components';
	import type { RangeStatus } from '$lib/server/repositories';

	let { data, form } = $props();

	const archived = $derived(data.visit.archivedAt !== null);

	// The native date/time inputs edit in the browser's own local time, the
	// same zone `when()` on the list page already displays in.
	const pad = (n: number) => String(n).padStart(2, '0');
	const dateValue = (at: Date) =>
		`${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
	const timeValue = (at: Date) => `${pad(at.getHours())}:${pad(at.getMinutes())}`;

	const STATUS_TONE: Record<RangeStatus, 'ok' | 'crit' | 'neutral'> = {
		low: 'crit',
		high: 'crit',
		in_range: 'ok',
		no_reference: 'neutral'
	};
	const STATUS_LABEL: Record<RangeStatus, string> = {
		low: 'Low',
		high: 'High',
		in_range: 'In range',
		no_reference: 'No reference range'
	};

	const symptomOptions = $derived(
		data.pickableSymptoms.map((term) => ({ value: term.id, label: term.name }))
	);

	// Bumped after a successful save to draw the Details form afresh, the same
	// fix as `addFormKey` on /health/measurements: this form carries three
	// <Select>s now, and a plain `update()` resets a native <select> back to
	// whichever option the page was first served with rather than the one just
	// saved -- remounting under a fresh key reads the current value instead of
	// fighting the browser's own reset.
	let detailsFormKey = $state(0);

	const providerOptions = $derived([
		{ value: '', label: 'No provider linked' },
		...data.providers.map((p) => ({ value: p.id, label: p.name }))
	]);
	const placeOptions = $derived([
		{ value: '', label: 'No place linked' },
		...data.places.map((p) => ({ value: p.id, label: p.name }))
	]);
	const petOptions = $derived([
		{ value: '', label: 'No pet linked' },
		...data.pets.map((p) => ({ value: p.id, label: p.name }))
	]);

	// The header's own summary: the linked record's name when there is one,
	// the imported free text otherwise -- linking never rewrites that text, so
	// both are read here rather than one being derived from the other. A link
	// to /people/[id] is only ever shown alongside a NAME that came from a
	// link, never over the plain imported text, which names someone this
	// household may not have a `people` row for at all.
	const personLink = (id: string | null) => (id ? `/people/${id}` : null);
	const providerDisplay = $derived(data.linked.providerName ?? data.visit.provider);
	const providerHref = $derived(
		data.linked.providerName ? personLink(data.visit.providerPersonId) : null
	);
	const locationDisplay = $derived(data.linked.locationName ?? data.visit.location);
	const locationHref = $derived(
		data.linked.locationName ? personLink(data.visit.locationPlaceId) : null
	);
	const petHref = $derived(data.linked.petName ? personLink(data.visit.petId) : null);

	const addedFeedback = (action: 'addProvider' | 'addPlace' | 'addPet') =>
		form && form.action === action && 'addedId' in form ? 'Added.' : undefined;
</script>

<svelte:head><title>{data.visit.reason} · LifeOS</title></svelte:head>

<PageHeader title={data.visit.reason} back={{ href: '/health/visits', label: 'Medical visits' }}>
	{#snippet meta()}
		{#if data.visit.visitType}<Badge tone="accent">{data.visit.visitType}</Badge>{/if}
		{#if archived}<Badge tone="neutral">Archived</Badge>{/if}
		{#if providerDisplay}
			<span>
				{#if providerHref}<a href={resolve(appPath(providerHref))}>{providerDisplay}</a
					>{:else}{providerDisplay}{/if}
			</span>
		{/if}
		{#if locationDisplay}
			<span>
				{#if locationHref}<a href={resolve(appPath(locationHref))}>{locationDisplay}</a
					>{:else}{locationDisplay}{/if}
			</span>
		{/if}
		{#if petHref}
			<span><a href={resolve(appPath(petHref))}>{data.linked.petName}</a></span>
		{/if}
	{/snippet}
</PageHeader>

{#if form?.error}
	<p class="notice error" role="alert">{form.error}</p>
{:else if form?.saved}
	<p class="notice ok" role="status">Saved.</p>
{/if}

<div class="columns">
	<div class="column">
		<Card title="Details">
			{#key detailsFormKey}
				<form
					method="POST"
					action="?/saveVisit"
					class="edit"
					use:enhance={() => {
						return async ({ result, update }) => {
							await update();
							if (result.type === 'success') detailsFormKey += 1;
						};
					}}
				>
					<input type="hidden" name="updatedAt" value={data.visit.updatedAt.toISOString()} />
					<Input label="Reason" name="reason" value={data.visit.reason} required />
					<div class="grid">
						<Input
							label="Date"
							name="visitDate"
							type="date"
							value={dateValue(data.visit.visitAt)}
							required
						/>
						<Input
							label="Time"
							name="visitTime"
							type="time"
							value={timeValue(data.visit.visitAt)}
							required
						/>
					</div>
					<div class="grid">
						<Input label="Visit type" name="visitType" value={data.visit.visitType ?? ''} />
						<Input label="Provider" name="provider" value={data.visit.provider ?? ''} />
						<Input label="Location" name="location" value={data.visit.location ?? ''} />
					</div>

					<!--
						Independent of the two free-text fields above: linking never
						rewrites the imported words (migration 0028's own header), so a
						visit can carry both an unlinked "Provider" string and a linked
						person, and saving one never touches the other.
					-->
					<div class="grid">
						<Select
							label="Linked provider"
							name="providerPersonId"
							options={providerOptions}
							value={data.visit.providerPersonId ?? ''}
						/>
						<Select
							label="Linked place"
							name="locationPlaceId"
							options={placeOptions}
							value={data.visit.locationPlaceId ?? ''}
						/>
						<Select
							label="Linked pet"
							name="petId"
							options={petOptions}
							value={data.visit.petId ?? ''}
						/>
					</div>

					<div class="grid">
						<Input
							label="Cost"
							name="amount"
							type="number"
							step="any"
							value={data.visit.amount?.toString() ?? ''}
						/>
						<Input label="Currency" name="currency" value={data.visit.currency} />
						<Input label="Paid by" name="paidBy" value={data.visit.paidBy ?? ''} />
					</div>
					<Input
						label="Requirements"
						name="requirements"
						placeholder="Bloodwork, Fasting"
						hint="Comma-separated"
						value={data.visit.requirements.join(', ')}
					/>
					<Input label="Who it was for" name="familyMember" value={data.visit.familyMember ?? ''} />
					<Textarea label="Notes" name="notes" rows={3} value={data.visit.notes ?? ''} />

					<div>
						<Button type="submit" variant="primary">Save</Button>
					</div>
				</form>
			{/key}

			<!--
				"Add a new one" inline, reusing /people's own creation code
				(createPerson): each mini-form adds a person of the one `kind` its
				button names, then the picker above lists it once the page
				revalidates. It is not auto-selected -- see the report for why this
				was kept simple rather than also wiring a client-side auto-select.
			-->
			<div class="add-links">
				<form method="POST" action="?/addProvider" use:enhance class="add-link">
					<div class="grow">
						<Input label="New provider" labelHidden name="name" placeholder="Add a provider" />
					</div>
					<Button type="submit" size="sm">Add provider</Button>
					{#if addedFeedback('addProvider')}
						<span class="added-ok">{addedFeedback('addProvider')}</span>
					{/if}
				</form>
				<form method="POST" action="?/addPlace" use:enhance class="add-link">
					<div class="grow">
						<Input label="New place" labelHidden name="name" placeholder="Add a place" />
					</div>
					<Button type="submit" size="sm">Add place</Button>
					{#if addedFeedback('addPlace')}
						<span class="added-ok">{addedFeedback('addPlace')}</span>
					{/if}
				</form>
				<form method="POST" action="?/addPet" use:enhance class="add-link">
					<div class="grow">
						<Input label="New pet" labelHidden name="name" placeholder="Add a pet" />
					</div>
					<Button type="submit" size="sm">Add pet</Button>
					{#if addedFeedback('addPet')}
						<span class="added-ok">{addedFeedback('addPet')}</span>
					{/if}
				</form>
			</div>
		</Card>

		<Card title="Lab results from this visit" flush>
			{#if data.results.length === 0}
				<EmptyState
					title="No results linked"
					description="Link a result to this visit from the marker's own page."
					icon="journal"
				/>
			{:else}
				<List label="Lab results linked to this visit">
					{#each data.results as result (result.id)}
						<ListRow
							title={result.markerName}
							meta={`${result.value}${result.units ? ` ${result.units}` : ''} · ${result.resultDate}`}
							href={`/health/labs/${result.markerId}`}
						>
							{#snippet trail()}
								<Badge tone={STATUS_TONE[result.status]}>{STATUS_LABEL[result.status]}</Badge>
							{/snippet}
						</ListRow>
					{/each}
				</List>
			{/if}
		</Card>
	</div>

	<div class="column">
		<Card title="Symptoms" subtitle="What this visit was about">
			{#if data.symptoms.length > 0}
				<ul class="chips">
					{#each data.symptoms as symptom (symptom.vocabularyId)}
						<li>
							{symptom.name}
							<form method="POST" action="?/removeSymptom" use:enhance>
								<input type="hidden" name="vocabularyId" value={symptom.vocabularyId} />
								<button type="submit" aria-label={`Remove ${symptom.name}`}>×</button>
							</form>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="muted">None attached yet.</p>
			{/if}

			{#if symptomOptions.length > 0}
				<form method="POST" action="?/addSymptom" class="add-symptom" use:enhance>
					<div class="grow">
						<Select
							label="Attach a symptom"
							labelHidden
							name="vocabularyId"
							options={symptomOptions}
							placeholder="Choose a symptom"
							required
						/>
					</div>
					<Button type="submit">Attach</Button>
				</form>
			{/if}
			<p class="muted small">
				New symptoms are added from <a href={resolve(appPath('/health'))}>Health</a>.
			</p>
		</Card>

		<Card title={archived ? 'Restore' : 'Archive'}>
			<p class="muted">
				{archived
					? 'This visit is archived and hidden from the list. Restoring brings it back.'
					: 'Archiving hides this visit without deleting it. Its results are untouched.'}
			</p>
			<form method="POST" action="?/archiveVisit" use:enhance>
				<input type="hidden" name="updatedAt" value={data.visit.updatedAt.toISOString()} />
				<input type="hidden" name="archived" value={archived ? 'false' : 'true'} />
				<Button type="submit" variant={archived ? 'primary' : 'ghost'}>
					{archived ? 'Restore visit' : 'Archive visit'}
				</Button>
			</form>
		</Card>
	</div>
</div>

<style>
	.columns {
		display: grid;
		grid-template-columns: 1fr;
		gap: var(--sp-4);
		align-items: start;
	}
	@media (min-width: 60rem) {
		.columns {
			grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr);
		}
	}
	.column {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
		min-width: 0;
	}
	.edit {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}
	.grid {
		display: grid;
		gap: var(--sp-3);
		grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
	}
	.add-links {
		display: flex;
		flex-direction: column;
		gap: var(--sp-2);
		margin-top: var(--sp-4);
		padding-top: var(--sp-4);
		border-top: 1px solid var(--c-border);
	}
	.add-link {
		display: flex;
		gap: var(--sp-2);
		align-items: flex-end;
		flex-wrap: wrap;
	}
	.add-link .grow {
		flex: 1;
		min-width: 9rem;
	}
	.added-ok {
		color: var(--c-ok);
		font-size: var(--fs-xs);
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-2);
		margin: 0 0 var(--sp-3);
		padding: 0;
		list-style: none;
	}
	.chips li {
		display: inline-flex;
		gap: var(--sp-1);
		align-items: center;
		padding: 0.1rem 0.3rem 0.1rem var(--sp-3);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-pill);
		background: var(--c-surface-alt);
		font-size: var(--fs-xs);
	}
	.chips button {
		width: 1.4rem;
		height: 1.4rem;
		padding: 0;
		border: 0;
		border-radius: 50%;
		background: transparent;
		color: var(--c-text-muted);
		font-size: 1rem;
		line-height: 1;
		cursor: pointer;
	}
	.chips button:hover {
		background: var(--c-surface);
		color: var(--c-crit);
	}
	.add-symptom {
		display: flex;
		gap: var(--sp-3);
		align-items: flex-end;
	}
	.add-symptom .grow {
		flex: 1;
		min-width: 0;
	}
	.muted {
		margin: 0 0 var(--sp-3);
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}
	.muted.small {
		margin-top: var(--sp-3);
		margin-bottom: 0;
		font-size: var(--fs-xs);
	}
	.muted a {
		color: inherit;
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
	.notice.ok {
		color: var(--c-ok);
		border: 1px solid color-mix(in srgb, var(--c-ok) 25%, transparent);
		background: color-mix(in srgb, var(--c-ok) 8%, transparent);
	}
</style>
