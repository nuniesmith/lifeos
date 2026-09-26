<script lang="ts" module>
	export type Slot = 'breakfast' | 'lunch' | 'dinner' | 'snack';

	export interface PickableRecipe {
		id: string;
		name: string;
		courses: string[];
		totalMinutes: number | null;
	}
</script>

<script lang="ts">
	import { tick } from 'svelte';
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { Input, Sheet } from '$lib/components';

	interface Props {
		open?: boolean;
		/** The day being planned, as YYYY-MM-DD. */
		date: string | null;
		/** What that day already has, so a repeat pick can say so. */
		planned: readonly { slot: Slot; recipeId: string }[];
		recipes: readonly PickableRecipe[];
	}

	let { open = $bindable(false), date, planned, recipes }: Props = $props();

	const SLOTS: { value: Slot; label: string }[] = [
		{ value: 'breakfast', label: 'Breakfast' },
		{ value: 'lunch', label: 'Lunch' },
		{ value: 'dinner', label: 'Dinner' },
		{ value: 'snack', label: 'Snack' }
	];

	// Dinner is the meal most often planned. The choice then carries over from
	// one day to the next, because a week is usually planned a meal at a time:
	// every dinner, then every lunch.
	let slot = $state<Slot>('dinner');
	let query = $state('');
	let error = $state<string | undefined>();
	let busy = $state(false);
	let formEl = $state<HTMLFormElement>();
	let errorEl = $state<HTMLElement>();

	const title = $derived(
		date
			? `Plan ${new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
					weekday: 'long',
					day: 'numeric',
					month: 'long',
					timeZone: 'UTC'
				})}`
			: 'Plan a meal'
	);

	/** A recipe filed under the chosen meal — "Snacks" counts for a snack. */
	const suits = (recipe: PickableRecipe, meal: Slot) =>
		recipe.courses.some((course) => course.trim().toLowerCase().startsWith(meal));

	/**
	 * The recipes to offer: those matching the search, with the ones filed
	 * under the chosen meal first, so the likely pick is at the top of a
	 * phone screen rather than somewhere down an alphabetical list.
	 */
	const shown = $derived.by(() => {
		const needle = query.trim().toLowerCase();
		const matching = recipes.filter((r) => !needle || r.name.toLowerCase().includes(needle));
		return [...matching.filter((r) => suits(r, slot)), ...matching.filter((r) => !suits(r, slot))];
	});

	const isPlanned = (recipeId: string) =>
		planned.some((meal) => meal.slot === slot && meal.recipeId === recipeId);

	const metaFor = (recipe: PickableRecipe) =>
		[
			recipe.courses.join(', ') || null,
			recipe.totalMinutes !== null ? `${recipe.totalMinutes} min` : null
		]
			.filter(Boolean)
			.join(' · ');

	// A fresh sheet for each day: yesterday's search or refusal is not about
	// today. The slot is kept on purpose (see above).
	$effect(() => {
		if (open) {
			query = '';
			error = undefined;
		}
	});

	/**
	 * Enter in the search box would otherwise submit the form with its first
	 * button — planning whichever recipe happens to be at the top. Only when
	 * the search has narrowed to exactly one recipe is that what was meant.
	 */
	function onSearchKey(event: KeyboardEvent) {
		if (event.key !== 'Enter') return;
		event.preventDefault();
		if (shown.length !== 1 || !formEl) return;
		const only = formEl.querySelector<HTMLButtonElement>('button[name="recipeId"]');
		if (only) formEl.requestSubmit(only);
	}

	const submit: SubmitFunction = () => {
		busy = true;
		error = undefined;
		return async ({ result, update }) => {
			busy = false;
			if (result.type === 'failure') {
				// Shown here, in the sheet the person is looking at, rather than
				// at the top of a page the sheet is covering.
				const said = result.data?.error;
				error = typeof said === 'string' ? said : 'Could not plan that recipe.';
				// The recipe tapped may be far down the list, with the message
				// scrolled out of sight above it.
				await tick();
				errorEl?.scrollIntoView({ block: 'nearest' });
				return;
			}
			if (result.type === 'success') open = false;
			// No reset: the slot radios are bound to state, and a native reset
			// would move the checked mark without telling it.
			await update({ reset: false });
		};
	};
