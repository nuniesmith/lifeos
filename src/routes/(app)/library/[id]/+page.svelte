<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
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
		Textarea
	} from '$lib/components';

	let { data, form } = $props();

	const TYPE_LABELS: Record<string, string> = {
		book: 'Book',
		note: 'Note',
		reference: 'Reference'
	};
	const STATUS_LABELS: Record<string, string> = {
		inbox: 'New',
		reading_list: 'Reading list',
		live: 'Kept',
		archived_read: 'Finished'
	};

	const statusOptions = $derived(
		data.statuses.map((s) => ({ value: s, label: STATUS_LABELS[s] ?? s }))
	);
	const typeOptions = $derived(
		data.entryTypes.map((t) => ({ value: t, label: TYPE_LABELS[t] ?? t }))
	);

	const seen = $derived(
		data.item.lastInteractionAt
			? data.item.lastInteractionAt.toLocaleDateString(undefined, {
					day: 'numeric',
					month: 'long',
					year: 'numeric'
				})
			: null
	);
	const archived = $derived(data.item.archivedAt !== null);

	/** Which form last answered, and what it said — one paragraph per action
	 *  rather than a single ambiguous banner shared by five different forms. */
	const errorFor = (action: string): string | undefined =>
		form?.action === action ? form.error : undefined;

	/*
	 * Bumped after a successful topic/link change to redraw that mini-form
	 * fresh from the reloaded `data`. Each of these forms stays on screen and
	 * holds a <Select> whose options shrink as things are attached — a plain
	 * form.reset() (the default after use:enhance's update()) puts a select
	 * back on whichever option the page was first SERVED with, not on the
	 * server's current list, which is exactly the bug documented on
	 * `addFormKey` in health/measurements/+page.svelte.
	 */
	let topicFormKey = $state(0);
	let linkFormKey = $state(0);
	let saveFormKey = $state(0);
</script>

<svelte:head><title>{data.item.title} · LifeOS</title></svelte:head>

<PageHeader
	title={data.item.title}
	description={data.item.fullTitle && data.item.fullTitle !== data.item.title
		? data.item.fullTitle
		: undefined}
	back={{ href: '/library', label: 'Library' }}
