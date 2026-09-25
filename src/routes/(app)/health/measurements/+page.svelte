<script lang="ts">
	import { enhance } from '$app/forms';
	import {
		Button,
		Card,
		EmptyState,
		Field,
		Input,
		List,
		ListRow,
		PageHeader,
		Sheet,
		Textarea
	} from '$lib/components';
	import type { ChartSeries } from './chart';
	import { summaryOf } from './format';
	import MeasurementChart from './MeasurementChart.svelte';

	let { data, form } = $props();

	type Reading = (typeof data.readings)[number];

	let addFormEl = $state<HTMLFormElement>();
	let editing = $state<Reading | null>(null);
	let editOpen = $state(false);

	function startEdit(reading: Reading) {
		editing = reading;
		editOpen = true;
	}

	const displayDate = (d: Date) =>
		d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

	// Oldest first for the charts — a trend reads left to right — while the
	// list above stays most-recent-first, which is what "recent" means there.
	const chartPoints = $derived(
		[...data.readings].reverse().map((r) => ({
			at: r.measuredAt.toISOString(),
			values: {
				systolic: r.systolic,
				diastolic: r.diastolic,
				heartRate: r.heartRate,
				glucose: r.glucose,
				weight: r.weight
			}
		}))
	);

	const BP_SERIES: ChartSeries[] = [
		{ key: 'systolic', label: 'Systolic', color: 'var(--c-accent)' },
		{ key: 'diastolic', label: 'Diastolic', color: 'var(--c-text-muted)', dashed: true }
	];
	const HR_SERIES: ChartSeries[] = [
		{ key: 'heartRate', label: 'Heart rate', color: 'var(--c-accent)' }
	];
	const WEIGHT_SERIES: ChartSeries[] = [
		{ key: 'weight', label: 'Weight', color: 'var(--c-accent)' }
	];
	const GLUCOSE_SERIES: ChartSeries[] = [
		{ key: 'glucose', label: 'Glucose', color: 'var(--c-accent)' }
	];
</script>

<svelte:head><title>Health Measurements · LifeOS</title></svelte:head>

<PageHeader
	title="Health Measurements"
	description="Blood pressure, heart rate, glucose, weight and QT interval, in one place."
	back={{ href: '/health', label: 'Health & Fitness' }}
/>

