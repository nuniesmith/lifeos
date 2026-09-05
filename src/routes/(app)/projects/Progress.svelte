<script lang="ts">
	// The type only: this component renders in the browser and planning.ts
	// reaches into $lib/server, so the import has to erase before bundling.
	import type { TaskProgress } from './planning';

	interface Props {
		progress: TaskProgress;
		/**
		 * What the bar is measuring, for the accessible name — "Kitchen" reads
		 * far better than five identical "progress" bars down a list.
		 */
		of: string;
		/** Hides the figures when the surrounding row already says them. */
		barOnly?: boolean;
	}

	let { progress, of, barOnly = false }: Props = $props();
</script>

{#if progress.total === 0}
	{#if !barOnly}<p class="figures muted">No tasks yet</p>{/if}
{:else}
	<div class="progress">
		<!--
			A real progressbar role rather than a decorated div: a screen reader
			then announces "40%" instead of reading a stray number out of the
			middle of a list. The percentage is derived from the task counts on
			every request, so it cannot disagree with the figures beside it.
		-->
		<div
			class="track"
			role="progressbar"
			aria-valuenow={progress.percent}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-label="{of}: {progress.closed} of {progress.total} tasks closed"
		>
			<span class="fill" style:width="{progress.percent}%"></span>
		</div>
		{#if !barOnly}
			<p class="figures numeric">
				{progress.closed} of {progress.total} closed
				{#if progress.overdue > 0}
					<span class="overdue">· {progress.overdue} overdue</span>
				{/if}
			</p>
		{/if}
	</div>
{/if}

<style>
	.progress {
		display: flex;
		flex-direction: column;
		gap: var(--sp-1);
		min-width: 0;
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

	.figures {
		margin: 0;
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
	}

	.muted {
		color: var(--c-text-muted);
	}

	.overdue {
		color: var(--c-crit);
	}
</style>