>
	{#snippet meta()}
		{#if archived}<Badge tone="neutral">Archived</Badge>{/if}
		<span>
			{TYPE_LABELS[data.item.entryType]}
			{data.item.author ? ` · ${data.item.author}` : ''}
			{data.item.highlightCount > 0
				? ` · ${data.item.highlightCount} highlight${data.item.highlightCount === 1 ? '' : 's'}`
				: ''}
			{seen ? ` · last opened ${seen}` : ' · never opened'}
		</span>
	{/snippet}
	{#snippet actions()}
		<form method="POST" action="?/touch" use:enhance>
			<Button type="submit" size="sm" variant="ghost">Mark revisited</Button>
		</form>
	{/snippet}
</PageHeader>

{#if errorFor('touch')}
	<p class="notice error" role="alert">{errorFor('touch')}</p>
{:else if form?.action === 'touch' && form.touched}
	<p class="notice ok" role="status">Marked as revisited.</p>
{:else if form?.action === 'archive' && form.restored}
	<p class="notice ok" role="status">Restored. It is back in the library.</p>
{/if}

<div class="stack">
	{#if data.item.url}
		<Card>
			<p class="source">
				<!-- The household's own link, not an application route: resolve()
				     would rewrite it. -->
				<!-- eslint-disable svelte/no-navigation-without-resolve -->
				<a href={data.item.url} target="_blank" rel="noopener noreferrer">
					{data.item.url}
				</a>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
			</p>
		</Card>
	{/if}

	<Card title="Topics">
		{#if data.tags.length > 0}
			<ul class="tags">
				{#each data.tags as tag (tag.id)}
					<li class="tag">
						<a href={resolve('/topics')}>{tag.name}</a>
						{#if data.canEdit}
							<form method="POST" action="?/detachTopic" use:enhance>
								<input type="hidden" name="tagId" value={tag.id} />
								<button
									type="submit"
									class="remove"
									aria-label={`Remove topic ${tag.name} from ${data.item.title}`}
								>
									×
								</button>
							</form>
						{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<p class="muted">No topics on this yet.</p>
		{/if}

		{#if data.canEdit}
			{#if errorFor('attachTopic')}
				<p class="notice error" role="alert">{errorFor('attachTopic')}</p>
			{/if}
			{#if data.availableTags.length > 0}
				{#key topicFormKey}
					<form
						method="POST"
						action="?/attachTopic"
						class="topic-form"
						use:enhance={() => {
							return async ({ result, update }) => {
								await update({ reset: false });
								if (result.type === 'success') topicFormKey += 1;
							};
						}}
					>
						<div class="grow">
							<Select
								label="Add a topic"
								name="tagId"
								options={data.availableTags.map((t) => ({ value: t.id, label: t.name }))}
								placeholder="Choose a topic"
								required
							/>
						</div>
						<Button type="submit">Add</Button>
					</form>
				{/key}
			{/if}

			{#if errorFor('createTopic')}
				<p class="notice error" role="alert">{errorFor('createTopic')}</p>
			{/if}
			<form method="POST" action="?/createTopic" class="topic-form" use:enhance>
				<div class="grow">
					<Input label="New topic" name="name" placeholder="Name a new topic" maxlength={100} />
				</div>
				<Button type="submit">Create</Button>
			</form>
		{/if}
	</Card>

	<Card title="Notes">
		{#if data.notesHtml}
			<!--
				Safe for the same reason as the recipe method's {@html}:
				`data.notesHtml` is built on the server by renderMarkdown
				($lib/server/markdown), which runs DOMPurify over an explicit tag
				and attribute allowlist and keeps only http(s)/mailto/tel links
				and images served from /api/media. The entry's own notes never
				reach this tag; only that output does.
			-->
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			<div class="prose">{@html data.notesHtml}</div>
		{:else}
			<EmptyState
				title="No notes yet"
				description={data.canEdit
					? 'Add notes below. Markdown works: headings, lists, links.'
					: undefined}
				icon="journal"
			/>
		{/if}
	</Card>

	{#if data.canEdit}
		{#key saveFormKey}
			<Card>
				<form
					method="POST"
					action="?/save"
					class="edit"
					use:enhance={() => {
						return async ({ result, update }) => {
							// Not reset: these fields should show what was just saved,
							// not the values the page first loaded with.
							await update({ reset: false });
							if (result.type === 'success') saveFormKey += 1;
						};
					}}
				>
					<!-- `.toISOString()`: the precondition compares to the millisecond,
					     which a Date rendered directly loses. -->
					<input type="hidden" name="updatedAt" value={data.item.updatedAt.toISOString()} />

					<Input label="Title" name="title" value={data.item.title} required maxlength={500} />
					<Input label="Author" name="author" value={data.item.author ?? ''} />

					<div class="row">
						<Select label="Status" name="status" value={data.item.status} options={statusOptions} />
						<Select
							label="Type"
							name="entryType"
							value={data.item.entryType}
							options={typeOptions}
						/>
					</div>

					<Input
						label="Format"
						name="format"
						value={data.item.format ?? ''}
						placeholder="Article, podcast, video…"
					/>
					<Input
						label="Link"
						name="url"
						type="url"
						inputmode="url"
						placeholder="https://"
						value={data.item.url ?? ''}
					/>

					<Textarea label="Summary" name="summary" value={data.item.summary ?? ''} rows={3} />
					<Textarea
						label="Notes"
						name="notes"
						value={data.item.notes ?? ''}
						rows={8}
						hint="Markdown: headings, lists, links. Rendered above once saved."
					/>

					<label class="fav">
						<input type="checkbox" name="isFavourite" checked={data.item.isFavourite} />
						<span>Favourite</span>
					</label>

					{#if errorFor('save')}
						<p class="notice error" role="alert">{errorFor('save')}</p>
					{:else if form?.action === 'save' && form.saved}
						<p class="notice ok" role="status">Saved.</p>
					{/if}

					<div class="save"><Button type="submit">Save</Button></div>
				</form>
			</Card>
		{/key}
	{:else}
		<Card>
			<p class="muted">
				This entry belongs to someone else in the household, so only they can change it.
			</p>
		</Card>
	{/if}

	<Card title="Linked entries" flush>
		{#if errorFor('addLink')}
			<p class="notice error linked-error" role="alert">{errorFor('addLink')}</p>
		{/if}
		{#if data.links.length === 0}
			<EmptyState
				title="Nothing linked yet"
				description={data.canEdit ? 'Link this to another entry below.' : undefined}
				icon="journal"
			/>
		{:else}
			<List label="Linked entries">
				{#each data.links as link (link.itemId)}
					<ListRow
						title={link.title}
						href="/library/{link.itemId}"
						muted={link.archived}
						meta={link.archived ? 'Archived' : (TYPE_LABELS[link.entryType] ?? link.entryType)}
					>
						{#snippet trail()}
							{#if data.canEdit}
								<form method="POST" action="?/removeLink" use:enhance>
									<input type="hidden" name="linkedItemId" value={link.itemId} />
									<Button
										type="submit"
										size="sm"
										variant="ghost"
										aria-label={`Remove the link to ${link.title}`}
									>
										Remove
									</Button>
								</form>
							{/if}
						{/snippet}
					</ListRow>
				{/each}
			</List>
		{/if}

		{#if data.canEdit && data.linkCandidates.length > 0}
			{#key linkFormKey}
				<form
					method="POST"
					action="?/addLink"
					class="link-form"
					use:enhance={() => {
						return async ({ result, update }) => {
							await update({ reset: false });
							if (result.type === 'success') linkFormKey += 1;
						};
					}}
				>
					<Select
						label="Link to another entry"
						name="linkedItemId"
						options={data.linkCandidates.map((c) => ({ value: c.id, label: c.title }))}
						placeholder="Choose an entry"
						required
					/>
					<Button type="submit">Link</Button>
				</form>
			{/key}
		{/if}
	</Card>

	{#if data.canEdit}
		<Card title={archived ? 'Restore' : 'Archive'}>
			<p class="muted">
				{archived
					? 'This entry is archived: it is off the library and out of search. Restoring brings it back.'
					: 'Archiving takes this entry off the library without deleting it. It waits in the Archive.'}
			</p>
			<form method="POST" action="?/archive" use:enhance>
				<input type="hidden" name="archived" value={archived ? 'false' : 'true'} />
				<Button type="submit" variant={archived ? 'primary' : 'secondary'}>
					{archived ? 'Restore entry' : 'Archive entry'}
				</Button>
			</form>
		</Card>
	{/if}
</div>

<style>
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}
	.source {
		margin: 0;
		font-size: var(--fs-sm);
		overflow-wrap: anywhere;
	}
	.source a {
		color: var(--c-accent);
	}

	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-2);
		margin: 0 0 var(--sp-4);
		padding: 0;
		list-style: none;
	}
	/* Shaped like the Tag component's pill. It cannot be that component here:
	   removal has to be a form submit so the card works without JavaScript,
	   and Tag's own remove control is a click handler. */
	.tag {
		display: inline-flex;
		align-items: center;
		max-width: 100%;
		border: 1px solid var(--c-border);
		border-radius: var(--radius-pill);
		background: var(--c-surface-alt);
		font-size: var(--fs-xs);
		line-height: 1.6;
	}
	.tag a {
		display: block;
		padding: 0.1rem var(--sp-2) 0.1rem var(--sp-3);
		overflow: hidden;
		color: var(--c-text-muted);
		text-decoration: none;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tag a:hover {
		color: var(--c-accent);
		text-decoration: underline;
	}
	.remove {
		display: inline-flex;
		align-items: center;
		min-height: 0;
		padding: var(--sp-1) var(--sp-2) var(--sp-1) var(--sp-1);
		border: 0;
		background: none;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
		line-height: 1;
		cursor: pointer;
	}
	.remove:hover {
		color: var(--c-crit);
	}

	.topic-form {
		display: flex;
		gap: var(--sp-3);
		align-items: flex-end;
		margin-top: var(--sp-3);
	}
	.topic-form + .topic-form {
		margin-top: var(--sp-2);
	}
	.grow {
		flex: 1;
		min-width: 0;
	}

	.link-form {
		display: flex;
		gap: var(--sp-3);
		align-items: flex-end;
		padding: var(--sp-3);
		border-top: 1px solid var(--c-border);
	}
	.link-form :global(> :first-child) {
		flex: 1;
		min-width: 0;
	}
	.linked-error {
		margin: var(--sp-3) var(--sp-3) 0;
	}

	.edit {
		display: grid;
		gap: var(--sp-4);
	}
	.row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr));
		gap: var(--sp-4);
	}
	.fav {
		display: flex;
		gap: var(--sp-2);
		align-items: center;
		font-size: var(--fs-sm);
	}
	.save {
		display: flex;
		justify-content: flex-end;
	}

	.muted {
		margin: 0;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
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
	.notice.ok {
		color: var(--c-ok);
		border: 1px solid color-mix(in srgb, var(--c-ok) 25%, transparent);
		background: color-mix(in srgb, var(--c-ok) 8%, transparent);
	}

	/* ── The rendered notes. Its markup comes from {@html}, which Svelte's
	   scoping cannot see, so every rule reaches into it with :global. Copied
	   from /food/recipes/[id], the first page to render a Markdown body. ── */
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
	.prose :global(h3),
	.prose :global(h4),
	.prose :global(h5),
	.prose :global(h6) {
		margin: var(--sp-6) 0 var(--sp-2);
		font-size: var(--fs-base);
		font-weight: 650;
	}
	.prose :global(h3) {
		font-size: var(--fs-lg);
	}
	.prose :global(p),
	.prose :global(ul),
	.prose :global(ol),
	.prose :global(blockquote),
	.prose :global(pre),
	.prose :global(.md-table) {
		margin: 0 0 var(--sp-4);
	}
	.prose :global(ul),
	.prose :global(ol) {
		padding-left: 1.4rem;
	}
	.prose :global(li) {
		margin: var(--sp-1) 0;
	}
	.prose :global(li > p) {
		margin: 0;
	}
	.prose :global(li:has(> input[type='checkbox'])) {
		list-style: none;
		margin-left: -1.4rem;
	}
	.prose :global(input[type='checkbox']) {
		width: 1rem;
		height: 1rem;
		min-height: 0;
		margin: 0 var(--sp-2) 0 0;
		vertical-align: -0.15em;
	}
	.prose :global(blockquote) {
		padding: var(--sp-2) var(--sp-3);
		border-left: 3px solid var(--c-accent);
		border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
		background: var(--c-surface-alt);
		color: var(--c-text-muted);
	}
	.prose :global(blockquote > :last-child) {
		margin-bottom: 0;
	}
	.prose :global(code) {
		padding: 0.05rem 0.3rem;
		border-radius: 4px;
		background: var(--c-surface-alt);
		font-family: var(--font-mono);
		font-size: 0.9em;
	}
	.prose :global(pre) {
		padding: var(--sp-3);
		border-radius: var(--radius-sm);
		background: var(--c-surface-alt);
		overflow-x: auto;
	}
	.prose :global(pre code) {
		padding: 0;
		background: none;
	}
	.prose :global(hr) {
		margin: var(--sp-6) 0;
		border: 0;
		border-top: 1px solid var(--c-border);
	}
	.prose :global(img) {
		display: block;
		max-width: 100%;
		height: auto;
		margin: var(--sp-2) 0;
		border-radius: var(--radius-sm);
	}
	.prose :global(.md-table) {
		max-width: 100%;
		overflow-x: auto;
		border: 1px solid var(--c-border);
		border-radius: var(--radius-sm);
		background:
			linear-gradient(to right, var(--c-surface) 40%, transparent) left / 2rem 100% no-repeat local,
			linear-gradient(to left, var(--c-surface) 40%, transparent) right / 2rem 100% no-repeat local,
			radial-gradient(
					farthest-side at 0 50%,
					color-mix(in srgb, var(--c-text) 30%, transparent),
					transparent
				)
				left / 0.9rem 100% no-repeat scroll,
			radial-gradient(
					farthest-side at 100% 50%,
					color-mix(in srgb, var(--c-text) 30%, transparent),
					transparent
				)
				right / 0.9rem 100% no-repeat scroll;
	}
	.prose :global(table) {
		min-width: 100%;
		font-size: var(--fs-sm);
		overflow-wrap: normal;
	}
	.prose :global(th),
	.prose :global(td) {
		min-width: 8.5rem;
		padding: var(--sp-2) var(--sp-3);
		border-bottom: 1px solid var(--c-border);
		text-align: left;
		vertical-align: top;
	}
	.prose :global(th) {
		background: var(--c-surface-alt);
		font-weight: 650;
	}
	.prose :global(tr:last-child td) {
		border-bottom: 0;
	}
	@media (min-width: 40rem) {
		.prose :global(th),
		.prose :global(td) {
			min-width: 5rem;
		}
	}
	.prose :global([align='right']) {
		text-align: right;
	}
	.prose :global([align='center']) {
		text-align: center;
	}
</style>
