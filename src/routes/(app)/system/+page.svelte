<script lang="ts">
	import { Badge, Card, EmptyState, List, ListRow, PageHeader } from '$lib/components';

	let { data } = $props();

	type Status = 'ok' | 'degraded' | 'fail';

	const TONES: Record<Status, 'ok' | 'warn' | 'crit'> = {
		ok: 'ok',
		degraded: 'warn',
		fail: 'crit'
	};

	const OVERALL: Record<Status, string> = {
		ok: 'Everything is healthy',
		degraded: 'Running, with something to look at',
		fail: 'Something is broken'
	};

	const when = (date: Date | null): string =>
		date
			? date.toLocaleString(undefined, {
					day: 'numeric',
					month: 'short',
					year: 'numeric',
					hour: '2-digit',
					minute: '2-digit'
				})
			: '—';

	/** "36h ago" is the number the backup check itself thresholds on. */
	function ago(date: Date): string {
		const hours = Math.round((Date.now() - date.getTime()) / 3_600_000);
		if (hours < 1) return 'just now';
		if (hours < 48) return `${hours}h ago`;
		return `${Math.round(hours / 24)}d ago`;
	}

	/** The row counts, as a single readable line rather than a table. */
	const total = $derived(data.counts.reduce((sum, c) => sum + c.total, 0));
</script>

<svelte:head><title>System · LifeOS</title></svelte:head>

<PageHeader title="System" description="What this install is doing, and whether it is well.">
	{#snippet meta()}
		<span>{OVERALL[data.health.status as Status]}</span>
	{/snippet}
</PageHeader>

<div class="stack">
	<section aria-labelledby="health-heading">
		<h2 id="health-heading" class="section-title">Health</h2>
		<Card flush>
			<List label="Readiness checks">
				{#each data.health.checks as check (check.name)}
					<ListRow title={check.name} meta={check.detail ?? undefined}>
						{#snippet trail()}
							<Badge tone={TONES[check.status as Status]} dot>{check.status}</Badge>
						{/snippet}
					</ListRow>
				{/each}
			</List>
		</Card>
	</section>

	<section aria-labelledby="backups-heading">
		<h2 id="backups-heading" class="section-title">Backups</h2>
		<Card flush>
			{#if data.backups.length === 0}
				<EmptyState
					title="No backup has been recorded"
					description="Readiness reports this as degraded until the first one runs. A backup that is never recorded cannot be alerted on."
					icon="alert"
				/>
			{:else}
				<List label="Recent backups">
					{#each data.backups as backup, i (backup.startedAt.toISOString() + i)}
						<ListRow
							title={`${backup.kind} backup`}
							meta={`${when(backup.startedAt)} · ${ago(backup.startedAt)}`}
						>
							{#snippet trail()}
								<Badge tone={backup.status === 'success' ? 'ok' : 'crit'} dot>
									{backup.status}
								</Badge>
							{/snippet}
						</ListRow>
					{/each}
				</List>
			{/if}
		</Card>
	</section>

	<section aria-labelledby="imports-heading">
		<h2 id="imports-heading" class="section-title">Imports</h2>
		<Card flush>
			{#if data.imports.length === 0}
				<EmptyState
					title="Nothing has been imported"
					description="The Notion import is an operator command, not a page: run scripts/import.mjs on the server."
					icon="projects"
				/>
			{:else}
				<List label="Recent imports">
					{#each data.imports as run (run.id)}
						<ListRow
							title={when(run.startedAt)}
							meta={run.summary
								? `${run.summary.rows ?? 0} rows · ${run.summary.databases ?? 0} databases`
								: undefined}
						>
							{#snippet trail()}
								<Badge tone={run.status === 'success' ? 'ok' : 'warn'} dot>{run.status}</Badge>
							{/snippet}
						</ListRow>
					{/each}
				</List>
			{/if}
		</Card>
	</section>

	<section aria-labelledby="data-heading">
		<h2 id="data-heading" class="section-title">What is in here</h2>
		<Card>
			<ul class="counts">
				{#each data.counts as count (count.table)}
					<li>
						<span class="count">{count.total}</span>
						<span class="what">{count.table.replace(/_/g, ' ')}</span>
					</li>
				{/each}
			</ul>
			<p class="footnote">{total} rows across the domain tables.</p>
		</Card>
	</section>

	<section aria-labelledby="migrations-heading">
		<h2 id="migrations-heading" class="section-title">Schema</h2>
		<Card flush>
			<List label="Applied migrations">
				{#each data.migrations as migration (migration.name)}
					<ListRow
						title={migration.name}
						meta={`${when(migration.appliedAt)} · ${migration.durationMs}ms`}
					/>
				{/each}
			</List>
		</Card>
	</section>
</div>

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

	.counts {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
		gap: var(--sp-4);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.counts li {
		display: grid;
		gap: 0.1rem;
	}
	.count {
		font-size: var(--fs-xl);
		font-weight: 650;
		font-variant-numeric: tabular-nums;
	}
	.what {
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}

	.footnote {
		margin: var(--sp-4) 0 0;
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
	}
</style>