<div class="stack">
	<section aria-labelledby="add-heading">
		<h2 id="add-heading" class="section-title">Add a reading</h2>
		<Card>
			{#if form?.action === 'create' && form.error}
				<p class="notice error" role="alert">{form.error}</p>
			{/if}
			<form
				bind:this={addFormEl}
				method="POST"
				action="?/create"
				use:enhance={() => {
					return async ({ result, update }) => {
						await update();
						if (result.type === 'success') addFormEl?.reset();
					};
				}}
			>
				<div class="grid">
					<Field label="Date and time" required>
						{#snippet children(field)}
							<input
								id={field.id}
								type="datetime-local"
								name="measuredAt"
								required
								value={data.defaultMeasuredAt}
								aria-describedby={field.describedBy}
								aria-invalid={field.invalid || undefined}
							/>
						{/snippet}
					</Field>
					<Input
						label="Systolic"
						name="systolic"
						type="number"
						inputmode="numeric"
						min="40"
						max="300"
						hint="mmHg"
					/>
					<Input
						label="Diastolic"
						name="diastolic"
						type="number"
						inputmode="numeric"
						min="20"
						max="200"
						hint="mmHg"
					/>
					<Input label="BP context" name="bpContext" placeholder="Resting, after exercise…" />
					<Input
						label="Heart rate"
						name="heartRate"
						type="number"
						inputmode="numeric"
						min="20"
						max="250"
						hint="bpm"
					/>
					<Input
						label="Blood glucose"
						name="glucose"
						type="number"
						inputmode="decimal"
						step="0.1"
						min="0"
					/>
					<Input label="Glucose context" name="glucoseContext" placeholder="Fasting, post-meal…" />
					<Input
						label="Weight"
						name="weight"
						type="number"
						inputmode="decimal"
						step="0.1"
						min="0"
					/>
					<Input
						label="QT interval"
						name="qtInterval"
						type="number"
						inputmode="numeric"
						min="200"
						max="800"
						hint="ms"
					/>
				</div>
				<Textarea label="Notes" name="notes" rows={2} hint="Optional." />
				<div class="actions">
					<Button type="submit" variant="primary">Save reading</Button>
				</div>
			</form>
		</Card>
	</section>

	<section aria-labelledby="charts-heading">
		<h2 id="charts-heading" class="section-title">Trends</h2>
		<Card flush>
			<div class="charts">
				<MeasurementChart
					title="Blood pressure"
					points={chartPoints}
					series={BP_SERIES}
					unit="mmHg"
				/>
				<MeasurementChart title="Heart rate" points={chartPoints} series={HR_SERIES} unit="bpm" />
				<MeasurementChart title="Weight" points={chartPoints} series={WEIGHT_SERIES} />
				<MeasurementChart title="Glucose" points={chartPoints} series={GLUCOSE_SERIES} />
			</div>
		</Card>
	</section>

	<section aria-labelledby="recent-heading">
		<h2 id="recent-heading" class="section-title">Recent readings</h2>
		<Card flush>
			{#if form?.action === 'delete' && form.error}
				<p class="notice error" role="alert">{form.error}</p>
			{/if}
			{#if data.readings.length === 0}
				<EmptyState
					title="No readings recorded"
					description="Add a reading above and it will show up here and in the charts."
					icon="today"
				/>
			{:else}
				<List label="Recent readings">
					{#each data.readings as r (r.id)}
						<ListRow title={displayDate(r.measuredAt)} meta={summaryOf(r)}>
							{#snippet trail()}
								<div class="row-actions">
									<Button size="sm" variant="ghost" onclick={() => startEdit(r)}>Edit</Button>
									<form method="POST" action="?/delete" use:enhance>
										<input type="hidden" name="id" value={r.id} />
										<Button
											type="submit"
											size="sm"
											variant="ghost"
											aria-label={`Delete the reading from ${displayDate(r.measuredAt)}`}
										>
											Delete
										</Button>
									</form>
								</div>
							{/snippet}
							{#if r.notes}<p class="row-notes">{r.notes}</p>{/if}
						</ListRow>
					{/each}
				</List>
			{/if}
		</Card>
	</section>
</div>

<Sheet bind:open={editOpen} title="Edit reading">
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

			{#if form?.action === 'update' && form.error}
				<p class="notice error" role="alert">{form.error}</p>
			{/if}

			<div class="grid">
				<Field label="Date and time" required>
					{#snippet children(field)}
						<input
							id={field.id}
							type="datetime-local"
							name="measuredAt"
							required
							value={e.measuredAtLocal}
							aria-describedby={field.describedBy}
							aria-invalid={field.invalid || undefined}
						/>
					{/snippet}
				</Field>
				<Input
					label="Systolic"
					name="systolic"
					type="number"
					inputmode="numeric"
					min="40"
					max="300"
					hint="mmHg"
					value={e.systolic?.toString() ?? ''}
				/>
				<Input
					label="Diastolic"
					name="diastolic"
					type="number"
					inputmode="numeric"
					min="20"
					max="200"
					hint="mmHg"
					value={e.diastolic?.toString() ?? ''}
				/>
				<Input label="BP context" name="bpContext" value={e.bpContext ?? ''} />
				<Input
					label="Heart rate"
					name="heartRate"
					type="number"
					inputmode="numeric"
					min="20"
					max="250"
					hint="bpm"
					value={e.heartRate?.toString() ?? ''}
				/>
				<Input
					label="Blood glucose"
					name="glucose"
					type="number"
					inputmode="decimal"
					step="0.1"
					min="0"
					value={e.glucose?.toString() ?? ''}
				/>
				<Input label="Glucose context" name="glucoseContext" value={e.glucoseContext ?? ''} />
				<Input
					label="Weight"
					name="weight"
					type="number"
					inputmode="decimal"
					step="0.1"
					min="0"
					value={e.weight?.toString() ?? ''}
				/>
				<Input
					label="QT interval"
					name="qtInterval"
					type="number"
					inputmode="numeric"
					min="200"
					max="800"
					hint="ms"
					value={e.qtInterval?.toString() ?? ''}
				/>
			</div>
			<Textarea label="Notes" name="notes" rows={2} value={e.notes ?? ''} />

			<div class="actions">
				<Button variant="ghost" type="button" onclick={() => (editOpen = false)}>Cancel</Button>
				<Button type="submit" variant="primary">Save changes</Button>
			</div>
		</form>
	{/if}
</Sheet>

<style>
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-6);
	}

	.section-title {
		margin: 0 0 var(--sp-3);
		font-size: var(--fs-lg);
		font-weight: 650;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
		gap: var(--sp-3);
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--sp-2);
	}

	.charts {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
		gap: var(--sp-5);
		padding: var(--sp-4);
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

	.notice {
		padding: var(--sp-2) var(--sp-3);
		border-radius: var(--radius-sm);
		margin: 0 0 var(--sp-3);
	}
	.notice.error {
		color: var(--c-crit);
		border: 1px solid color-mix(in srgb, var(--c-crit) 25%, transparent);
		background: color-mix(in srgb, var(--c-crit) 8%, transparent);
	}
</style>
