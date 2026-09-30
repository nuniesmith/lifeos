<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import {
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
	import { appPath } from '$lib/components/nav';

	let { data, form } = $props();

	type Entry = (typeof data.entries)[number];

	const MEAL_SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
	type Meal = (typeof MEAL_SLOTS)[number];
	const MEAL_LABELS: Record<Meal, string> = {
		breakfast: 'Breakfast',
		lunch: 'Lunch',
		dinner: 'Dinner',
		snack: 'Snacks'
	};

	// ─── the food/recipe picker, shared by the add form and the edit sheet ────
	//
	// One `<select name="source">` posting "food:<id>" / "recipe:<id>" / "" for
	// a custom entry, parsed server-side (+page.server.ts's parseSource) so
	// nothing here has to mirror "which one is picked" into hidden fields.

	const sourceOptions = $derived([
		...data.foods.map((f) => ({
			value: `food:${f.id}`,
			label: f.serving ? `${f.name} (${f.serving})` : f.name
		})),
		...data.recipes.map((r) => ({
			value: `recipe:${r.id}`,
			label: r.servings ? `${r.name} (serves ${r.servings})` : r.name
		}))
	]);

	const MEAL_OPTIONS = MEAL_SLOTS.map((m) => ({ value: m, label: MEAL_LABELS[m] }));

	// ─── day navigation and formatting ─────────────────────────────────────

	const longDay = (date: string): string =>
		new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
			weekday: 'long',
			day: 'numeric',
			month: 'long',
			timeZone: 'UTC'
		});
	const shortDay = (date: string): string =>
		new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
			weekday: 'short',
			day: 'numeric',
			month: 'short',
			timeZone: 'UTC'
		});

	const dayHeading = $derived(data.date === data.today ? 'Today' : longDay(data.date));

	/** Rounded to one decimal, "—" for unknown — every nutrient on this page
	 *  shows the same way. */
	const fmt = (n: number | null): string =>
		n === null ? '—' : (Math.round(n * 10) / 10).toString();
	const unknownNote = (count: number): string =>
		count > 0 ? ` (${count} ${count === 1 ? 'entry' : 'entries'} unknown)` : '';

	// ─── grouping the day's entries by meal ────────────────────────────────

	const entriesByMeal = $derived.by(() => {
		const groups: Record<Meal, Entry[]> = { breakfast: [], lunch: [], dinner: [], snack: [] };
		for (const entry of data.entries) groups[entry.meal].push(entry);
		return groups;
	});

	const mealTotalsByMeal = $derived.by(() => {
		const byMeal: Partial<Record<Meal, (typeof data.meals)[number]>> = {};
		for (const total of data.meals) byMeal[total.meal] = total;
		return byMeal;
	});

	const mealsWithEntries = $derived(MEAL_SLOTS.filter((m) => entriesByMeal[m].length > 0));

	/** The first meal not yet logged today, so the add form starts on
	 *  whatever is missing rather than always defaulting to breakfast. */
	const defaultMeal = $derived(
		MEAL_SLOTS.find((m) => entriesByMeal[m].length === 0) ?? ('dinner' as Meal)
	);

	const entryOwner = (entry: Entry) => (entry.ownerUserId === data.viewerId ? null : 'shared');

	// ─── the add form ───────────────────────────────────────────────────────
	//
	// Bumped after a successful save to draw the form afresh from the reloaded
	// data (a new defaultMeal, an empty picker) rather than reset to whatever
	// the page was first served with — the same reasoning health-measurements'
	// own addFormKey carries.
	let addFormKey = $state(0);
	let addSource = $state('');
	const addIsCustom = $derived(addSource === '');

	// ─── the edit sheet ─────────────────────────────────────────────────────

	let editing = $state<Entry | null>(null);
	let editOpen = $state(false);
	let editSource = $state('');

	function startEdit(entry: Entry) {
		editing = entry;
		editSource = entry.foodId
			? `food:${entry.foodId}`
			: entry.recipeId
				? `recipe:${entry.recipeId}`
				: '';
		editOpen = true;
	}
	const editIsCustom = $derived(editSource === '');
</script>

<svelte:head><title>Food log · LifeOS</title></svelte:head>

<PageHeader
	title="Food log"
	description="What was eaten, when, and how much."
	back={{ href: '/food', label: 'Food HQ' }}
/>

