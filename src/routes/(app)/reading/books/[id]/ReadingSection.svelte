<script module lang="ts">
	import type { BookFormat } from '$lib/server/repositories';

	/** What this section needs of the viewer's own open read — a plain shape
	 *  so it does not have to import the full server-side read type. */
	export interface ActiveReadInfo {
		id: string;
		status: 'reading' | 'paused';
		format: BookFormat | null;
		progressPages: number | null;
		progressMinutes: number | null;
		updatedAt: Date;
	}
</script>

<script lang="ts">
	import { enhance } from '$app/forms';
	import { Badge, Button, Card, Input, Select, Textarea } from '$lib/components';
	import { FORMAT_LABELS, RATING_OPTIONS } from '../form';

	/**
	 * Start/keep-moving/finish a read (Reading Tracker R2). Shows either a
	 * plain "Start reading" button, or, while the viewer has an open read on
	 * this book, its progress plus Pause/Resume/Finish/DNF — never both: at
	 * most one open read per book per reader (migration 0033's partial unique
	 * index) is what `activeRead` being null or not already tells us.
	 */
	interface Props {
		pages: number | null;
		audiobookMinutes: number | null;
		activeRead: ActiveReadInfo | null;
		readCount: number;
		today: string;
	}
	let { pages, audiobookMinutes, activeRead, readCount, today }: Props = $props();

	const formatOptions = Object.entries(FORMAT_LABELS).map(([value, label]) => ({ value, label }));

	// An audiobook is tracked in minutes; everything else (including no
	// format at all) in pages — the common case, and the one the book's own
	// `pages` column is likelier to know.
	const tracksMinutes = $derived(activeRead?.format === 'audiobook');
	const progressTotal = $derived(tracksMinutes ? audiobookMinutes : pages);
	const progressValue = $derived(
		(tracksMinutes ? activeRead?.progressMinutes : activeRead?.progressPages) ?? null
	);
	const progressPercent = $derived(
		progressTotal && progressValue !== null
			? Math.max(0, Math.min(100, Math.round((progressValue / progressTotal) * 100)))
			: null
	);

	let startError = $state<string | undefined>();
	let progressError = $state<string | undefined>();
	let pauseError = $state<string | undefined>();
	let finishError = $state<string | undefined>();
	let dnfError = $state<string | undefined>();
	let showFinish = $state(false);
	let showDnf = $state(false);

	// Closing the finish/dnf panels whenever the active read itself changes
	// (a fresh start, or a pause/resume) — never leaves a stale panel open
	// under a read it was not opened for.
	$effect(() => {
		void activeRead?.id;
		showFinish = false;
		showDnf = false;
	});
</script>

