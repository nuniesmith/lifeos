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
		PageHeader
	} from '$lib/components';

	let { data, form } = $props();
</script>

<svelte:head><title>Wishlist · LifeOS</title></svelte:head>

<PageHeader title="Wishlist" description="Ideas kept for when they are needed.">
	{#snippet meta()}<span>{data.wanted.length} on the list</span>{/snippet}
</PageHeader>

{#if form?.error}<p class="notice error" role="alert">{form.error}</p>{/if}

<div class="stack">
	<Card>
		<form method="POST" action="?/add" class="add" use:enhance>
			<div class="grow"><Input label="Idea" name="name" placeholder="What is it?" required /></div>
			<div><Input label="Occasion" name="occasion" placeholder="Birthday" /></div>
			<label class="who">
				<span class="label">For</span>
				<select name="forPersonId">
					<option value="">Nobody in particular</option>
					{#each data.people as person (person.id)}
						<option value={person.id}>{person.name}</option>
					{/each}
				</select>
			</label>
			<Button type="submit">Add</Button>
		</form>
	</Card>

	<Card flush>
		{#if data.wanted.length === 0}
			<EmptyState
				title="Nothing on the wishlist"
				description="Ideas kept here can be attached to a person and an occasion."
				icon="goals"
			/>
		{:else}
			<List label="Wishlist">
				{#each data.wanted as item (item.id)}
					<ListRow
						title={item.name}
						href={`/wishlist/${item.id}`}
						meta={[item.itemType, item.priceRange, item.occasion].filter(Boolean).join(' · ')}
					>
						{#snippet trail()}
							{#if item.forPersonName}<Badge tone="accent">For {item.forPersonName}</Badge>{/if}
						{/snippet}
					</ListRow>
				{/each}
			</List>
		{/if}
	</Card>

	{#if data.settled.length > 0}
		<section aria-labelledby="settled-heading">
			<h2 id="settled-heading" class="section-title">Bought or given</h2>
			<Card flush>
				<List label="Settled">
					{#each data.settled as item (item.id)}
						<ListRow
							title={item.name}
							href={`/wishlist/${item.id}`}
							meta={item.forPersonName ?? undefined}
							muted
						/>
					{/each}
				</List>
			</Card>
		</section>
	{/if}
</div>

<style>
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}
	.section-title {
		margin: 0 0 var(--sp-3);
		font-size: var(--fs-lg);
		font-weight: 650;
	}
	.add {
		display: flex;
		gap: var(--sp-3);
		align-items: flex-end;
		flex-wrap: wrap;
	}
	.add .grow {
		flex: 1;
		min-width: 12rem;
	}
	.who {
		display: grid;
		gap: 0.3rem;
	}
	.label {
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}
	select {
		min-height: var(--tap);
		padding: 0 var(--sp-2);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-sm);
		background: var(--c-surface);
		color: var(--c-text);
		font: inherit;
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
