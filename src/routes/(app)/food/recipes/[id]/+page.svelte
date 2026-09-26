<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { Badge, Button, Card, EmptyState, Input, PageHeader, Textarea } from '$lib/components';
	import { appPath } from '$lib/components/nav';

	let { data, form } = $props();

	const recipe = $derived(data.recipe);
	const archived = $derived(recipe.archivedAt !== null);

	/** A stored day as the household reads it, with no timezone in between. */
	const longDay = (value: string) =>
		new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, {
			day: 'numeric',
			month: 'long',
			year: 'numeric',
			timeZone: 'UTC'
		});

	const lastMade = $derived(
		recipe.lastMadeOn === null
			? 'Not made yet'
			: recipe.lastMadeOn === data.today
				? 'Made today'
				: `Last made ${longDay(recipe.lastMadeOn)}`
	);

	/** "1 h 15 min" reads faster than "75 min" once a recipe runs past the hour. */
	const duration = (total: number) => {
		const hours = Math.floor(total / 60);
		const minutes = total % 60;
		if (hours === 0) return `${minutes} min`;
		return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
	};

	/** A labelled value, kept only when the source recorded one. */
	interface Fact {
		label: string;
		value: string;
	}
	const known = (entries: [string, number | null, (n: number) => string][]): Fact[] =>
		entries.flatMap(([label, value, show]) =>
			value === null ? [] : [{ label, value: show(value) }]
		);

	const times = $derived(
		known([
			['Serves', recipe.servings, String],
			['Prep', recipe.prepMinutes, duration],
			['Cook', recipe.cookMinutes, duration],
			['Additional', recipe.additionalMinutes, duration],
			['Total', recipe.totalMinutes, duration]
		])
	);

	const nutrition = $derived(
		known([
			['Energy', recipe.kcalPerServing, (n) => `${n} kcal`],
			['Protein', recipe.proteinG, (n) => `${n} g`],
			['Carbs', recipe.carbsG, (n) => `${n} g`],
			['Fibre', recipe.fibreG, (n) => `${n} g`],
			['Sugar', recipe.sugarG, (n) => `${n} g`],
			['Fat', recipe.totalFatG, (n) => `${n} g`],
			['Sodium', recipe.sodiumMg, (n) => `${n} mg`]
		])
	);

	/** The source's multi-selects, each under its own name rather than one heap of chips. */
	const tags = $derived(
		(
			[
				['Course', recipe.courses],
				['Season', recipe.seasons],
				['Cuisine', recipe.cuisine ? [recipe.cuisine] : []],
				['Occasion', recipe.occasion ? [recipe.occasion] : []],
				['Effort', recipe.effort ? [recipe.effort] : []]
			] as [string, string[]][]
		).filter(([, values]) => values.length > 0)
	);

	/** Only the pantry states worth knowing mid-recipe, always in words. */
	const STATUS: Record<string, string> = {
		shopping_list: 'On the list',
		use_up: 'Use up'
	};

	const errorFor = (action: string) => (form?.action === action ? form.error : undefined);

	/*
	 * Whether the editor is unfolded. State the viewer owns, not something
	 * derived from the last result: derived, a successful save folded the form
	 * away mid-edit and hid its own "Saved." A refused save opens it, so the
	 * message and the values that were refused are in view — on the server
	 * render too, for a browser without JavaScript.
	 */
	let editing = $state(Boolean(errorFor('save')));
	$effect.pre(() => {
		if (errorFor('save')) editing = true;
	});
</script>

<svelte:head><title>{recipe.name} · LifeOS</title></svelte:head>

