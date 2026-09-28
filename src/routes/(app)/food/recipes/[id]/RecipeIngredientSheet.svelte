<script lang="ts" module>
	export interface PickableIngredient {
		id: string;
		name: string;
		aisle: string | null;
		status: string;
	}
</script>

<script lang="ts">
	import { tick } from 'svelte';
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { Input, Sheet } from '$lib/components';

	interface Props {
		open?: boolean;
		/** Already excludes whatever is attached to this recipe (server-side). */
		ingredients: readonly PickableIngredient[];
	}

	let { open = $bindable(false), ingredients }: Props = $props();

	let mode = $state<'existing' | 'new'>('existing');
	let query = $state('');
	let newName = $state('');
	let newAisle = $state('');
	let error = $state<string | undefined>();
	let busy = $state(false);
	let errorEl = $state<HTMLElement>();

	// A fresh sheet every time it opens: yesterday's search or half-typed new
	// ingredient is not about today's. Mirrors PlanMealSheet's own reset.
	$effect(() => {
		if (open) {
			mode = ingredients.length > 0 ? 'existing' : 'new';
			query = '';
			newName = '';
			newAisle = '';
			error = undefined;
		}
	});

	const shown = $derived.by(() => {
		const needle = query.trim().toLowerCase();
		return needle ? ingredients.filter((i) => i.name.toLowerCase().includes(needle)) : ingredients;
	});

	const submit: SubmitFunction = () => {
		busy = true;
		error = undefined;
		return async ({ result, update }) => {
			busy = false;
			if (result.type === 'failure') {
				const said = result.data?.error;
				error = typeof said === 'string' ? said : 'Could not add that ingredient.';
				await tick();
				errorEl?.scrollIntoView({ block: 'nearest' });
				return;
			}
			if (result.type === 'success') open = false;
			// No reset: nothing here is a native form control bound to state in a
			// way a reset would desync, but the sheet closes on success anyway.
			await update({ reset: false });
		};
	};
</script>

<Sheet bind:open title="Add an ingredient">
	<div class="tabs" role="tablist" aria-label="Add an ingredient">
		<button
			type="button"
			role="tab"
			aria-selected={mode === 'existing'}
			class:chosen={mode === 'existing'}
			onclick={() => (mode = 'existing')}
		>
			Pick existing
		</button>
		<button
			type="button"
			role="tab"
			aria-selected={mode === 'new'}
			class:chosen={mode === 'new'}
			onclick={() => (mode = 'new')}
		>
			Add new
		</button>
	</div>

	{#if error}<p class="error" role="alert" bind:this={errorEl}>{error}</p>{/if}

	{#if mode === 'existing'}
		<form method="POST" action="?/setAmount" use:enhance={submit} class="picker">
			<Input
				type="search"
				label="Find an ingredient"
				bind:value={query}
				autocomplete="off"
				enterkeyhint="search"
			/>
			{#if ingredients.length === 0}
				<p class="none">Every ingredient is already on this recipe. Add a new one instead.</p>
			{:else if shown.length === 0}
				<p class="none">No ingredient matches “{query.trim()}”.</p>
			{:else}
				<ul class="results" aria-label="Ingredients">
					{#each shown as item (item.id)}
						<li>
							<button
								type="submit"
								name="ingredientId"
								value={item.id}
								class="pick"
								disabled={busy}
							>
								<span class="name">{item.name}</span>
								{#if item.aisle}<span class="meta">{item.aisle}</span>{/if}
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</form>
	{:else}
		<form method="POST" action="?/attachNew" use:enhance={submit} class="new-ingredient">
			<Input label="Name" name="name" bind:value={newName} required maxlength={200} />
			<Input label="Aisle" name="aisle" bind:value={newAisle} placeholder="Produce, Dairy…" />
			<button type="submit" class="pick primary" disabled={busy || newName.trim() === ''}>
				Add and attach
			</button>
		</form>
	{/if}
</Sheet>

<style>
	.tabs {
		display: flex;
		gap: var(--sp-2);
		margin-bottom: var(--sp-4);
	}
	.tabs button {
		flex: 1;
		min-height: var(--tap);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-sm);
		background: var(--c-surface);
		font-size: var(--fs-sm);
		font-weight: 600;
		cursor: pointer;
	}
	.tabs button.chosen {
		border-color: var(--c-accent);
		background: var(--c-accent-soft);
		color: var(--c-accent);
	}

	.picker,
	.new-ingredient {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}

	.results {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0;
		border: 1px solid var(--c-border);
		border-radius: var(--radius-sm);
		list-style: none;
	}
	.results li + li {
		border-top: 1px solid var(--c-border);
	}

	.pick {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		justify-content: center;
		gap: 0.1rem;
		width: 100%;
		min-height: var(--tap);
		padding: var(--sp-2) var(--sp-3);
		border: none;
		background: none;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.pick:hover:not(:disabled) {
		background: var(--c-surface-alt);
	}
	.pick:disabled {
		cursor: progress;
		opacity: 0.6;
	}
	.pick.primary {
		align-items: center;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		background: var(--c-accent);
		color: var(--c-accent-text);
		font-weight: 600;
	}
	.pick.primary:disabled {
		cursor: not-allowed;
	}

	.name {
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.meta {
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
	}

	.none {
		margin: 0;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}

	.error {
		margin: 0 0 var(--sp-3);
		padding: var(--sp-2) var(--sp-3);
		border: 1px solid color-mix(in srgb, var(--c-crit) 25%, transparent);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--c-crit) 8%, transparent);
		color: var(--c-crit);
	}
</style>
