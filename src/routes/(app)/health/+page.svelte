<script lang="ts">
	import { resolve } from '$app/paths';
	import {
		appPath,
		Badge,
		Button,
		Card,
		EmptyState,
		List,
		ListRow,
		PageHeader
	} from '$lib/components';
	import type { RangeStatus } from '$lib/server/repositories';
	import DueMedicationRow from './DueMedicationRow.svelte';
	import MeasurementChart from './measurements/MeasurementChart.svelte';
	import type { ChartSeries } from './measurements/chart';

	let { data } = $props();

	const STATUS_TONE: Record<RangeStatus, 'ok' | 'crit' | 'neutral'> = {
		low: 'crit',
		high: 'crit',
		in_range: 'ok',
		no_reference: 'neutral'
	};
	const STATUS_LABEL: Record<RangeStatus, string> = {
		low: 'Low',
		high: 'High',
		in_range: 'In range',
		no_reference: 'No range set'
	};

	// ─── medications ──────────────────────────────────────────────────────
	const medGroups = $derived(
		[
			{ key: 'am', label: 'Morning', items: data.health.medications.am },
			{ key: 'pm', label: 'Evening', items: data.health.medications.pm },
			{ key: 'other', label: 'Other', items: data.health.medications.other }
		].filter((group) => group.items.length > 0)
	);
	const medSubtitle = $derived(
		[
			data.health.medications.dueCount > 0
				? `${data.health.medications.dueCount} due today`
				: medGroups.length > 0
					? 'All taken today'
					: null,
			data.health.medications.runningLowCount > 0
				? `${data.health.medications.runningLowCount} running low`
				: null
		]
			.filter(Boolean)
			.join(' · ') || undefined
	);

	// ─── measurements ─────────────────────────────────────────────────────
	// A lab result date is a calendar day ("2026-09-01"). Built from its parts,
	// not `new Date(day)`: that is UTC midnight, which west of Greenwich shows
	// as the day before.
	const dayDate = (day: string) => {
		const [year = 0, month = 1, date = 1] = day.split('-').map(Number);
		return new Date(year, month - 1, date).toLocaleDateString(undefined, {
			day: 'numeric',
			month: 'short',
			year: 'numeric'
		});
	};

	const shortDate = (d: Date) =>
		d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

	const BP_SERIES: ChartSeries[] = [
		{ key: 'systolic', label: 'Systolic', color: 'var(--c-accent)' },
		{ key: 'diastolic', label: 'Diastolic', color: 'var(--c-text-muted)', dashed: true }
	];
	const chartPoints = $derived(
		data.health.measurements.recentChronological.map((r) => ({
			at: r.measuredAt.toISOString(),
			values: { systolic: r.systolic, diastolic: r.diastolic }
		}))
	);
	const hasAnyMeasurement = $derived(
		data.health.measurements.bloodPressure !== null ||
			data.health.measurements.heartRate !== null ||
			data.health.measurements.glucose !== null ||
			data.health.measurements.weight !== null ||
			data.health.measurements.qtInterval !== null
	);

	// ─── visits ────────────────────────────────────────────────────────────
	// A real instant rendered in the browser's own zone -- "when is my
	// appointment" is a question about a moment, not a bare calendar day.
	const when = (at: Date): string =>
		`${at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}, ${at.toLocaleTimeString(
			undefined,
			{ hour: 'numeric', minute: '2-digit' }
		)}`;

	// ─── the old vitals table (blood pressure/HR/sleep/water by day) ──────
	const bp = (v: { systolicBp: number | null; diastolicBp: number | null }): string | null =>
		v.systolicBp !== null && v.diastolicBp !== null ? `${v.systolicBp}/${v.diastolicBp}` : null;
	// A day with a daily log but none of these four values would be a row of
	// dashes; the table only lists days that recorded something it shows.
	const vitalsRows = $derived(
		data.vitals.filter(
			(v) => bp(v) !== null || v.heartRate !== null || v.sleepScore !== null || v.water !== null
		)
	);
</script>

<svelte:head><title>Health &amp; Fitness · LifeOS</title></svelte:head>

