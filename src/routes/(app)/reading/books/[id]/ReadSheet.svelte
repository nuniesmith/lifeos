<script module lang="ts">
	import type { BookFormat } from '$lib/server/repositories';

	/** What the sheet needs of a read; a plain object so a parent page can
	 *  build one without importing the full server-side read type — the same
	 *  shape IngredientSheet.svelte's EditableIngredient follows. */
	export interface EditableRead {
		id: string;
		readerName: string;
		status: 'reading' | 'paused' | 'finished' | 'dnf';
		startedOn: string | null;
		finishedOn: string | null;
		format: BookFormat | null;
		rating: number | null;
		review: string | null;
		dnfReason: string | null;
		updatedAt: Date;
	}
</script>

<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button, Input, Select, Sheet, Textarea } from '$lib/components';
	import { FORMAT_LABELS, RATING_OPTIONS } from '../form';

	/**
	 * Edits or deletes one logged read (Reading Tracker R2). Opened only for
	 * the viewer's own reads — the page decides that before opening it — but
	 * the server actions this posts to (`?/editRead`, `?/deleteRead`) are the
	 * real authorization (hard rule 8): another reader's row is refused there
	 * regardless of what this component ever offers.
	 */
	interface Props {
		open?: boolean;
		read: EditableRead | null;
	}
	let { open = $bindable(false), read }: Props = $props();

	const formatOptions = Object.entries(FORMAT_LABELS).map(([value, label]) => ({ value, label }));

	// Controlled local state, reset from `read` whenever the sheet opens —
	// the same reason IngredientSheet.svelte's fields are: this one sheet is
	// reused for every row, and a plain `value=` prop cannot be trusted to
	// reach a <Select> once it has been touched.
	let startedOn = $state('');
	let finishedOn = $state('');
	let format = $state('');
	let rating = $state('');
	let review = $state('');
	let error = $state<string | undefined>();

	$effect(() => {
		if (!open) return;
		const r = read;
		startedOn = r?.startedOn ?? '';
		finishedOn = r?.finishedOn ?? '';
		format = r?.format ?? '';
		rating = r?.rating?.toString() ?? '';
		review = r?.review ?? '';
		error = undefined;
	});

	const title = $derived(read ? `${read.readerName}’s read` : 'Edit read');
</script>

<Sheet bind:open {title}>
	{#if read}
		<form
			method="POST"
			action="?/editRead"
			use:enhance={() => {
				error = undefined;
				return async ({ result, update }) => {
					// Never a plain reset (hard rule 6): this form holds two
					// <Select>s, and a reset would put each back on whatever this
					// sheet's very first render used.
					await update({ reset: false });
					if (result.type === 'success') open = false;
					else if (result.type === 'failure') {
						const said = result.data?.error;
						error = typeof said === 'string' ? said : 'Could not save that read.';
					}
				};
			}}
		>
			<input type="hidden" name="readId" value={read.id} />
			<input type="hidden" name="updatedAt" value={read.updatedAt.toISOString()} />

			{#if error}<p class="notice error" role="alert">{error}</p>{/if}

			<div class="grid">
				<Input label="Started" name="startedOn" type="date" bind:value={startedOn} />
				<Input label="Finished" name="finishedOn" type="date" bind:value={finishedOn} />
			</div>
			<div class="grid">
				<Select
					label="Format"
					name="format"
					options={formatOptions}
					placeholder="Not set"
					bind:value={format}
				/>
				<Select
					label="Rating"
					name="rating"
					options={RATING_OPTIONS}
					placeholder="Not rated"
					bind:value={rating}
				/>
			</div>
			<Textarea label="Review" name="review" rows={4} bind:value={review} hint="Markdown works." />

			{#if read.status === 'dnf' && read.dnfReason}
				<p class="muted">DNF reason: {read.dnfReason}</p>
			{/if}

			<div class="actions">
				<Button variant="ghost" type="button" onclick={() => (open = false)}>Cancel</Button>
				<Button type="submit" variant="primary">Save</Button>
			</div>
		</form>

		<form
			method="POST"
			action="?/deleteRead"
			class="delete-form"
			use:enhance={() => {
				return async ({ result, update }) => {
					await update({ reset: false });
					if (result.type === 'success') open = false;
				};
			}}
		>
			<input type="hidden" name="readId" value={read.id} />
			<p class="muted">
				Deleting removes this read outright — there is no archive to restore it from.
			</p>
			<Button type="submit" variant="danger" full>Delete this read</Button>
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

	.delete-form {
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
