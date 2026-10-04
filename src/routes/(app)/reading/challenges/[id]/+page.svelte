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
		Select,
		Sheet,
		Textarea
	} from '$lib/components';
	import { CATEGORY_LABELS, FORMAT_LABELS } from '../../books/form';
	import { KIND_LABELS, KIND_OPTIONS, progressLabel, progressPercent } from '../form';

	let { data, form } = $props();

	const archived = $derived(data.challenge.archivedAt !== null);
	const categoryOptions = Object.entries(CATEGORY_LABELS).map(([value, label]) => ({
		value,
		label
	}));
	const formatOptions = Object.entries(FORMAT_LABELS).map(([value, label]) => ({ value, label }));

	let editOpen = $state(false);
	// A writable $derived, not a $state+$effect pair: it tracks
	// `data.challenge.kind` until the user picks a different one in the
	// Select below, which overrides it locally (so the count-only fields can
	// show or hide before the form is ever saved) without fighting the next
	// reload once `data` actually changes.
	let kindValue = $derived(data.challenge.kind);

	type Item = (typeof data.items)[number];
	const canMoveUp = (index: number) => index > 0;
	const canMoveDown = (index: number) => index < data.items.length - 1;
	let editingItemId = $state<string | null>(null);

	/*
	 * Redrawn fresh from the reloaded `data` after a successful save rather
	 * than reset, the same reason books/[id] and routines/[id] both bump a
	 * key: this form holds a <Select> (kind, and conditionally
	 * category/format/genre), and a plain reset would put it back on
	 * whatever the page was first served with (hard rule 6).
	 */
	let saveFormKey = $state(0);
	let addItemFormKey = $state(0);

	const errorFor = (action: string): string | undefined =>
		form?.action === action ? form.error : undefined;
</script>

<svelte:head><title>{data.challenge.title} · Reading Tracker · LifeOS</title></svelte:head>

<PageHeader
	title={data.challenge.title}
	description="{data.challenge.year} · {KIND_LABELS[data.challenge.kind]}"
	back={{ href: '/reading/challenges', label: 'Challenges' }}
