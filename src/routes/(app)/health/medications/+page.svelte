<script lang="ts">
	import { enhance } from '$app/forms';
	import {
		Badge,
		Button,
		Card,
		Checkbox,
		EmptyState,
		Input,
		List,
		ListRow,
		PageHeader,
		Select,
		Sheet,
		Textarea
	} from '$lib/components';
	import type { MedicationView } from './+page.server';

	let { data, form } = $props();

	type ScheduleKind = (typeof data.scheduleKinds)[number];
	type MedType = (typeof data.types)[number];
	type MedStatus = (typeof data.statuses)[number];

	/** Same order and wording as the source page's own grouping. */
	const GROUP_LABELS: Record<ScheduleKind, string> = {
		daily_am: 'Daily · morning',
		daily_pm: 'Daily · evening',
		scheduled: 'Scheduled',
		as_needed: 'As needed'
	};

	const TYPE_LABELS: Record<MedType, string> = {
		prescription: 'Prescription',
		supplement: 'Supplement',
		vitamin: 'Vitamin',
		electrolyte: 'Electrolyte',
		otc: 'OTC'
	};

	const STATUS_LABELS: Record<MedStatus, string> = { taking: 'Taking', paused: 'Paused' };

	/** 0 = Sunday, matching the repository's own `scheduledWeekday`. */
	const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

	// `data` is a prop and can change after navigation, so these read it inside
	// `$derived` rather than once at first render — even though, in practice,
	// the lists themselves are static per load.
	const typeOptions = $derived(data.types.map((t) => ({ value: t, label: TYPE_LABELS[t] })));
	const scheduleOptions = $derived(
		data.scheduleKinds.map((k) => ({ value: k, label: GROUP_LABELS[k] }))
	);
	const statusOptions = $derived(data.statuses.map((s) => ({ value: s, label: STATUS_LABELS[s] })));
	const weekdayOptions = WEEKDAYS.map((label, value) => ({ value: String(value), label }));

	// A plain object rather than a Map: the lint rule steers mutable built-ins
	// towards their reactive equivalents, and this is derived and thrown away —
	// the same trade-off Food HQ's `byAisle` grouping already makes.
	const groups = $derived.by(() => {
		const byKind: Record<string, MedicationView[]> = {};
		for (const kind of data.scheduleKinds) byKind[kind] = [];
		for (const med of data.medications) {
			(byKind[med.scheduleKind] ??= []).push(med);
		}
		return data.scheduleKinds.map((kind) => ({
			kind,
			label: GROUP_LABELS[kind],
			items: byKind[kind] ?? []
		}));
	});

	const runningLowCount = $derived(data.medications.filter((m) => m.runningLow).length);
	const dueCount = $derived(
		data.medications.filter((m) => m.dueStatus.isDueToday && !m.takenToday).length
	);

	const doseMeta = (med: MedicationView): string => {
		const parts = [
			[med.dose, med.unit].filter(Boolean).join(' ') || null,
			med.brand,
			med.dueStatus.nextDueOn && !med.takenToday && med.scheduleKind === 'scheduled'
				? `next ${med.dueStatus.nextDueOn}`
				: null,
			med.dueStatus.lastTakenOn ? `last taken ${med.dueStatus.lastTakenOn}` : null
		];
		return parts.filter(Boolean).join(' · ');
	};

	// ─── add / edit sheet ─────────────────────────────────────────────────────

	let sheetOpen = $state(false);
	let editing = $state<MedicationView | null>(null);

	let fName = $state('');
	let fType = $state<string>('vitamin');
	let fDose = $state('');
	let fUnit = $state('');
	let fBrand = $state('');
	let fSchedule = $state<string>('as_needed');
	let fWeekday = $state('');
	let fInterval = $state('');
	let fStartDate = $state('');
	let fEndDate = $state('');
	let fStatus = $state<string>('taking');
	let fRunningLow = $state(false);
	let fNotes = $state('');

	// Keeps a stale weekday/interval from silently riding along once the
	// schedule stops being "Scheduled" — the fields are only hidden, not
	// removed (see the form below), so without this a value picked earlier
	// would still submit.
	$effect(() => {
		if (fSchedule !== 'scheduled') {
			fWeekday = '';
			fInterval = '';
		}
	});

	function openAdd() {
		editing = null;
		fName = '';
		fType = 'vitamin';
		fDose = '';
		fUnit = '';
		fBrand = '';
		fSchedule = 'as_needed';
		fWeekday = '';
		fInterval = '';
		fStartDate = '';
		fEndDate = '';
		fStatus = 'taking';
		fRunningLow = false;
		fNotes = '';
		sheetOpen = true;
	}

	function openEdit(med: MedicationView) {
		editing = med;
		fName = med.name;
		fType = med.type;
		fDose = med.dose ?? '';
		fUnit = med.unit ?? '';
		fBrand = med.brand ?? '';
		fSchedule = med.scheduleKind;
		fWeekday = med.scheduledWeekday !== null ? String(med.scheduledWeekday) : '';
		fInterval = med.intervalDays !== null ? String(med.intervalDays) : '';
		fStartDate = med.startDate ?? '';
		fEndDate = med.endDate ?? '';
		fStatus = med.status;
		fRunningLow = med.runningLow;
		fNotes = med.notes ?? '';
		sheetOpen = true;
	}