<Card title="Reading">
	{#if readCount > 0}
		<p class="read-count">Read {readCount} time{readCount === 1 ? '' : 's'}.</p>
	{/if}

	{#if !activeRead}
		{#if startError}<p class="notice error" role="alert">{startError}</p>{/if}
		<form
			method="POST"
			action="?/start"
			class="start-form"
			use:enhance={() => {
				startError = undefined;
				return async ({ result, update }) => {
					await update({ reset: false });
					if (result.type === 'failure') {
						const said = result.data?.error;
						startError = typeof said === 'string' ? said : 'Could not start a read.';
					}
				};
			}}
		>
			<div class="row">
				<Select
					label="Format"
					name="format"
					options={formatOptions}
					placeholder={readCount > 0 ? 'Same as last time' : "Same as the book's own"}
				/>
			</div>
			<Button type="submit" variant="primary">Start reading</Button>
		</form>
	{:else}
		<div class="active">
			<Badge tone="accent">{activeRead.status === 'paused' ? 'Paused' : 'Reading'}</Badge>

			{#if progressError}<p class="notice error" role="alert">{progressError}</p>{/if}
			<form
				method="POST"
				action="?/progress"
				class="progress-form"
				use:enhance={() => {
					progressError = undefined;
					return async ({ result, update }) => {
						await update({ reset: false });
						if (result.type === 'failure') {
							const said = result.data?.error;
							progressError = typeof said === 'string' ? said : 'Could not save progress.';
						}
					};
				}}
			>
				<input type="hidden" name="readId" value={activeRead.id} />
				<input type="hidden" name="updatedAt" value={activeRead.updatedAt.toISOString()} />
				{#if progressPercent !== null}
					<div
						class="track"
						role="progressbar"
						aria-valuenow={progressPercent}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-label="Progress: {progressValue} of {progressTotal} {tracksMinutes
							? 'minutes'
							: 'pages'}"
					>
						<span class="fill" style:width="{progressPercent}%"></span>
					</div>
				{/if}
				<div class="row">
					{#if tracksMinutes}
						<Input
							label="Minutes listened"
							name="progressMinutes"
							type="number"
							inputmode="numeric"
							min="0"
							value={activeRead.progressMinutes?.toString() ?? ''}
							hint={progressTotal ? `of ${progressTotal} minutes` : undefined}
						/>
					{:else}
						<Input
							label="Pages read"
							name="progressPages"
							type="number"
							inputmode="numeric"
							min="0"
							value={activeRead.progressPages?.toString() ?? ''}
							hint={progressTotal ? `of ${progressTotal} pages` : undefined}
						/>
					{/if}
					<div class="progress-save"><Button type="submit" size="sm">Save progress</Button></div>
				</div>
			</form>

			{#if pauseError}<p class="notice error" role="alert">{pauseError}</p>{/if}
			<div class="row actions">
				<form
					method="POST"
					action={activeRead.status === 'paused' ? '?/resume' : '?/pause'}
					use:enhance={() => {
						pauseError = undefined;
						return async ({ result, update }) => {
							await update({ reset: false });
							if (result.type === 'failure') {
								const said = result.data?.error;
								pauseError = typeof said === 'string' ? said : 'Could not save that.';
							}
						};
					}}
				>
					<input type="hidden" name="readId" value={activeRead.id} />
					<input type="hidden" name="updatedAt" value={activeRead.updatedAt.toISOString()} />
					<Button type="submit" variant="secondary">
						{activeRead.status === 'paused' ? 'Resume' : 'Pause'}
					</Button>
				</form>
				<Button
					type="button"
					variant="secondary"
					onclick={() => {
						showFinish = !showFinish;
						showDnf = false;
					}}
				>
					Finish
				</Button>
				<Button
					type="button"
					variant="ghost"
					onclick={() => {
						showDnf = !showDnf;
						showFinish = false;
					}}
				>
					DNF
				</Button>
			</div>

			{#if showFinish}
				<form
					method="POST"
					action="?/finish"
					class="sub-form"
					use:enhance={() => {
						finishError = undefined;
						return async ({ result, update }) => {
							await update({ reset: false });
							if (result.type === 'failure') {
								const said = result.data?.error;
								finishError = typeof said === 'string' ? said : 'Could not finish that read.';
							}
						};
					}}
				>
					<input type="hidden" name="readId" value={activeRead.id} />
					<input type="hidden" name="updatedAt" value={activeRead.updatedAt.toISOString()} />
					{#if finishError}<p class="notice error" role="alert">{finishError}</p>{/if}
					<div class="row">
						<Input label="Finished on" name="finishedOn" type="date" value={today} />
						<Select
							label="Rating for this read"
							name="rating"
							options={RATING_OPTIONS}
							placeholder="Not rated"
						/>
					</div>
					<Textarea label="Review" name="review" rows={3} hint="Markdown works." />
					<Button type="submit" variant="primary">Finish reading</Button>
				</form>
			{/if}

			{#if showDnf}
				<form
					method="POST"
					action="?/dnf"
					class="sub-form"
					use:enhance={() => {
						dnfError = undefined;
						return async ({ result, update }) => {
							await update({ reset: false });
							if (result.type === 'failure') {
								const said = result.data?.error;
								dnfError = typeof said === 'string' ? said : 'Could not save that.';
							}
						};
					}}
				>
					<input type="hidden" name="readId" value={activeRead.id} />
					<input type="hidden" name="updatedAt" value={activeRead.updatedAt.toISOString()} />
					{#if dnfError}<p class="notice error" role="alert">{dnfError}</p>{/if}
					<Textarea label="Why did you stop? (optional)" name="reason" rows={2} />
					<Button type="submit" variant="danger">Mark as DNF</Button>
				</form>
			{/if}
		</div>
	{/if}
</Card>

<style>
	.read-count {
		margin: 0 0 var(--sp-3);
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}
	.start-form,
	.sub-form {
		display: flex;
		flex-direction: column;
		gap: var(--sp-3);
	}
	.sub-form {
		margin-top: var(--sp-3);
		padding-top: var(--sp-3);
		border-top: 1px solid var(--c-border);
	}
	.active {
		display: flex;
		flex-direction: column;
		gap: var(--sp-3);
	}
	.progress-form {
		display: flex;
		flex-direction: column;
		gap: var(--sp-2);
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: var(--sp-3);
	}
	.row.actions {
		align-items: center;
	}
	.progress-save {
		padding-bottom: 2px;
	}
	.track {
		height: 6px;
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
