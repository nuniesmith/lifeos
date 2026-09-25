<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button, Card, EmptyState, Input, List, ListRow, PageHeader } from '$lib/components';

	let { data, form } = $props();

	/** "10–50", "≤50", "≥10", or nothing when neither bound is set. */
	function rangeLabel(low: number | null, high: number | null): string | null {
		if (low !== null && high !== null) return `${low}–${high}`;
		if (high !== null) return `≤${high}`;
		if (low !== null) return `≥${low}`;
		return null;
	}
</script>

<svelte:head><title>Lab markers · LifeOS</title></svelte:head>

<PageHeader
	title="Lab markers"
	description="What gets tested, and the range each result is read against."
	back={{ href: '/health', label: 'Health' }}
/>

{#if form?.error}
	<p class="notice error" role="alert">{form.error}</p>
{/if}

<div class="stack">
	<section aria-labelledby="markers-heading">
		<h2 id="markers-heading" class="section-title">Markers</h2>
		<Card flush>
			{#if data.markers.length === 0}
				<EmptyState
					title="No markers yet"
					description="Add the first one below -- a blood pressure cuff or a lab slip usually names it."
					icon="journal"
				/>
			{:else}
				<List label="Lab markers">
					{#each data.markers as marker (marker.id)}
						{@const range = rangeLabel(marker.referenceLow, marker.referenceHigh)}
						<ListRow
							title={marker.name}
							meta={[
								range ? `range ${range}${marker.units ? ` ${marker.units}` : ''}` : null,
								`${marker.resultCount} result${marker.resultCount === 1 ? '' : 's'}`
							]
								.filter(Boolean)
								.join(' · ')}
							href={`/health/labs/${marker.id}`}
						/>
					{/each}
				</List>
			{/if}
		</Card>
	</section>

	<section aria-labelledby="add-marker-heading">
		<h2 id="add-marker-heading" class="section-title">Add a marker</h2>
		<Card>
			<form method="POST" action="?/addMarker" class="add" use:enhance>
				<Input label="Name" name="name" placeholder="What does the lab slip call it?" required />
				<div class="grid">
					<Input label="Units" name="units" placeholder="mg/L" />
					<Input label="Reference low" name="referenceLow" type="number" step="any" />
					<Input label="Reference high" name="referenceHigh" type="number" step="any" />
				</div>
				<div>
					<Button type="submit" variant="primary">Add marker</Button>
				</div>
			</form>
		</Card>
	</section>
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
	.add {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}
	/* Auto-fit rather than a media query: the form sits in whatever column the
	   page layout gives it, not the viewport directly. */
	.grid {
		display: grid;
		gap: var(--sp-3);
		grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
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