</script>

<Sheet bind:open {title}>
	<form method="POST" action="?/plan" use:enhance={submit} bind:this={formEl}>
		<input type="hidden" name="date" value={date ?? ''} />

		<fieldset class="slots">
			<legend>Meal</legend>
			<div class="slot-options">
				{#each SLOTS as option (option.value)}
					<!-- The native radio stays visible: the chosen meal is marked by
					     its dot and its weight as well as by colour. -->
					<label class="slot" class:chosen={slot === option.value}>
						<input type="radio" name="slot" value={option.value} bind:group={slot} />
						<span>{option.label}</span>
					</label>
				{/each}
			</div>
		</fieldset>

		<Input
			type="search"
			label="Find a recipe"
			bind:value={query}
			autocomplete="off"
			enterkeyhint="search"
			onkeydown={onSearchKey}
		/>

		{#if error}
			<p class="error" role="alert" bind:this={errorEl}>{error}</p>
		{/if}

		{#if recipes.length === 0}
			<p class="none">There are no recipes to plan yet.</p>
		{:else if shown.length === 0}
			<p class="none">No recipe matches “{query.trim()}”.</p>
		{:else}
			<!-- Each recipe is its own submit button: one tap plans it. -->
			<ul class="recipes" aria-label="Recipes">
				{#each shown as recipe (recipe.id)}
					{@const meta = metaFor(recipe)}
					<li>
						<button type="submit" name="recipeId" value={recipe.id} class="pick" disabled={busy}>
							<span class="name">{recipe.name}</span>
							{#if meta}<span class="meta">{meta}</span>{/if}
							{#if isPlanned(recipe.id)}
								<span class="planned">Already planned</span>
							{/if}
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</form>
</Sheet>

<style>
	form {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
		/* Holds its height while the search narrows the list, so the sheet's
		   top edge — and the box being typed in — does not drop with every
		   letter. */
		min-height: min(30rem, calc(85dvh - 6rem));
	}

	.slots {
		margin: 0;
		padding: 0;
		border: none;
		min-width: 0;
	}

	legend {
		margin-bottom: var(--sp-1);
		padding: 0;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
		font-weight: 600;
	}

	.slot-options {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--sp-2);
	}

	.slot {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		min-height: var(--tap);
		padding: 0 var(--sp-3);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-sm);
		background: var(--c-surface);
		font-size: var(--fs-sm);
		cursor: pointer;
	}

	.slot input {
		/* The label is the target; the control inside needs no height of its own. */
		min-height: 0;
		margin: 0;
		accent-color: var(--c-accent);
	}

	.slot.chosen {
		border-color: var(--c-accent);
		background: var(--c-accent-soft);
		font-weight: 650;
	}

	.slot:has(input:focus-visible) {
		outline: 2px solid var(--c-accent);
		outline-offset: 2px;
	}

	.recipes {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0;
		border: 1px solid var(--c-border);
		border-radius: var(--radius-sm);
		list-style: none;
	}

	.recipes li + li {
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

	.name {
		font-weight: 600;
		/* A long recipe name wraps; it never widens the sheet. */
		overflow-wrap: anywhere;
	}

	.meta,
	.planned {
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
	}

	.planned {
		font-weight: 600;
	}

	.none {
		margin: 0;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}

	.error {
		margin: 0;
		padding: var(--sp-2) var(--sp-3);
		border: 1px solid color-mix(in srgb, var(--c-crit) 25%, transparent);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--c-crit) 8%, transparent);
		color: var(--c-crit);
	}

	@media (min-width: 30rem) {
		.slot-options {
			grid-template-columns: repeat(4, minmax(0, 1fr));
		}
	}
</style>
