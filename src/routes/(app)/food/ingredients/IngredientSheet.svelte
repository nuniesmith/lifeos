<script lang="ts" module>
	import type { IngredientStatus } from '$lib/server/repositories';

	/** What the sheet needs of an ingredient; a plain object so a test or a
	 *  parent page can build one without importing the full server type. */
	export interface EditableIngredient {
		id: string;
		updatedAt: Date;
		name: string;
		status: IngredientStatus;
		aisle: string | null;
		category: string | null;
		store: string | null;
		isStaple: boolean;
		quantity: string | null;
		quantityValue: number | null;
		quantityUnit: string | null;
		preferredBrand: string | null;
		notes: string | null;
		archivedAt: Date | null;
	}
</script>

<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button, Checkbox, Input, Select, Sheet, Textarea } from '$lib/components';
	import { FOOD_UNITS } from '$lib/food-units';

	interface Props {
		open?: boolean;
		/** Null adds a new ingredient; otherwise edits this one. */
		ingredient: EditableIngredient | null;
	}

	let { open = $bindable(false), ingredient }: Props = $props();

	const STATUS_OPTIONS: { value: IngredientStatus; label: string }[] = [
		{ value: 'in_stock', label: 'In stock' },
		{ value: 'shopping_list', label: 'On the shopping list' },
		{ value: 'use_up', label: 'Use up' },
		{ value: 'not_needed', label: "Don't need" }
	];
	const UNIT_OPTIONS = FOOD_UNITS.map((u) => ({ value: u, label: u }));

	// Every field is local, controlled state rather than a `value=` prop taken
	// from `ingredient` — a plain prop update cannot be trusted to reach a
	// <select> once the person has touched it (that is what the note on
	// `addFormKey` in the health measurements page is about), and this sheet
	// is reused for every row without remounting between them. Reset when the
	// sheet opens, from whichever ingredient it was opened for, or blank for
	// a new one.
	let name = $state('');
	let status = $state<IngredientStatus>('in_stock');
	let aisle = $state('');
	let category = $state('');
	let store = $state('');
	let isStaple = $state(false);
	let quantity = $state('');
	let quantityValue = $state('');
	let quantityUnit = $state('');
	let preferredBrand = $state('');
	let notes = $state('');
	let error = $state<string | undefined>();

	$effect(() => {
		if (!open) return;
		const i = ingredient;
		name = i?.name ?? '';
		status = i?.status ?? 'in_stock';
		aisle = i?.aisle ?? '';
		category = i?.category ?? '';
		store = i?.store ?? '';
		isStaple = i?.isStaple ?? false;
		quantity = i?.quantity ?? '';
		quantityValue = i?.quantityValue?.toString() ?? '';
		quantityUnit = i?.quantityUnit ?? '';
		preferredBrand = i?.preferredBrand ?? '';
		notes = i?.notes ?? '';
		error = undefined;
	});

	const archived = $derived(ingredient?.archivedAt != null);
	const title = $derived(ingredient ? `Edit ${ingredient.name}` : 'Add an ingredient');
</script>

<Sheet bind:open {title}>
	<form
		method="POST"
		action={ingredient ? '?/update' : '?/create'}
		use:enhance={() => {
			error = undefined;
			return async ({ result, update }) => {
				// Never a plain reset: it would put the status and unit selects
				// back on whatever option the sheet's very first render used,
				// not on what was just chosen.
				await update({ reset: false });
				if (result.type === 'success') open = false;
				else if (result.type === 'failure') {
					const said = result.data?.error;
					error = typeof said === 'string' ? said : 'Could not save that ingredient.';
				}
			};
		}}
	>
		{#if ingredient}
			<input type="hidden" name="id" value={ingredient.id} />
			<input type="hidden" name="expectedUpdatedAt" value={ingredient.updatedAt.toISOString()} />
		{/if}

		{#if error}<p class="notice error" role="alert">{error}</p>{/if}

		<Input label="Name" name="name" bind:value={name} required maxlength={200} />

		<div class="grid">
			<Select label="Status" name="status" options={STATUS_OPTIONS} bind:value={status} />
			<Input label="Aisle" name="aisle" bind:value={aisle} placeholder="Produce, Dairy…" />
			<Input label="Category" name="category" bind:value={category} />
			<Input label="Store" name="store" bind:value={store} />
		</div>

		<Checkbox label="Staple — re-bought without thinking about it" bind:checked={isStaple} />
		<input type="hidden" name="isStaple" value={isStaple ? 'on' : ''} />

		<Input
			label="Quantity"
			name="quantity"
			bind:value={quantity}
			hint="Free text, as you’d write it on a list — “2 dozen”, “1 bag”."
		/>
		<div class="grid">
			<Input
				label="Structured amount"
				name="quantityValue"
				type="number"
				inputmode="decimal"
				step="0.01"
				min="0"
				bind:value={quantityValue}
				hint="Optional. Shown instead of the text above when both are set."
			/>
			<Select
				label="Unit"
				name="quantityUnit"
				options={UNIT_OPTIONS}
				placeholder="No unit"
				bind:value={quantityUnit}
			/>
		</div>

		<Input label="Preferred brand" name="preferredBrand" bind:value={preferredBrand} />
		<Textarea label="Notes" name="notes" rows={3} bind:value={notes} />

		<div class="actions">
			<Button variant="ghost" type="button" onclick={() => (open = false)}>Cancel</Button>
			<Button type="submit" variant="primary">
				{ingredient ? 'Save ingredient' : 'Add ingredient'}
			</Button>
		</div>
	</form>

	{#if ingredient}
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
			<input type="hidden" name="id" value={ingredient.id} />
			<input type="hidden" name="archived" value={archived ? 'false' : 'true'} />
			<p class="muted">
				{archived
					? 'Archived: off the pantry and the shopping list. Restoring brings it back.'
					: 'Archiving takes this off the pantry and shopping list without deleting it.'}
			</p>
			<Button type="submit" variant={archived ? 'primary' : 'danger'} full>
				{archived ? 'Restore ingredient' : 'Archive ingredient'}
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