>
	{#snippet meta()}
		{#if archived}<Badge tone="neutral">Archived</Badge>{/if}
		{#if data.canEdit}
			<Button size="sm" variant="ghost" onclick={() => (editOpen = true)}>Edit</Button>
		{/if}
	{/snippet}
</PageHeader>

<div class="stack">
	<Card title="Progress">
		<p class="progress-label">{progressLabel(data.challenge.kind, data.challenge.progress)}</p>
		<div
			class="track"
			role="progressbar"
			aria-valuenow={progressPercent(data.challenge.progress)}
			aria-valuemin={0}
			aria-valuemax={100}
		>
			<span class="fill" style:width="{progressPercent(data.challenge.progress)}%"></span>
		</div>
	</Card>

	{#if data.notesHtml}
		<Card title="Notes">
			<!-- Safe for the same reason /reading/books/[id]'s notes are:
			     renderMarkdown's own sanitized output. -->
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			<div class="prose">{@html data.notesHtml}</div>
		</Card>
	{/if}

	{#if data.challenge.kind === 'count'}
		<Card title="Books that count" flush>
			{#if data.countBooks.length === 0}
				<EmptyState title="Nothing finished yet" icon="journal" />
			{:else}
				<List label="Books that count">
					{#each data.countBooks as book (book.id)}
						<ListRow title={book.title} meta={book.finishedOn ?? undefined} />
					{/each}
				</List>
			{/if}
		</Card>
	{:else}
		<Card title="Prompts" flush>
			{#if data.items.length === 0}
				<EmptyState
					title="No prompts yet"
					description={data.canEdit ? 'Open Edit to add the first one.' : undefined}
					icon="journal"
				/>
			{:else}
				<List label="Prompts">
					{#each data.items as item (item.id)}
						<ListRow title={item.prompt}>
							{#if item.bookId}
								<div class="filled-row">
									<span class="filled-book">{item.bookTitle}</span>
									{#if item.completedOn}<span class="filled-date">{item.completedOn}</span>{/if}
									<form method="POST" action="?/clearItem" use:enhance>
										<input type="hidden" name="itemId" value={item.id} />
										<Button type="submit" size="sm" variant="ghost">Clear</Button>
									</form>
								</div>
							{:else if data.canEdit}
								<form method="POST" action="?/fillItem" class="fill-row" use:enhance>
									<input type="hidden" name="itemId" value={item.id} />
									<Select
										label="Fill with"
										name="bookId"
										options={data.fillOptions}
										placeholder="Choose a book"
										labelHidden
									/>
									<Button type="submit" size="sm" variant="secondary">Fill</Button>
								</form>
							{/if}
						</ListRow>
					{/each}
				</List>
			{/if}
		</Card>
	{/if}
</div>

<Sheet bind:open={editOpen} title="Edit challenge">
	<div class="edit-stack">
		{#if errorFor('save')}<p class="notice error" role="alert">{errorFor('save')}</p>{/if}
		{#key saveFormKey}
			<form
				method="POST"
				action="?/save"
				class="edit-form"
				use:enhance={() => {
					return async ({ result, update }) => {
						await update({ reset: false });
						if (result.type === 'success') saveFormKey += 1;
					};
				}}
			>
				<input type="hidden" name="updatedAt" value={data.challenge.updatedAt} />
				<Input label="Title" name="title" value={data.challenge.title} required maxlength={200} />
				<div class="row">
					<Input
						label="Year"
						name="year"
						type="number"
						value={data.challenge.year.toString()}
						min="1900"
						max="2200"
						required
					/>
					<Select label="Kind" name="kind" options={KIND_OPTIONS} bind:value={kindValue} />
				</div>
				{#if kindValue === 'count'}
					<div class="row">
						<Input
							label="Target"
							name="targetCount"
							type="number"
							min="1"
							value={data.challenge.targetCount?.toString() ?? ''}
							required
						/>
						<Select
							label="Category"
							name="category"
							options={categoryOptions}
							placeholder="Any category"
							value={data.challenge.category ?? ''}
						/>
					</div>
					<div class="row">
						<Select
							label="Format"
							name="format"
							options={formatOptions}
							placeholder="Any format"
							value={data.challenge.format ?? ''}
						/>
						<Select
							label="Genre"
							name="genreId"
							options={data.genreOptions}
							placeholder="Any genre"
							value={data.challenge.genreId ?? ''}
						/>
					</div>
				{/if}
				<Textarea
					label="Notes"
					name="notes"
					rows={3}
					value={data.challenge.notes ?? ''}
					hint="Markdown works."
				/>
				<Button type="submit" variant="primary" full>Save challenge</Button>
			</form>
		{/key}

		{#if data.challenge.kind === 'prompts'}
			<section class="manage-items" aria-labelledby="items-heading">
				<h3 id="items-heading">Prompts</h3>

				{#if errorFor('addItem') || errorFor('saveItem') || errorFor('moveItem') || errorFor('archiveItem')}
					<p class="notice error" role="alert">
						{errorFor('addItem') ??
							errorFor('saveItem') ??
							errorFor('moveItem') ??
							errorFor('archiveItem')}
					</p>
				{/if}

				{#if data.items.length === 0}
					<p class="muted">No prompts yet. Add the first one below.</p>
				{:else}
					<ul class="item-manage-list">
						{#each data.items as item, index (item.id)}
							<li>
								{#if editingItemId === item.id}
									{@render itemEditForm(item)}
								{:else}
									{@render itemSummary(item, index)}
								{/if}
							</li>
						{/each}
					</ul>
				{/if}

				{#key addItemFormKey}
					<form
						method="POST"
						action="?/addItem"
						class="edit-form add-item"
						use:enhance={() => {
							return async ({ result, update }) => {
								await update();
								if (result.type === 'success') addItemFormKey += 1;
							};
						}}
					>
						<Input label="New prompt" name="prompt" required maxlength={500} />
						<Button type="submit" variant="secondary" full>Add prompt</Button>
					</form>
				{/key}
			</section>
		{/if}

		<section class="archive-challenge">
			{#if errorFor('archive')}<p class="notice error" role="alert">{errorFor('archive')}</p>{/if}
			<form method="POST" action="?/archive" use:enhance>
				<input type="hidden" name="archived" value={archived ? 'false' : 'true'} />
				<Button type="submit" variant={archived ? 'primary' : 'danger'} full>
					{archived ? 'Restore challenge' : 'Archive challenge'}
				</Button>
			</form>
		</section>
	</div>
</Sheet>

{#snippet itemSummary(item: Item, index: number)}
	<div class="item-summary">
		<span class="item-prompt">{index + 1}. {item.prompt}</span>
		<div class="item-buttons">
			<form method="POST" action="?/moveItem" use:enhance>
				<input type="hidden" name="itemId" value={item.id} />
				<input type="hidden" name="direction" value="up" />
				<Button
					type="submit"
					size="sm"
					variant="ghost"
					disabled={!canMoveUp(index)}
					aria-label={`Move prompt ${index + 1} up`}
				>
					Up
				</Button>
			</form>
			<form method="POST" action="?/moveItem" use:enhance>
				<input type="hidden" name="itemId" value={item.id} />
				<input type="hidden" name="direction" value="down" />
				<Button
					type="submit"
					size="sm"
					variant="ghost"
					disabled={!canMoveDown(index)}
					aria-label={`Move prompt ${index + 1} down`}
				>
					Down
				</Button>
			</form>
			<Button size="sm" variant="ghost" onclick={() => (editingItemId = item.id)}>Edit</Button>
			<form method="POST" action="?/archiveItem" use:enhance>
				<input type="hidden" name="itemId" value={item.id} />
				<Button type="submit" size="sm" variant="ghost" aria-label={`Archive prompt ${index + 1}`}>
					Archive
				</Button>
			</form>
		</div>
	</div>
{/snippet}

{#snippet itemEditForm(item: Item)}
	<form
		method="POST"
		action="?/saveItem"
		class="edit-form"
		use:enhance={() => {
			return async ({ result, update }) => {
				await update();
				if (result.type === 'success') editingItemId = null;
			};
		}}
	>
		<input type="hidden" name="itemId" value={item.id} />
		<Input label="Prompt" name="prompt" value={item.prompt} required maxlength={500} />
		<div class="row-actions">
			<Button type="button" variant="ghost" onclick={() => (editingItemId = null)}>Cancel</Button>
			<Button type="submit" variant="primary">Save</Button>
		</div>
	</form>
{/snippet}

<style>
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}
	.progress-label {
		margin: 0 0 var(--sp-2);
		font-weight: 650;
	}
	.track {
		height: 8px;
		border-radius: var(--radius-pill);
		background: var(--c-surface-alt);
		border: 1px solid var(--c-border);
		overflow: hidden;
	}
	.fill {
		display: block;
		height: 100%;
		background: var(--c-accent);
	}
	.filled-row,
	.fill-row {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		margin-top: var(--sp-1);
	}
	.fill-row {
		align-items: flex-end;
	}
	.filled-book {
		font-weight: 600;
	}
	.filled-date {
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}

	.prose {
		max-width: var(--measure);
		overflow-wrap: anywhere;
		line-height: 1.6;
	}
	.prose > :global(:first-child) {
		margin-top: 0;
	}
	.prose > :global(:last-child) {
		margin-bottom: 0;
	}

	.edit-stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-5);
	}
	.edit-form {
		display: flex;
		flex-direction: column;
		gap: var(--sp-3);
	}
	.row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 9rem), 1fr));
		gap: var(--sp-3);
	}

	.manage-items h3 {
		margin: 0 0 var(--sp-2);
		font-size: var(--fs-base);
	}
	.item-manage-list {
		display: flex;
		flex-direction: column;
		gap: var(--sp-2);
		list-style: none;
		margin: 0 0 var(--sp-3);
		padding: 0;
	}
	.item-manage-list li {
		border: 1px solid var(--c-border);
		border-radius: var(--radius-sm);
		padding: var(--sp-2) var(--sp-3);
	}
	.item-summary {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--sp-2);
	}
	.item-prompt {
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.item-buttons {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-1);
	}
	.item-buttons form {
		display: contents;
	}
	.add-item {
		margin-top: var(--sp-2);
	}

	.row-actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--sp-2);
	}

	.muted {
		margin: 0 0 var(--sp-3);
		color: var(--c-text-muted);
	}

	.archive-challenge {
		border-top: 1px solid var(--c-border);
		padding-top: var(--sp-4);
	}

	.notice {
		padding: var(--sp-2) var(--sp-3);
		border-radius: var(--radius-sm);
		margin-bottom: var(--sp-4);
		font-size: var(--fs-sm);
	}
	.notice.error {
		color: var(--c-crit);
		border: 1px solid color-mix(in srgb, var(--c-crit) 25%, transparent);
		background: color-mix(in srgb, var(--c-crit) 8%, transparent);
	}
</style>
