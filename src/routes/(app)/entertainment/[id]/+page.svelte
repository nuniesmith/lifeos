<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import {
		Badge,
		Button,
		Card,
		EmptyState,
		Input,
		PageHeader,
		Select,
		Textarea
	} from '$lib/components';
	import { appPath } from '$lib/components/nav';

	let { data, form } = $props();

	const item = $derived(data.item);
	const archived = $derived(item.archivedAt !== null);

	const TYPE_LABELS: Record<string, string> = { movie: 'Movie', tv: 'TV show', other: 'Other' };
	const STATUS_LABELS: Record<string, string> = {
		want_to_watch: 'Want to watch',
		watching: 'Watching',
		watched: 'Watched',
		paused: 'Paused',
		dropped: 'Dropped'
	};
	const RATING_OPTIONS = [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n} / 5` }));

	const typeOptions = $derived(
		data.mediaTypes.map((t) => ({ value: t, label: TYPE_LABELS[t] ?? t }))
	);
	const statusOptions = $derived(
		data.statuses.map((s) => ({ value: s, label: STATUS_LABELS[s] ?? s }))
	);

	const errorFor = (action: string) => (form?.action === action ? form.error : undefined);

	// Named apart from the <PageHeader> `meta` snippet below: a script binding
	// and a template snippet of the same name collide, and this one must also
	// stay reactive to the item, which a plain `const` computed once would not.
	const factsLine = $derived(
		[
			TYPE_LABELS[item.mediaType] ?? item.mediaType,
			item.genre,
			item.streamingService,
			item.releaseYear ? String(item.releaseYear) : null
		]
			.filter(Boolean)
			.join(' · ')
	);

	/** "S2E5", or nothing at all when neither is known. */
	const progress = $derived(
		item.currentSeason
			? `S${item.currentSeason}${item.currentEpisode ? `E${item.currentEpisode}` : ''}`
			: null
	);

	const longDay = (value: string) =>
		new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, {
			day: 'numeric',
			month: 'long',
			year: 'numeric',
			timeZone: 'UTC'
		});
</script>

<svelte:head><title>{item.name} · LifeOS</title></svelte:head>

<PageHeader title={item.name} back={{ href: '/entertainment', label: 'Entertainment' }}>
	{#snippet meta()}
		{#if archived}<Badge tone="neutral">Archived</Badge>{/if}
		<Badge tone="accent">{STATUS_LABELS[item.status] ?? item.status}</Badge>
		{#if factsLine}<span>{factsLine}</span>{/if}
		{#if progress}<span>{progress}</span>{/if}
		{#if item.timesWatched > 0}<span>watched {item.timesWatched}×</span>{/if}
	{/snippet}
	{#snippet actions()}
		{#if data.canEdit && !archived}
			{#if item.status === 'want_to_watch'}
				<form method="POST" action="?/setStatus" use:enhance>
					<input type="hidden" name="status" value="watching" />
					<Button type="submit" icon="check">Start watching</Button>
				</form>
			{:else if item.status === 'watching'}
				<form method="POST" action="?/setStatus" use:enhance>
					<input type="hidden" name="status" value="watched" />
					<Button type="submit" icon="check">Finished</Button>
				</form>
			{/if}
		{/if}
	{/snippet}
</PageHeader>

{#if form?.error && form.action !== 'save' && form.action !== 'logViewing'}
	<p class="notice error" role="alert">{form.error}</p>
{:else if form?.action === 'archive' && !form.error}
	<p class="notice ok" role="status">
		{form.archived ? 'Archived. It is off Entertainment and waiting in the Archive.' : 'Restored.'}
	</p>
{/if}

<div class="stack">
	{#if data.cover}
		<img
			class="cover"
			src={resolve(appPath(`/api/media/${data.cover.id}`))}
			alt=""
			width={data.cover.width ?? undefined}
			height={data.cover.height ?? undefined}
			decoding="async"
		/>
	{/if}

	{#if data.canEdit}
		<Card title="Title details">
			<form
				method="POST"
				action="?/save"
				class="edit"
				use:enhance={() =>
					async ({ update }) =>
						// Not reset: the fields and Selects should show what was just
						// saved, and a reset would put the Selects back on the option
						// the page was first served with (rule: forms that stay on
						// screen with a Select must not reset after update()).
						update({ reset: false })}
			>
				<input type="hidden" name="updatedAt" value={item.updatedAt.toISOString()} />

				<Input label="Name" name="name" value={item.name} required maxlength={300} />

				<div class="grid">
					<Select label="Type" name="mediaType" options={typeOptions} value={item.mediaType} />
					<Select label="Status" name="status" options={statusOptions} value={item.status} />
				</div>

				<div class="grid">
					<Input
						label="Streaming service"
						name="streamingService"
						value={item.streamingService ?? ''}
						placeholder="Netflix, Crave…"
					/>
					<Input label="Genre" name="genre" value={item.genre ?? ''} />
				</div>

				<div class="grid">
					<Input
						label="Release year"
						name="releaseYear"
						type="number"
						inputmode="numeric"
						min="1850"
						max="2200"
						value={item.releaseYear?.toString() ?? ''}
					/>
					<Input
						label="Total seasons"
						name="totalSeasons"
						type="number"
						inputmode="numeric"
						min="0"
						value={item.totalSeasons?.toString() ?? ''}
					/>
				</div>

				<div class="grid">
					<Input
						label="Current season"
						name="currentSeason"
						type="number"
						inputmode="numeric"
						min="0"
						value={item.currentSeason?.toString() ?? ''}
					/>
					<Input
						label="Current episode"
						name="currentEpisode"
						type="number"
						inputmode="numeric"
						min="0"
						value={item.currentEpisode?.toString() ?? ''}
					/>
				</div>

				<div class="grid">
					<Input label="Started on" name="startedOn" type="date" value={item.startedOn ?? ''} />
					<Input label="Finished on" name="finishedOn" type="date" value={item.finishedOn ?? ''} />
				</div>

				<Select
					label="Rating"
					name="rating"
					options={RATING_OPTIONS}
					placeholder="Not rated"
					value={item.rating ? String(item.rating) : ''}
				/>

				<Textarea
					label="Why saved"
					name="whySaved"
					rows={3}
					value={item.whySaved ?? ''}
					hint="Optional: why this ended up on the list."
				/>

				<label class="check">
					<input type="checkbox" name="isFavourite" checked={item.isFavourite} />
					<span>Favourite</span>
				</label>
				<label class="check">
					<input type="checkbox" name="watchAgain" checked={item.watchAgain} />
					<span>Watch again</span>
				</label>

				{#if errorFor('save')}
					<p class="notice error" role="alert">{errorFor('save')}</p>
				{:else if form?.action === 'save' && form.saved}
					<p class="notice ok" role="status">Saved.</p>
				{/if}

				<div class="row-end">
					<Button type="submit" variant="primary">Save title</Button>
				</div>
			</form>
		</Card>
	{/if}

	{#if data.canEdit && !archived}
		<Card title="Log a viewing">
			<!--
				Plain use:enhance, no {#key} bump: this form has no <Select>, so
				the reset-puts-a-Select-back-on-its-first-option trap does not
				apply, and the default reset is exactly what is wanted here --
				it clears the note and puts the date and progress back to
				today/current, ready for the next entry to be logged.
			-->
			<form method="POST" action="?/logViewing" class="edit" use:enhance>
				<div class="grid">
					<Input label="Date watched" name="watchedOn" type="date" required value={data.today} />
				</div>
				<div class="grid">
					<Input
						label="Season"
						name="season"
						type="number"
						inputmode="numeric"
						min="0"
						value={item.currentSeason?.toString() ?? ''}
					/>
					<Input
						label="Episode"
						name="episode"
						type="number"
						inputmode="numeric"
						min="0"
						value={item.currentEpisode?.toString() ?? ''}
					/>
				</div>
				<Textarea label="Note" name="note" rows={2} hint="Optional." />

				{#if errorFor('logViewing')}
					<p class="notice error" role="alert">{errorFor('logViewing')}</p>
				{:else if form?.action === 'logViewing' && form.logged}
					<p class="notice ok" role="status">Logged.</p>
				{/if}

				<div class="row-end">
					<Button type="submit" variant="primary">Log a viewing</Button>
				</div>
			</form>
		</Card>
	{/if}

	<Card title="Viewing history" flush>
		{#if data.viewings.length === 0}
			<EmptyState
				title="No viewings logged yet"
				description={data.canEdit ? 'Log one above once you have watched it.' : undefined}
				icon="today"
			/>
		{:else}
			<ul class="viewings">
				{#each data.viewings as viewing (viewing.id)}
					<li>
						<div class="viewing-row">
							<span class="date">{longDay(viewing.watchedOn)}</span>
							{#if viewing.season}
								<span class="ep"
									>S{viewing.season}{viewing.episode ? `E${viewing.episode}` : ''}</span
								>
							{/if}
							<span class="who">{viewing.loggedByMe ? 'You' : 'Your household'}</span>
						</div>
						{#if viewing.note}<p class="note">{viewing.note}</p>{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</Card>

	{#if data.canEdit}
		<Card title={archived ? 'Restore' : 'Archive'}>
			<p class="muted">
				{archived
					? 'This title is archived: it is off Entertainment and out of search. Restoring brings it back.'
					: 'Archiving takes this title off Entertainment without deleting it. It waits in the Archive.'}
			</p>
			<form method="POST" action="?/archive" use:enhance>
				<input type="hidden" name="archived" value={archived ? 'false' : 'true'} />
				<Button type="submit" variant={archived ? 'primary' : 'secondary'}>
					{archived ? 'Restore title' : 'Archive title'}
				</Button>
			</form>
		</Card>
	{:else}
		<p class="muted">
			This title belongs to someone else in the household, so only they can change it.
		</p>
	{/if}
</div>

<style>
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}

	.cover {
		display: block;
		width: 100%;
		height: auto;
		max-height: 16rem;
		object-fit: cover;
		border-radius: var(--radius);
		border: 1px solid var(--c-border);
	}

	.edit {
		display: grid;
		gap: var(--sp-4);
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 9rem), 1fr));
		gap: var(--sp-3);
	}
	.row-end {
		display: flex;
		justify-content: flex-end;
	}

	.check {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		min-height: var(--tap);
	}
	.check input {
		width: 20px;
		height: 20px;
		min-height: 0;
		accent-color: var(--c-accent);
	}

	.viewings {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.viewings li {
		padding: var(--sp-3) var(--sp-4);
	}
	.viewings li + li {
		border-top: 1px solid var(--c-border);
	}
	.viewing-row {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--sp-1) var(--sp-3);
	}
	.date {
		font-weight: 550;
	}
	.ep,
	.who {
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}
	.who {
		margin-left: auto;
	}
	.note {
		margin: var(--sp-1) 0 0;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
		overflow-wrap: anywhere;
	}

	.muted {
		margin: 0 0 var(--sp-3);
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}

	.notice {
		padding: var(--sp-2) var(--sp-3);
		border-radius: var(--radius-sm);
		margin: 0 0 var(--sp-4);
		font-size: var(--fs-sm);
	}
	.edit .notice {
		margin: 0;
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
