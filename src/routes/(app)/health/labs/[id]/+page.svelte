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
		Textarea
	} from '$lib/components';
	import type { RangeStatus } from '$lib/server/repositories';
	import LabChart from './LabChart.svelte';

	let { data, form } = $props();

	const archived = $derived(data.marker.archivedAt !== null);

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

	// Newest first for the table -- the chart wants the opposite, chronological,
	// order, so it takes `data.results` (already ascending) directly.
	const tableResults = $derived([...data.results].reverse());
</script>

<svelte:head><title>{data.marker.name} · LifeOS</title></svelte:head>

<PageHeader title={data.marker.name} back={{ href: '/health/labs', label: 'Lab markers' }}>
	{#snippet meta()}
		{#if data.marker.units}<span>{data.marker.units}</span>{/if}
		{#if archived}<Badge tone="neutral">Archived</Badge>{/if}
	{/snippet}
</PageHeader>

{#if form?.error}
	<p class="notice error" role="alert">{form.error}</p>
{:else if form?.saved}
	<p class="notice ok" role="status">Saved.</p>
{/if}

<div class="columns">
	<div class="column">
		<section aria-labelledby="chart-heading">
			<h2 id="chart-heading" class="section-title">Over time</h2>
			<Card>
				<LabChart
					results={data.results}
					referenceLow={data.marker.referenceLow}
					referenceHigh={data.marker.referenceHigh}
					units={data.marker.units}
				/>
			</Card>
		</section>

		<Card title="Results" subtitle="Newest first; out-of-range results are flagged" flush>
			{#if tableResults.length === 0}
				<EmptyState title="No results yet" description="Add the first one below." icon="check" />
			{:else}
				<List label="Results for this marker">
					{#each tableResults as result (result.id)}
						<ListRow
							title={`${result.value}${data.marker.units ? ` ${data.marker.units}` : ''}`}
							meta={result.resultDate}
						>
							{#snippet trail()}
								<Badge tone={STATUS_TONE[result.status]}>{STATUS_LABEL[result.status]}</Badge>
								<form method="POST" action="?/removeResult" use:enhance>
									<input type="hidden" name="id" value={result.id} />
									<Button
										type="submit"
										size="sm"
										variant="ghost"
										aria-label={`Remove the ${result.resultDate} result`}
									>
										Remove
									</Button>
								</form>
							{/snippet}
							{#if result.notes}<p class="result-notes">{result.notes}</p>{/if}
						</ListRow>
					{/each}
				</List>
			{/if}
		</Card>

		<Card title="Add a result">
			<form method="POST" action="?/addResult" class="edit" use:enhance>
				<div class="grid">
					<Input label="Date" name="resultDate" type="date" required />
					<Input label="Value" name="value" type="number" step="any" required />
				</div>
				<Textarea label="Notes" name="notes" rows={2} />
				<div>
					<Button type="submit" variant="primary">Add result</Button>
				</div>
			</form>
		</Card>
	</div>

	<div class="column">
		<Card title="Marker details">
			<form method="POST" action="?/saveMarker" class="edit" use:enhance>
				<input type="hidden" name="updatedAt" value={data.marker.updatedAt.toISOString()} />
				<Input label="Name" name="name" value={data.marker.name} required />
				<Input label="Units" name="units" value={data.marker.units ?? ''} />
				<div class="grid">
					<Input
						label="Reference low"
						name="referenceLow"
						type="number"
						step="any"
						value={data.marker.referenceLow?.toString() ?? ''}
					/>
					<Input
						label="Reference high"
						name="referenceHigh"
						type="number"
						step="any"
						value={data.marker.referenceHigh?.toString() ?? ''}
					/>
				</div>
				<Textarea label="Notes" name="notes" rows={3} value={data.marker.notes ?? ''} />
				<div>
					<Button type="submit" variant="primary">Save</Button>
				</div>
			</form>
		</Card>

		<Card title={archived ? 'Restore' : 'Archive'}>
			<p class="muted">
				{archived
					? 'This marker is archived and hidden from the list. Restoring brings it back.'
					: 'Archiving hides this marker without deleting it. Its results are untouched.'}
			</p>
			<form method="POST" action="?/archiveMarker" use:enhance>
				<input type="hidden" name="updatedAt" value={data.marker.updatedAt.toISOString()} />
				<input type="hidden" name="archived" value={archived ? 'false' : 'true'} />
				<Button type="submit" variant={archived ? 'primary' : 'ghost'}>
					{archived ? 'Restore marker' : 'Archive marker'}
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
	.section-title {
		margin: 0 0 var(--sp-3);
		font-size: var(--fs-lg);
		font-weight: 650;
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
	.result-notes {
		margin: 0.2rem 0 0;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}
	.muted {
		margin: 0 0 var(--sp-3);
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
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
