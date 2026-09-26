<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { Badge, appPath } from '$lib/components';
	import type { DueMedication } from '$lib/server/repositories';

	/**
	 * One due-today medication with its one-tap toggle, shared by the
	 * `/health` overview card and the Today page's health panel.
	 *
	 * Posts straight to the medications page's own `toggleDose` action rather
	 * than a copy of it — an absolute action works from any page, and
	 * `use:enhance`'s default behaviour (apply the result, re-run this page's
	 * own `load`) is exactly "flip the tick and show the new state", the same
	 * as tapping it on `/health/medications` itself.
	 */
	interface Props {
		medication: DueMedication;
		/** Show the "running low" flag. The overview card wants it; the
		 *  compact Today panel does not have room and skips it. */
		showRunningLow?: boolean;
	}

	let { medication, showRunningLow = false }: Props = $props();

	const meta = $derived(
		[medication.dose, medication.unit].filter(Boolean).join(' ') || medication.brand || null
	);
</script>

<li class="row">
	<form method="POST" action={`${resolve(appPath('/health/medications'))}?/toggleDose`} use:enhance>
		<input type="hidden" name="medicationId" value={medication.id} />
		<input type="hidden" name="taken" value={medication.takenToday ? 'false' : 'true'} />
		<button
			type="submit"
			class="dose-toggle"
			class:done={medication.takenToday}
			aria-pressed={medication.takenToday}
			aria-label={`${medication.takenToday ? 'Undo' : 'Mark'} ${medication.name} taken today`}
		>
			{#if medication.takenToday}
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
	<span class="body">
		<span class="name" class:done={medication.takenToday}>{medication.name}</span>
		{#if meta}<span class="meta">{meta}</span>{/if}
	</span>
	{#if showRunningLow && medication.runningLow}<Badge tone="warn">Running low</Badge>{/if}
</li>

<style>
	.row {
		display: flex;
		align-items: center;
		gap: var(--sp-3);
		padding: var(--sp-2) 0;
	}

	.dose-toggle {
		display: grid;
		place-items: center;
		flex: none;
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

	.body {
		display: flex;
		flex-direction: column;
		flex: 1 1 auto;
		gap: 0.1rem;
		min-width: 0;
	}
	.name {
		font-size: var(--fs-sm);
		font-weight: 550;
	}
	.name.done {
		color: var(--c-text-muted);
		text-decoration: line-through;
	}
	.meta {
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
	}
</style>