{#if form?.error}
	<p class="notice error" role="alert">{form.error}</p>
{/if}

<nav class="day-nav" aria-label="Move the food log">
	<a
		class="step"
		href={resolve(appPath(`/food/log?date=${data.previousDate}${data.shared ? '&shared=1' : ''}`))}
		rel="prev"
	>
		<span aria-hidden="true">‹</span> Earlier
	</a>
	<h2 class="day-heading">{dayHeading}</h2>
	<a
		class="step"
		href={resolve(appPath(`/food/log?date=${data.nextDate}${data.shared ? '&shared=1' : ''}`))}
		rel="next"
	>
		Later <span aria-hidden="true">›</span>
	</a>
</nav>
{#if data.date !== data.today}
	<a class="today-link" href={resolve(appPath(`/food/log${data.shared ? '?shared=1' : ''}`))}
		>Back to today</a
	>
{/if}

<p class="toggle">
	{#if data.shared}
		<a href={resolve(appPath(`/food/log?date=${data.date}`))}>Just my entries</a>
	{:else}
		<a href={resolve(appPath(`/food/log?date=${data.date}&shared=1`))}
			>Also show the household's shared entries</a
		>
	{/if}
</p>

<section aria-labelledby="day-total-heading">
	<h2 id="day-total-heading" class="section-title">{dayHeading}’s total</h2>
	<Card>
		{#if data.dayTotal}
			<div class="totals-prominent">
				<div class="stat">
					<span class="stat-value">{fmt(data.dayTotal.kcal)}</span>
					<span class="stat-label">kcal{unknownNote(data.dayTotal.kcalUnknown)}</span>
				</div>
				<div class="stat">
					<span class="stat-value">{fmt(data.dayTotal.proteinG)}</span>
					<span class="stat-label">g protein{unknownNote(data.dayTotal.proteinGUnknown)}</span>
				</div>
			</div>
			<dl class="totals-minor">
				<div>
					<dt>Carbs</dt>
					<dd>{fmt(data.dayTotal.carbsG)} g{unknownNote(data.dayTotal.carbsGUnknown)}</dd>
				</div>
				<div>
					<dt>Fibre</dt>
					<dd>{fmt(data.dayTotal.fibreG)} g{unknownNote(data.dayTotal.fibreGUnknown)}</dd>
				</div>
				<div>
					<dt>Sugar</dt>
					<dd>{fmt(data.dayTotal.sugarG)} g{unknownNote(data.dayTotal.sugarGUnknown)}</dd>
				</div>
				<div>
					<dt>Fat</dt>
					<dd>{fmt(data.dayTotal.totalFatG)} g{unknownNote(data.dayTotal.totalFatGUnknown)}</dd>
				</div>
				<div>
					<dt>Sodium</dt>
					<dd>{fmt(data.dayTotal.sodiumMg)} mg{unknownNote(data.dayTotal.sodiumMgUnknown)}</dd>
				</div>
			</dl>
		{:else}
			<p class="nothing">Nothing logged {dayHeading === 'Today' ? 'yet' : 'that day'}.</p>
		{/if}
	</Card>
</section>

{#if mealsWithEntries.length === 0}
	<EmptyState
		title="Nothing logged {dayHeading === 'Today' ? 'yet' : ''}"
		description="Log a food, a recipe, or a one-off below."
		icon="today"
	/>
{:else}
	{#each mealsWithEntries as meal (meal)}
		{@const total = mealTotalsByMeal[meal]}
		<section aria-labelledby={`meal-${meal}-heading`}>
			<h2 id={`meal-${meal}-heading`} class="section-title">
				{MEAL_LABELS[meal]}
				{#if total}
					<span class="meal-total">
						· {fmt(total.kcal)} kcal{unknownNote(total.kcalUnknown)} · {fmt(total.proteinG)} g protein{unknownNote(
							total.proteinGUnknown
						)}
					</span>
				{/if}
			</h2>
			<Card flush>
				<List label={`${MEAL_LABELS[meal]} entries`}>
					{#each entriesByMeal[meal] as entry (entry.id)}
						<ListRow
							title={entry.name}
							meta={`${entry.servings} serving${entry.servings === 1 ? '' : 's'}${entryOwner(entry) ? ' · shared' : ''}`}
						>
							{#snippet trail()}
								<div class="row-actions">
									<Button size="sm" variant="ghost" onclick={() => startEdit(entry)}>Edit</Button>
									<form method="POST" action="?/delete" use:enhance>
										<input type="hidden" name="id" value={entry.id} />
										<Button
											type="submit"
											size="sm"
											variant="ghost"
											aria-label={`Delete ${entry.name} from ${MEAL_LABELS[meal].toLowerCase()}`}
										>
											Delete
										</Button>
									</form>
								</div>
							{/snippet}
							{#if entry.notes}<p class="row-notes">{entry.notes}</p>{/if}
						</ListRow>
					{/each}
				</List>
			</Card>
		</section>
	{/each}
{/if}

<section aria-labelledby="add-heading">
	<h2 id="add-heading" class="section-title">Log food</h2>
	<Card>
		{#key addFormKey}
			<form
				method="POST"
				action="?/create"
				use:enhance={() => {
					return async ({ result, update }) => {
						await update();
						if (result.type === 'success') addFormKey += 1;
					};
				}}
			>
				<input type="hidden" name="eatenOn" value={data.date} />

				<Select
					label="Food or recipe"
					name="source"
					options={sourceOptions}
					placeholder="Custom — type a name and nutrients below"
					bind:value={addSource}
				/>

				{#if addIsCustom}
					<Input label="Name" name="name" required maxlength={200} />
					<div class="grid">
						<Input
							label="Calories"
							name="kcalOverride"
							type="number"
							inputmode="decimal"
							step="0.1"
							min="0"
							hint="kcal"
						/>
						<Input
							label="Protein"
							name="proteinGOverride"
							type="number"
							inputmode="decimal"
							step="0.1"
							min="0"
							hint="g"
						/>
						<Input
							label="Carbs"
							name="carbsGOverride"
							type="number"
							inputmode="decimal"
							step="0.1"
							min="0"
							hint="g"
						/>
						<Input
							label="Fibre"
							name="fibreGOverride"
							type="number"
							inputmode="decimal"
							step="0.1"
							min="0"
							hint="g"
						/>
						<Input
							label="Sugar"
							name="sugarGOverride"
							type="number"
							inputmode="decimal"
							step="0.1"
							min="0"
							hint="g"
						/>
						<Input
							label="Fat"
							name="totalFatGOverride"
							type="number"
							inputmode="decimal"
							step="0.1"
							min="0"
							hint="g"
						/>
						<Input
							label="Sodium"
							name="sodiumMgOverride"
							type="number"
							inputmode="decimal"
							step="0.1"
							min="0"
							hint="mg"
						/>
					</div>
				{:else}
					<Input
						label="Servings"
						name="servings"
						type="number"
						inputmode="decimal"
						step="0.25"
						min="0.25"
						value="1"
					/>
				{/if}

				<Select label="Meal" name="meal" options={MEAL_OPTIONS} value={defaultMeal} />
				<Textarea label="Notes" name="notes" rows={2} hint="Optional." />

				<div class="actions">
					<Button type="submit" variant="primary">Add to log</Button>
				</div>
			</form>
		{/key}
	</Card>
</section>

<section aria-labelledby="week-heading">
	<h2 id="week-heading" class="section-title">Last 7 days</h2>
	<Card flush>
		<div class="table-wrap">
			<table>
				<caption class="sr-only">Kcal and protein for the last 7 days</caption>
				<thead>
					<tr>
						<th scope="col">Day</th>
						<th scope="col">Kcal</th>
						<th scope="col">Protein</th>
					</tr>
				</thead>
				<tbody>
					{#each data.lastSevenDays as day (day.day)}
						<tr class:today-row={day.day === data.today}>
							<td>{day.day === data.today ? 'Today' : shortDay(day.day)}</td>
							<td>{fmt(day.kcal)}</td>
							<td>{fmt(day.proteinG)} g</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</Card>
</section>

<section aria-labelledby="month-heading">
	<h2 id="month-heading" class="section-title">This month</h2>
	<Card>
		<p class="month-protein">
			<strong>{fmt(data.monthProtein?.proteinG ?? null)} g</strong> protein logged this month
			{#if data.monthProtein}{unknownNote(data.monthProtein.unknownEntries)}{/if}
		</p>
	</Card>
</section>

<Sheet bind:open={editOpen} title="Edit entry">
	{#if editing}
		{@const e = editing}
		<form
			method="POST"
			action="?/update"
			use:enhance={() => {
				return async ({ result, update }) => {
					await update();
					if (result.type === 'success') editOpen = false;
				};
			}}
		>
			<input type="hidden" name="id" value={e.id} />
			<input type="hidden" name="expectedUpdatedAt" value={e.updatedAt.toISOString()} />

			<Input label="Date" name="eatenOn" type="date" value={e.eatenOn} required />
			<Select label="Meal" name="meal" options={MEAL_OPTIONS} value={e.meal} />

			<Select
				label="Food or recipe"
				name="source"
				options={sourceOptions}
				placeholder="Custom — type a name below"
				bind:value={editSource}
			/>
			{#if editIsCustom}
				<Input label="Name" name="name" required maxlength={200} value={e.name} />
			{/if}
			<Input
				label="Servings"
				name="servings"
				type="number"
				inputmode="decimal"
				step="0.25"
				min="0.25"
				value={e.servings.toString()}
			/>

			<fieldset class="overrides">
				<legend
					>Override this entry's nutrients — replaces servings × the source's own value, for just
					the ones set here</legend
				>
				<div class="grid">
					<Input
						label="Calories"
						name="kcalOverride"
						type="number"
						inputmode="decimal"
						step="0.1"
						min="0"
						hint="kcal"
						value={e.kcalOverride?.toString() ?? ''}
					/>
					<Input
						label="Protein"
						name="proteinGOverride"
						type="number"
						inputmode="decimal"
						step="0.1"
						min="0"
						hint="g"
						value={e.proteinGOverride?.toString() ?? ''}
					/>
					<Input
						label="Carbs"
						name="carbsGOverride"
						type="number"
						inputmode="decimal"
						step="0.1"
						min="0"
						hint="g"
						value={e.carbsGOverride?.toString() ?? ''}
					/>
					<Input
						label="Fibre"
						name="fibreGOverride"
						type="number"
						inputmode="decimal"
						step="0.1"
						min="0"
						hint="g"
						value={e.fibreGOverride?.toString() ?? ''}
					/>
					<Input
						label="Sugar"
						name="sugarGOverride"
						type="number"
						inputmode="decimal"
						step="0.1"
						min="0"
						hint="g"
						value={e.sugarGOverride?.toString() ?? ''}
					/>
					<Input
						label="Fat"
						name="totalFatGOverride"
						type="number"
						inputmode="decimal"
						step="0.1"
						min="0"
						hint="g"
						value={e.totalFatGOverride?.toString() ?? ''}
					/>
					<Input
						label="Sodium"
						name="sodiumMgOverride"
						type="number"
						inputmode="decimal"
						step="0.1"
						min="0"
						hint="mg"
						value={e.sodiumMgOverride?.toString() ?? ''}
					/>
				</div>
			</fieldset>

			<Textarea label="Notes" name="notes" rows={2} value={e.notes ?? ''} />

			{#if form?.action === 'update' && form.error}
				<p class="notice error" role="alert">{form.error}</p>
			{/if}

			<div class="actions">
				<Button variant="ghost" type="button" onclick={() => (editOpen = false)}>Cancel</Button>
				<Button type="submit" variant="primary">Save changes</Button>
			</div>
		</form>
	{/if}
</Sheet>

<style>
	section {
		margin-top: var(--sp-6);
	}

	.section-title {
		margin: 0 0 var(--sp-3);
		font-size: var(--fs-lg);
		font-weight: 650;
	}

	.meal-total {
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
		font-weight: 500;
	}

	.day-nav {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--sp-2);
	}
	.day-heading {
		margin: 0;
		font-size: var(--fs-lg);
		font-weight: 650;
	}
	.step {
		font-size: var(--fs-sm);
		text-decoration: none;
	}
	.step:hover {
		text-decoration: underline;
	}
	.today-link {
		display: inline-block;
		margin-top: var(--sp-1);
		font-size: var(--fs-sm);
	}
	.toggle {
		margin: var(--sp-2) 0 0;
		font-size: var(--fs-sm);
	}

	.totals-prominent {
		display: flex;
		gap: var(--sp-6);
	}
	.stat {
		display: flex;
		flex-direction: column;
	}
	.stat-value {
		font-size: var(--fs-2xl, 2rem);
		font-weight: 700;
		line-height: 1.1;
	}
	.stat-label {
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}
	.totals-minor {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
		gap: var(--sp-2) var(--sp-4);
		margin: var(--sp-4) 0 0;
	}
	.totals-minor div {
		display: flex;
		justify-content: space-between;
		gap: var(--sp-2);
	}
	.totals-minor dt {
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}
	.totals-minor dd {
		margin: 0;
		font-size: var(--fs-sm);
	}
	.nothing {
		margin: 0;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}

	.row-actions {
		display: flex;
		gap: var(--sp-1);
	}
	.row-notes {
		margin: var(--sp-1) 0 0;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}

	form {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 8rem), 1fr));
		gap: var(--sp-3);
	}
	.overrides {
		margin: 0;
		padding: 0;
		border: none;
		min-width: 0;
	}
	.overrides legend {
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

	.table-wrap {
		overflow-x: auto;
	}
	table {
		width: 100%;
		border-collapse: collapse;
	}
	th,
	td {
		padding: var(--sp-2) var(--sp-4);
		text-align: left;
		font-size: var(--fs-sm);
	}
	th {
		color: var(--c-text-muted);
		font-weight: 600;
	}
	tbody tr + tr {
		border-top: 1px solid var(--c-border);
	}
	.today-row {
		font-weight: 650;
	}

	.month-protein {
		margin: 0;
		font-size: var(--fs-base);
	}

	.notice {
		padding: var(--sp-2) var(--sp-3);
		border-radius: var(--radius-sm);
		margin: 0;
	}
	.notice.error {
		color: var(--c-crit);
		border: 1px solid color-mix(in srgb, var(--c-crit) 25%, transparent);
		background: color-mix(in srgb, var(--c-crit) 8%, transparent);
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
</style>