<PageHeader title="Health & Fitness" description="Everything tracked, at a glance.">
	{#snippet meta()}
		<span>{data.today}</span>
	{/snippet}
</PageHeader>

<div class="hub-grid">
	<Card title="Medications" subtitle={medSubtitle}>
		{#snippet actions()}
			<Button href="/health/medications" size="sm" variant="ghost">Open</Button>
		{/snippet}
		{#if medGroups.length === 0}
			<EmptyState
				title="Nothing due today"
				description="Daily medications and anything scheduled for today will show up here."
				icon="check"
			/>
		{:else}
			<div class="med-groups">
				{#each medGroups as group (group.key)}
					<div class="med-group">
						<p class="group-label">{group.label}</p>
						<ul class="med-list">
							{#each group.items as medication (medication.id)}
								<DueMedicationRow {medication} showRunningLow />
							{/each}
						</ul>
					</div>
				{/each}
			</div>
		{/if}
	</Card>

	<Card title="Measurements">
		{#snippet actions()}
			<Button href="/health/measurements" size="sm" variant="ghost">Open</Button>
		{/snippet}
		{#if !hasAnyMeasurement}
			<EmptyState
				title="No readings recorded"
				description="Blood pressure, heart rate, glucose, weight and QT interval all live here."
				icon="today"
			>
				{#snippet action()}
					<Button href="/health/measurements" size="sm" variant="secondary">Add a reading</Button>
				{/snippet}
			</EmptyState>
		{:else}
			<dl class="reading-grid">
				{#if data.health.measurements.bloodPressure}
					{@const bpLatest = data.health.measurements.bloodPressure}
					<div class="reading">
						<dt>Blood pressure</dt>
						<dd>
							{#if bpLatest.systolic !== null && bpLatest.diastolic !== null}
								{bpLatest.systolic}/{bpLatest.diastolic} mmHg
							{:else}
								{bpLatest.systolic ?? bpLatest.diastolic} mmHg
							{/if}
							<span class="reading-date">{shortDate(bpLatest.measuredAt)}</span>
						</dd>
					</div>
				{/if}
				{#if data.health.measurements.heartRate}
					{@const hr = data.health.measurements.heartRate}
					<div class="reading">
						<dt>Heart rate</dt>
						<dd>{hr.value} bpm <span class="reading-date">{shortDate(hr.measuredAt)}</span></dd>
					</div>
				{/if}
				{#if data.health.measurements.glucose}
					{@const glucose = data.health.measurements.glucose}
					<div class="reading">
						<dt>Glucose</dt>
						<dd>
							{glucose.value} <span class="reading-date">{shortDate(glucose.measuredAt)}</span>
						</dd>
					</div>
				{/if}
				{#if data.health.measurements.weight}
					{@const weight = data.health.measurements.weight}
					<div class="reading">
						<dt>Weight</dt>
						<dd>{weight.value} <span class="reading-date">{shortDate(weight.measuredAt)}</span></dd>
					</div>
				{/if}
				{#if data.health.measurements.qtInterval}
					{@const qt = data.health.measurements.qtInterval}
					<div class="reading">
						<dt>QT interval</dt>
						<dd>{qt.value} ms <span class="reading-date">{shortDate(qt.measuredAt)}</span></dd>
					</div>
				{/if}
			</dl>
			<div class="trend">
				<MeasurementChart
					title="Blood pressure trend"
					points={chartPoints}
					series={BP_SERIES}
					unit="mmHg"
				/>
			</div>
		{/if}
	</Card>

	<Card title="Labs">
		{#snippet actions()}
			<Button href="/health/labs" size="sm" variant="ghost">Open</Button>
		{/snippet}
		{#if data.health.labs.length === 0}
			<EmptyState
				title="No lab results yet"
				description="Markers and their reference ranges live here."
				icon="journal"
			>
				{#snippet action()}
					<Button href="/health/labs" size="sm" variant="secondary">Add a marker</Button>
				{/snippet}
			</EmptyState>
		{:else}
			<List label="Latest result per marker">
				{#each data.health.labs as item (item.markerId)}
					<ListRow
						title={item.markerName}
						meta={`${item.value}${item.units ? ` ${item.units}` : ''} · ${dayDate(item.resultDate)}`}
					>
						{#snippet trail()}
							<Badge tone={STATUS_TONE[item.status]}>{STATUS_LABEL[item.status]}</Badge>
						{/snippet}
					</ListRow>
				{/each}
			</List>
		{/if}
	</Card>

	<Card title="Visits">
		{#snippet actions()}
			<Button href="/health/visits" size="sm" variant="ghost">Open</Button>
		{/snippet}
		{#if !data.health.visits.mostRecent && !data.health.visits.next}
			<EmptyState title="Nothing scheduled" icon="check">
				{#snippet action()}
					<Button href="/health/visits" size="sm" variant="secondary">Add a visit</Button>
				{/snippet}
			</EmptyState>
		{:else}
			<ul class="visit-lines">
				{#if data.health.visits.next}
					<li>
						<span class="visit-label">Next</span>
						<span class="visit-reason">{data.health.visits.next.reason}</span>
						<span class="visit-when">{when(data.health.visits.next.visitAt)}</span>
					</li>
				{/if}
				{#if data.health.visits.mostRecent}
					<li>
						<span class="visit-label">Most recent</span>
						<span class="visit-reason">{data.health.visits.mostRecent.reason}</span>
						<span class="visit-when">{when(data.health.visits.mostRecent.visitAt)}</span>
					</li>
				{/if}
			</ul>
		{/if}
	</Card>

	<Card
		title="Symptoms & mood"
		subtitle={`${data.topSymptoms.length > 0 ? 'Most noticed lately' : 'Nothing logged yet'}`}
	>
		{#snippet actions()}
			<Button href="/health/symptoms" size="sm" variant="ghost">Open</Button>
		{/snippet}
		{#if data.topSymptoms.length === 0}
			<EmptyState
				title="Nothing logged yet"
				description="Symptoms and mood — tracked and counted over time."
				icon="journal"
			/>
		{:else}
			<ul class="symptom-lines">
				{#each data.topSymptoms as row (row.vocabularyId)}
					<li>
						<span class="symptom-name">{row.name}</span>
						<span class="symptom-days">{row.days} day{row.days === 1 ? '' : 's'}</span>
					</li>
				{/each}
			</ul>
		{/if}
	</Card>
</div>

<section class="vitals-section" aria-labelledby="vitals-heading">
	<h2 id="vitals-heading" class="section-title">Recent readings</h2>
	<Card flush>
		{#if vitalsRows.length === 0}
			<EmptyState
				title="No readings recorded"
				description="Add a blood pressure, heart rate or glucose reading under Measurements and it shows up here, a row per day."
				icon="today"
			>
				{#snippet action()}
					<Button href="/health/measurements" size="sm" icon="plus">Add a reading</Button>
				{/snippet}
			</EmptyState>
		{:else}
			<div class="scroll">
				<table>
					<caption class="visually-hidden">Recent daily readings</caption>
					<thead>
						<tr>
							<th scope="col">Day</th>
							<th scope="col">BP</th>
							<th scope="col">HR</th>
							<th scope="col">Sleep</th>
							<th scope="col">Water</th>
						</tr>
					</thead>
					<tbody>
						{#each vitalsRows as v (v.onDate)}
							<tr>
								<th scope="row">{v.onDate}</th>
								<td>{bp(v) ?? '—'}</td>
								<td>{v.heartRate ?? '—'}</td>
								<td>{v.sleepScore ?? '—'}</td>
								<td>{v.water ?? '—'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<p class="table-foot">
				<a href={resolve(appPath('/health/measurements'))}>Add a reading</a>
			</p>
		{/if}
	</Card>
</section>

<style>
	.hub-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
		gap: var(--sp-5);
		align-items: start;
		margin-bottom: var(--sp-6);
	}

	.med-groups {
		display: flex;
		flex-direction: column;
		gap: var(--sp-3);
	}
	.group-label {
		margin: 0 0 var(--sp-1);
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
		font-weight: 650;
		text-transform: uppercase;
		letter-spacing: 0.02em;
	}
	.med-list {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.med-list :global(li + li) {
		border-top: 1px solid var(--c-border);
	}

	.reading-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
		gap: var(--sp-3);
		margin: 0 0 var(--sp-4);
	}
	.reading dt {
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
	}
	.reading dd {
		margin: 0.15rem 0 0;
		font-size: var(--fs-md);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.reading-date {
		margin-left: var(--sp-1);
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
		font-weight: 400;
	}
	.trend {
		padding-top: var(--sp-3);
		border-top: 1px solid var(--c-border);
	}

	.visit-lines,
	.symptom-lines {
		display: flex;
		flex-direction: column;
		gap: var(--sp-3);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.visit-lines li {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}
	.visit-label {
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
		text-transform: uppercase;
		letter-spacing: 0.02em;
	}
	.visit-reason {
		font-weight: 600;
	}
	.visit-when {
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}

	.symptom-lines li {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--sp-2);
		font-size: var(--fs-sm);
	}
	.symptom-days {
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
		font-variant-numeric: tabular-nums;
	}

	.section-title {
		margin: 0 0 var(--sp-3);
		font-size: var(--fs-lg);
		font-weight: 650;
	}

	.scroll {
		overflow-x: auto;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--fs-sm);
	}
	th,
	td {
		padding: var(--sp-2) var(--sp-3);
		text-align: right;
		white-space: nowrap;
	}
	thead th {
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
		font-weight: 600;
	}
	th[scope='row'],
	thead th:first-child {
		text-align: left;
	}
	td {
		font-variant-numeric: tabular-nums;
	}
	tbody tr + tr th,
	tbody tr + tr td {
		border-top: 1px solid var(--c-border);
	}
	.table-foot {
		margin: 0;
		padding: 0 var(--sp-3);
		border-top: 1px solid var(--c-border);
		font-size: var(--fs-sm);
	}
	/* A thumb-sized target, not just the height of a line of small text. */
	.table-foot a {
		display: inline-flex;
		align-items: center;
		min-height: var(--tap);
	}

	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
</style>