<PageHeader title={recipe.name} back={{ href: '/food', label: 'Food HQ' }}>
	{#snippet meta()}
		{#if archived}<Badge tone="neutral">Archived</Badge>{/if}
		<!-- In words for anyone without the button below, which says it itself. -->
		{#if recipe.isFavourite && !(data.canEdit && !archived)}
			<Badge tone="accent"><span aria-hidden="true">★</span> Favourite</Badge>
		{/if}
		<span>{lastMade}</span>
	{/snippet}
	{#snippet actions()}
		{#if data.canEdit && !archived}
			<form method="POST" action="?/favourite" use:enhance>
				<input type="hidden" name="favourite" value={recipe.isFavourite ? 'false' : 'true'} />
				<!-- One label, and the state in aria-pressed and the star's shape:
				     a label that flips between "Favourite" and "Unfavourite" reads
				     to a screen reader as two different buttons. -->
				<Button
					type="submit"
					variant={recipe.isFavourite ? 'primary' : 'secondary'}
					aria-pressed={recipe.isFavourite}
				>
					<span aria-hidden="true">{recipe.isFavourite ? '★' : '☆'}</span> Favourite
				</Button>
			</form>
			<form method="POST" action="?/made" use:enhance>
				<Button type="submit" icon="check">Made it today</Button>
			</form>
		{/if}
	{/snippet}
</PageHeader>

{#if form?.error && form.action !== 'save'}
	<p class="notice error" role="alert">{form.error}</p>
{:else if form?.restored}
	<p class="notice ok" role="status">Restored. It is back on Food HQ.</p>
{/if}

<div class="layout">
	<!-- First in the page, so a phone reads what it takes before how. -->
	<div class="side">
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

		{#if times.length > 0 || tags.length > 0}
			<Card title="At a glance">
				{#if times.length > 0}
					<dl class="facts">
						{#each times as fact (fact.label)}
							<div>
								<dt>{fact.label}</dt>
								<dd class="numeric">{fact.value}</dd>
							</div>
						{/each}
					</dl>
				{/if}
				{#if tags.length > 0}
					<dl class="tags">
						{#each tags as [label, values] (label)}
							<div>
								<dt>{label}</dt>
								<dd>
									<ul>
										{#each values as value (value)}<li>{value}</li>{/each}
									</ul>
								</dd>
							</div>
						{/each}
					</dl>
				{/if}
			</Card>
		{/if}

		<Card title="Ingredients" flush>
			{#if data.ingredients.length === 0}
				<EmptyState
					title="No ingredients linked"
					description="The method may still list them."
					icon="journal"
				/>
			{:else}
				<ul class="ingredients">
					{#each data.ingredients as item (item.id)}
						<li>
							<span class="name">{item.name}</span>
							{#if item.amount}<span class="amount">{item.amount}</span>{/if}
							{#if STATUS[item.status]}<Badge tone="warn">{STATUS[item.status]}</Badge>{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</Card>
	</div>

	<div class="main">
		<Card title="Instructions">
			{#if data.instructions}
				<!--
					The only {@html} in the application, and safe because of where
					the string comes from: `data.instructions` is built on the server
					by renderMarkdown ($lib/server/markdown), which runs DOMPurify
					over an explicit tag and attribute allowlist and then keeps only
					http(s)/mailto/tel links and images served from /api/media. The
					recipe's own notes never reach this tag; only that output does.
				-->
				<!-- eslint-disable-next-line svelte/no-at-html-tags -->
				<div class="prose">{@html data.instructions}</div>
			{:else}
				<EmptyState
					title="No instructions yet"
					description={data.canEdit
						? 'Add the method under “Edit recipe” below. Markdown works: numbered steps, lists, tables.'
						: undefined}
					icon="journal"
				/>
			{/if}
		</Card>

		{#if nutrition.length > 0}
			<Card title="Per serving">
				<dl class="facts">
					{#each nutrition as fact (fact.label)}
						<div>
							<dt>{fact.label}</dt>
							<dd class="numeric">{fact.value}</dd>
						</div>
					{/each}
				</dl>
			</Card>
		{/if}

		{#if data.source}
			<Card title="Source">
				<p class="source">
					{#if data.source.href}
						<!-- The household's own link, not an application route, and
						     already checked to be http(s) on the server. -->
						<!-- eslint-disable svelte/no-navigation-without-resolve -->
						<a href={data.source.href} target="_blank" rel="noopener noreferrer">
							{data.source.label}<span class="sr-only"> (opens in a new tab)</span>
						</a>
						<!-- eslint-enable svelte/no-navigation-without-resolve -->
					{:else}
						<!-- Not a web address, so shown as the words it is rather
						     than as a link that could go anywhere. -->
						{data.source.label}
					{/if}
				</p>
			</Card>
		{/if}

		{#if data.canEdit}
			<details class="panel" bind:open={editing}>
				<summary>Edit recipe</summary>
				<form
					method="POST"
					action="?/save"
					class="edit"
					use:enhance={() =>
						async ({ update }) =>
							// Not reset: the fields should show what was saved, and a
							// reset would put back the values the page first loaded with.
							update({ reset: false })}
				>
					<!-- The version this form was rendered from; `.toISOString()`
					     because the precondition compares to the millisecond. -->
					<input type="hidden" name="updatedAt" value={recipe.updatedAt.toISOString()} />

					<Input label="Name" name="name" value={recipe.name} required maxlength={300} />

					<div class="grid">
						<Input
							label="Serves"
							name="servings"
							type="number"
							inputmode="numeric"
							min="1"
							value={recipe.servings?.toString() ?? ''}
						/>
						<Input
							label="Prep (min)"
							name="prepMinutes"
							type="number"
							inputmode="numeric"
							min="0"
							value={recipe.prepMinutes?.toString() ?? ''}
						/>
						<Input
							label="Cook (min)"
							name="cookMinutes"
							type="number"
							inputmode="numeric"
							min="0"
							value={recipe.cookMinutes?.toString() ?? ''}
						/>
						<Input
							label="Additional (min)"
							name="additionalMinutes"
							type="number"
							inputmode="numeric"
							min="0"
							value={recipe.additionalMinutes?.toString() ?? ''}
						/>
					</div>

					<Input
						label="Source link"
						name="url"
						type="url"
						inputmode="url"
						placeholder="https://"
						value={recipe.url ?? ''}
					/>
					<Textarea
						label="Instructions"
						name="notes"
						rows={14}
						value={recipe.notes ?? ''}
						hint="Markdown: # for a heading, 1. for a step, - [ ] for a checklist, | for a table."
					/>

					{#if errorFor('save')}
						<p class="notice error" role="alert">{errorFor('save')}</p>
					{:else if form?.saved}
						<p class="notice ok" role="status">Saved.</p>
					{/if}

					<div class="row-end">
						<Button type="submit" variant="primary">Save recipe</Button>
					</div>
				</form>
			</details>

			<Card title={archived ? 'Restore' : 'Archive'}>
				<p class="muted">
					{archived
						? 'This recipe is archived: it is off Food HQ and out of search. Restoring brings it back.'
						: 'Archiving takes this recipe off Food HQ without deleting it. It waits in the Archive.'}
				</p>
				<form method="POST" action="?/archive" use:enhance>
					<input type="hidden" name="archived" value={archived ? 'false' : 'true'} />
					<Button type="submit" variant={archived ? 'primary' : 'secondary'}>
						{archived ? 'Restore recipe' : 'Archive recipe'}
					</Button>
				</form>
			</Card>
		{:else}
			<p class="muted">
				This recipe belongs to someone else in the household, so only they can change it.
			</p>
		{/if}
	</div>
</div>

<style>
	.layout {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--sp-4);
		align-items: start;
	}
	.side,
	.main {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
		/* A grid child is as wide as its widest content unless told otherwise;
		   without this one long table row widens the page on a phone. */
		min-width: 0;
	}
	@media (min-width: 60rem) {
		.layout {
			grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr);
		}
		/* The method gets the wide column; what it takes sits beside it. The
		   DOM keeps the phone's order, ingredients first. */
		.main {
			grid-column: 1;
			grid-row: 1;
		}
		.side {
			grid-column: 2;
			grid-row: 1;
		}
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

	.facts {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(6.5rem, 1fr));
		gap: var(--sp-3);
		margin: 0;
	}
	.facts div {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}
	dt {
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
		letter-spacing: 0.03em;
		text-transform: uppercase;
	}
	dd {
		margin: 0;
		font-weight: 600;
	}

	.tags {
		display: grid;
		gap: var(--sp-3);
		margin: var(--sp-4) 0 0;
	}
	.facts + .tags {
		padding-top: var(--sp-4);
		border-top: 1px solid var(--c-border);
	}
	.tags ul {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-1);
		margin: var(--sp-1) 0 0;
		padding: 0;
		list-style: none;
	}
	.tags li {
		padding: 0.05rem var(--sp-2);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-pill);
		font-size: var(--fs-sm);
		font-weight: 500;
	}

	.ingredients {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.ingredients li {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--sp-1) var(--sp-2);
		min-height: var(--tap);
		padding: var(--sp-3) var(--sp-4);
	}
	.ingredients li + li {
		border-top: 1px solid var(--c-border);
	}
	.ingredients .name {
		font-weight: 550;
		overflow-wrap: anywhere;
	}
	.ingredients .amount {
		flex: 1 1 auto;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}

	/* ── The rendered method. Its markup comes from {@html}, which Svelte's
	   scoping cannot see, so every rule reaches into it with :global. ── */
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
	/* Numbered steps are the method; give each one room to be found again
	   with floury hands. */
	.prose :global(ol > li) {
		margin: var(--sp-2) 0;
		padding-left: var(--sp-1);
	}
	.prose :global(li:has(> input[type='checkbox'])) {
		list-style: none;
		margin-left: -1.4rem;
	}
	/* A task-list tick is a picture of a tick, not a control, so the global
	   44px minimum for inputs does not apply to it. */
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
	/* The renderer wraps every table in one of these: the table scrolls inside
	   it on a phone, and the page does not scroll sideways. */
	.prose :global(.md-table) {
		max-width: 100%;
		overflow-x: auto;
		border: 1px solid var(--c-border);
		border-radius: var(--radius-sm);
		/* Scroll shadows: the covers travel with the content ("local") and the
		   shadows stay at the edges ("scroll"), so a shadow shows only on a side
		   with more table behind it. A table cut off at a column boundary
		   otherwise looks complete, and nobody thinks to swipe it. */
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
		/* On a phone the table scrolls rather than squeezing: without a floor
		   every column shrinks to its longest word and a sentence in a cell
		   stacks five lines deep. Wider screens let columns size themselves. */
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

	.source {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.source a {
		display: inline-flex;
		align-items: center;
		min-height: var(--tap);
	}

	/* The editor is folded away: the page is for reading a recipe while
	   cooking, and a form that size in the way of the method is clutter. */
	.panel {
		border: 1px solid var(--c-border);
		border-radius: var(--radius);
		background: var(--c-surface);
	}
	.panel summary {
		display: flex;
		align-items: center;
		min-height: var(--tap);
		padding: var(--sp-2) var(--sp-4);
		font-size: var(--fs-lg);
		font-weight: 650;
		cursor: pointer;
	}
	.panel[open] summary {
		border-bottom: 1px solid var(--c-border);
	}
	.edit {
		display: grid;
		gap: var(--sp-4);
		padding: var(--sp-4);
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 8rem), 1fr));
		gap: var(--sp-3);
	}
	.row-end {
		display: flex;
		justify-content: flex-end;
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
