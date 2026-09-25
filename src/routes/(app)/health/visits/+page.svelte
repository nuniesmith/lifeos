<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button, Card, EmptyState, Input, List, ListRow, PageHeader } from '$lib/components';

	let { data, form } = $props();

	// A real instant, rendered in whichever zone the browser itself is in --
	// unlike a bare calendar day elsewhere in the app, "when is my
	// appointment" is a question about a moment, and the viewer's own clock
	// is the right one to answer it in.
	const when = (at: Date): string =>
		`${at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}, ${at.toLocaleTimeString(
			undefined,
			{ hour: 'numeric', minute: '2-digit' }
		)}`;
</script>

<svelte:head><title>Medical visits · LifeOS</title></svelte:head>

<PageHeader
	title="Medical visits"
	description="Appointments, upcoming and past."
	back={{ href: '/health', label: 'Health' }}
/>

{#if form?.error}
	<p class="notice error" role="alert">{form.error}</p>
{/if}

<div class="stack">
	<section aria-labelledby="upcoming-heading">
		<h2 id="upcoming-heading" class="section-title">Upcoming</h2>
		<Card flush>
			{#if data.upcoming.length === 0}
				<EmptyState title="Nothing scheduled" icon="check" />
			{:else}
				<List label="Upcoming visits">
					{#each data.upcoming as visit (visit.id)}
						<ListRow
							title={visit.reason}
							meta={[when(visit.visitAt), visit.location].filter(Boolean).join(' · ')}
							href={`/health/visits/${visit.id}`}
						/>
					{/each}
				</List>
			{/if}
		</Card>
	</section>

	<section aria-labelledby="past-heading">
		<h2 id="past-heading" class="section-title">Past</h2>
		<Card flush>
			{#if data.past.length === 0}
				<EmptyState title="No past visits yet" icon="journal" />
			{:else}
				<List label="Past visits">
					{#each data.past as visit (visit.id)}
						<ListRow
							title={visit.reason}
							meta={[when(visit.visitAt), visit.location].filter(Boolean).join(' · ')}
							href={`/health/visits/${visit.id}`}
						/>
					{/each}
				</List>
			{/if}
		</Card>
	</section>

	<section aria-labelledby="add-visit-heading">
		<h2 id="add-visit-heading" class="section-title">Add a visit</h2>
		<Card>
			<form method="POST" action="?/addVisit" class="add" use:enhance>
				<Input label="Reason" name="reason" placeholder="What is it for?" required />
				<div class="grid">
					<Input label="Date" name="visitDate" type="date" required />
					<Input label="Time" name="visitTime" type="time" required />
				</div>
				<div class="grid">
					<Input label="Visit type" name="visitType" placeholder="Follow up" />
					<Input label="Provider" name="provider" />
					<Input label="Location" name="location" />
				</div>
				<div>
					<Button type="submit" variant="primary">Add visit</Button>
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