</script>

<svelte:head><title>Medications & supplements · LifeOS</title></svelte:head>

<PageHeader
	title="Medications & supplements"
	description="What you take, when, and what needs a refill."
	back={{ href: '/health', label: 'Health' }}
>
	{#snippet actions()}
		<Button variant="primary" icon="plus" onclick={openAdd}>Add medication</Button>
	{/snippet}
	{#snippet meta()}
		<span>{data.medications.length} tracked</span>
		{#if dueCount > 0}<span>{dueCount} due today</span>{/if}
		{#if runningLowCount > 0}<span>{runningLowCount} running low</span>{/if}
	{/snippet}
</PageHeader>

{#if form?.error}
	<p class="notice error" role="alert">{form.error}</p>
{/if}

<div class="stack">
	{#each groups as group (group.kind)}
		<section aria-labelledby={`group-${group.kind}`}>
			<h2 id={`group-${group.kind}`} class="section-title">{group.label}</h2>
			<Card flush>
				{#if group.items.length === 0}
					<EmptyState title="Nothing here" icon="check" />
				{:else}
					<List label={group.label}>
						{#each group.items as med (med.id)}
							<ListRow
								title={med.name}
								meta={doseMeta(med) || undefined}
								muted={med.status === 'paused'}
							>
								{#snippet lead()}
									<form method="POST" action="?/toggleDose" use:enhance>
										<input type="hidden" name="medicationId" value={med.id} />
										<input type="hidden" name="taken" value={med.takenToday ? 'false' : 'true'} />
										<button
											type="submit"
											class="dose-toggle"
											class:done={med.takenToday}
											aria-pressed={med.takenToday}
											aria-label={`${med.takenToday ? 'Undo' : 'Mark'} ${med.name} taken today`}
										>
											{#if med.takenToday}
												<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
													<path
														d="M5 12.5l4.5 4.5L19 7"
														fill="none"
														stroke="currentColor"
														stroke-width="2.5"
														stroke-linecap="round"
														stroke-linejoin="round"
													/>
												</svg>
											{/if}
										</button>
									</form>
								{/snippet}
								{#snippet trail()}
									<div class="row-actions">
										<Badge tone="neutral">{TYPE_LABELS[med.type]}</Badge>
										{#if med.runningLow}<Badge tone="warn">Running low</Badge>{/if}
										{#if med.dueStatus.isDueToday && !med.takenToday}
											<Badge tone="accent">Due today</Badge>
										{/if}
										<Button size="sm" variant="ghost" onclick={() => openEdit(med)}>Edit</Button>
									</div>
								{/snippet}
							</ListRow>
						{/each}
					</List>
				{/if}
			</Card>
		</section>
	{/each}
</div>

<Sheet bind:open={sheetOpen} title={editing ? `Edit ${editing.name}` : 'Add medication'}>
	<form
		method="POST"
		action={editing ? '?/updateMedication' : '?/addMedication'}
		use:enhance={() => {
			return async ({ result, update }) => {
				await update();
				if (result.type === 'success') sheetOpen = false;
			};
		}}
	>
		{#if editing}
			<input type="hidden" name="id" value={editing.id} />
			<input type="hidden" name="updatedAt" value={editing.updatedAt.toISOString()} />
		{/if}

		<Input label="Name" name="name" bind:value={fName} required maxlength={200} />

		<Select label="Type" name="type" bind:value={fType} options={typeOptions} />

		<div class="grid-2">
			<Input label="Dose" name="dose" bind:value={fDose} placeholder="10" />
			<Input label="Unit" name="unit" bind:value={fUnit} placeholder="mg" />
		</div>

		<Input label="Brand" name="brand" bind:value={fBrand} />

		<Select label="Schedule" name="scheduleKind" bind:value={fSchedule} options={scheduleOptions} />

		<!--
			Always rendered, only visually hidden: the repository re-validates the
			pair against `scheduleKind` on every save (mirroring the table's own
			CHECK constraints), so switching away from "Scheduled" without also
			clearing these must not leave a submission with no field named
			`scheduledWeekday` / `intervalDays` at all — that reads as "unchanged"
			and the save is correctly refused. Hidden via `hidden`, not `{#if}`,
			so the fields stay part of the form either way.
		-->
		<div class="grid-2" hidden={fSchedule !== 'scheduled'}>
			<Select
				label="Weekday"
				name="scheduledWeekday"
				bind:value={fWeekday}
				placeholder="No specific day"
				options={weekdayOptions}
			/>
			<Input
				label="Or every N days"
				name="intervalDays"
				type="number"
				bind:value={fInterval}
				hint="Leave blank if using a weekday"
			/>
		</div>

		<div class="grid-2">
			<Input label="Start date" name="startDate" type="date" bind:value={fStartDate} />
			<Input label="End date" name="endDate" type="date" bind:value={fEndDate} />
		</div>

		<Select label="Status" name="status" bind:value={fStatus} options={statusOptions} />

		<Checkbox label="Running low" bind:checked={fRunningLow} />
		<input type="hidden" name="runningLow" value={fRunningLow ? 'on' : ''} />

		<Textarea label="Notes" name="notes" bind:value={fNotes} rows={3} />

		{#if editing && editing.recentDoses.length > 0}
			<details class="history">
				<summary>Recent history ({editing.recentDoses.length})</summary>
				<ul>
					{#each editing.recentDoses as dose (dose.id)}
						<li>{dose.onDate} · {dose.slot}</li>
					{/each}
				</ul>
			</details>
		{/if}

		<div class="actions">
			<Button variant="ghost" type="button" onclick={() => (sheetOpen = false)}>Cancel</Button>
			<Button type="submit" variant="primary">Save</Button>
		</div>
	</form>

	{#if editing}
		<form
			method="POST"
			action="?/archiveMedication"
			class="archive-form"
			use:enhance={() => {
				return async ({ update }) => {
					await update();
					sheetOpen = false;
				};
			}}
		>
			<input type="hidden" name="id" value={editing.id} />
			<input type="hidden" name="archived" value="true" />
			<Button type="submit" variant="danger" size="sm">Archive this medication</Button>
		</form>
	{/if}
</Sheet>

<style>
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-5);
	}

	.section-title {
		margin: 0 0 var(--sp-3);
		font-size: var(--fs-lg);
		font-weight: 650;
	}

	.dose-toggle {
		display: grid;
		place-items: center;
		width: 1.75rem;
		height: 1.75rem;
		border: 1.5px solid var(--c-border);
		border-radius: 50%;
		background: var(--c-surface);
		color: transparent;
		cursor: pointer;
	}
	.dose-toggle.done {
		border-color: var(--c-ok);
		background: color-mix(in srgb, var(--c-ok) 15%, transparent);
		color: var(--c-ok);
	}
	.dose-toggle:hover {
		border-color: var(--c-accent);
	}

	.row-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-2);
		align-items: center;
		justify-content: flex-end;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}

	.grid-2 {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--sp-3);
	}

	.history {
		font-size: var(--fs-sm);
		color: var(--c-text-muted);
	}
	.history ul {
		margin: var(--sp-2) 0 0;
		padding-left: var(--sp-4);
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--sp-2);
	}

	.archive-form {
		margin-top: var(--sp-2);
		padding-top: var(--sp-4);
		border-top: 1px solid var(--c-border);
	}

	.notice {
		padding: var(--sp-2) var(--sp-3);
		border-radius: var(--radius-sm);
		margin-bottom: var(--sp-4);
	}
	.notice.error {
		color: var(--c-crit);
		border: 1px solid color-mix(in srgb, var(--c-crit) 25%, transparent);
		background: color-mix(in srgb, var(--c-crit) 8%, transparent);
	}

	@media (max-width: 40rem) {
		.grid-2 {
			grid-template-columns: 1fr;
		}
	}
</style>
