<script lang="ts" module>
	/** What the sheet needs of a food; a plain object so a test or a parent
	 *  page can build one without importing the full server type. */
	export interface EditableFood {
		id: string;
		updatedAt: Date;
		name: string;
		brand: string | null;
		serving: string | null;
		kcalPerServing: number | null;
		proteinG: number | null;
		carbsG: number | null;
		fibreG: number | null;
		sugarG: number | null;
		totalFatG: number | null;
		sodiumMg: number | null;
		notes: string | null;
		isFavourite: boolean;
		archivedAt: Date | null;
	}
</script>

<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button, Checkbox, Input, Sheet, Textarea } from '$lib/components';

	interface Props {
		open?: boolean;
		/** Null adds a new food; otherwise edits this one. */
		food: EditableFood | null;
	}

	let { open = $bindable(false), food }: Props = $props();

	// Every field is local, controlled state rather than a `value=` prop taken
	// from `food` — this sheet is reused for every row without remounting
	// between them, the same reasoning IngredientSheet.svelte gives for its
	// own fields. Reset when the sheet opens, from whichever food it was
	// opened for, or blank for a new one.
	let name = $state('');
	let brand = $state('');
	let serving = $state('');
	let kcalPerServing = $state('');
	let proteinG = $state('');
	let carbsG = $state('');
	let fibreG = $state('');
	let sugarG = $state('');
	let totalFatG = $state('');
	let sodiumMg = $state('');
	let notes = $state('');
	let isFavourite = $state(false);
	let error = $state<string | undefined>();

	$effect(() => {
		if (!open) return;
		const f = food;
		name = f?.name ?? '';
		brand = f?.brand ?? '';
		serving = f?.serving ?? '';
		kcalPerServing = f?.kcalPerServing?.toString() ?? '';
		proteinG = f?.proteinG?.toString() ?? '';
		carbsG = f?.carbsG?.toString() ?? '';
		fibreG = f?.fibreG?.toString() ?? '';
		sugarG = f?.sugarG?.toString() ?? '';
		totalFatG = f?.totalFatG?.toString() ?? '';
		sodiumMg = f?.sodiumMg?.toString() ?? '';
		notes = f?.notes ?? '';
		isFavourite = f?.isFavourite ?? false;
		error = undefined;
	});

	const archived = $derived(food?.archivedAt != null);
	const title = $derived(food ? `Edit ${food.name}` : 'Add a food');
</script>

<Sheet bind:open {title}>
	<form
		method="POST"
		action={food ? '?/update' : '?/create'}
		use:enhance={() => {
			error = undefined;
			return async ({ result, update }) => {
				// Never a plain reset: it would forget everything just typed the
				// moment the page revalidates, the same reasoning
				// IngredientSheet.svelte gives for its own submit.
				await update({ reset: false });
				if (result.type === 'success') open = false;
				else if (result.type === 'failure') {
					const said = result.data?.error;
					error = typeof said === 'string' ? said : 'Could not save that food.';
				}
			};
		}}
	>
		{#if food}
			<input type="hidden" name="id" value={food.id} />
			<input type="hidden" name="expectedUpdatedAt" value={food.updatedAt.toISOString()} />
		{/if}

		{#if error}<p class="notice error" role="alert">{error}</p>{/if}

		<Input label="Name" name="name" bind:value={name} required maxlength={200} />

		<div class="grid">
			<Input label="Brand" name="brand" bind:value={brand} />
			<Input
				label="Serving"
				name="serving"
				bind:value={serving}
				placeholder="1 cup, 100 g…"
				hint="As the label states it."
			/>
		</div>

		<fieldset class="nutrients">
			<legend>Per serving</legend>
			<div class="grid">
				<Input
					label="Calories"
					name="kcalPerServing"
					type="number"
					inputmode="decimal"
					step="0.1"
					min="0"
					bind:value={kcalPerServing}
					hint="kcal"
				/>
				<Input
					label="Protein"
					name="proteinG"
					type="number"
					inputmode="decimal"
					step="0.1"
					min="0"
					bind:value={proteinG}
					hint="g"
				/>
				<Input
					label="Carbs"
					name="carbsG"
					type="number"
					inputmode="decimal"
					step="0.1"
					min="0"
					bind:value={carbsG}
					hint="g"
				/>
				<Input
					label="Fibre"
					name="fibreG"
					type="number"
					inputmode="decimal"
					step="0.1"
					min="0"
					bind:value={fibreG}
					hint="g"
				/>
				<Input
					label="Sugar"
					name="sugarG"
					type="number"
					inputmode="decimal"
					step="0.1"
					min="0"
					bind:value={sugarG}
					hint="g"
				/>
				<Input
					label="Fat"
					name="totalFatG"
					type="number"
					inputmode="decimal"
					step="0.1"
					min="0"
					bind:value={totalFatG}
					hint="g"
				/>
				<Input
					label="Sodium"
					name="sodiumMg"
					type="number"
					inputmode="decimal"
					step="0.1"
					min="0"
					bind:value={sodiumMg}
					hint="mg"
				/>
			</div>
		</fieldset>

		<Checkbox label="Favourite — shown first in the library" bind:checked={isFavourite} />
		<input type="hidden" name="isFavourite" value={isFavourite ? 'on' : ''} />

		<Textarea label="Notes" name="notes" rows={3} bind:value={notes} />

		<div class="actions">
			<Button variant="ghost" type="button" onclick={() => (open = false)}>Cancel</Button>
			<Button type="submit" variant="primary">{food ? 'Save food' : 'Add food'}</Button>
		</div>
	</form>

	{#if food}
		<form
			method="POST"
			action="?/archive"
			class="archive-form"
			use:enhance={() => {
				return async ({ result, update }) => {
					await update({ reset: false });
					if (result.type === 'success') open = false;
				};
			}}
		>
			<input type="hidden" name="id" value={food.id} />
			<input type="hidden" name="archived" value={archived ? 'false' : 'true'} />
			<p class="muted">
				{archived
					? 'Archived: off the library and out of the quick-add picker. Restoring brings it back.'
					: 'Archiving takes this off the library without deleting it or the entries already logged with it.'}
			</p>
			<Button type="submit" variant={archived ? 'primary' : 'danger'} full>
				{archived ? 'Restore food' : 'Archive food'}
			</Button>
		</form>
	{/if}
</Sheet>

<style>
	form {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 9rem), 1fr));
		gap: var(--sp-3);
	}

	.nutrients {
		margin: 0;
		padding: 0;
		border: none;
		min-width: 0;
	}

	.nutrients legend {
		margin-bottom: var(--sp-2);
		padding: 0;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
		font-weight: 600;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--sp-2);
	}

	.archive-form {
		margin-top: var(--sp-5);
		padding-top: var(--sp-4);
		border-top: 1px solid var(--c-border);
	}

	.muted {
		margin: 0 0 var(--sp-3);
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}

	.notice {
		margin: 0;
		padding: var(--sp-2) var(--sp-3);
		border-radius: var(--radius-sm);
		font-size: var(--fs-sm);
	}
	.notice.error {
		color: var(--c-crit);
		border: 1px solid color-mix(in srgb, var(--c-crit) 25%, transparent);
		background: color-mix(in srgb, var(--c-crit) 8%, transparent);
	}
</style>
