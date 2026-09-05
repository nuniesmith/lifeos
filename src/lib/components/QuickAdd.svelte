<script lang="ts">
	import Button from './Button.svelte';
	import ErrorState from './ErrorState.svelte';
	import Field from './Field.svelte';
	import Icon from './Icon.svelte';
	import Select from './Select.svelte';
	import Sheet from './Sheet.svelte';
	import Textarea from './Textarea.svelte';

	interface Props {
		/** Bindable so the sidebar's own "Quick add" can open the same sheet. */
		open?: boolean;
		/**
		 * The capture endpoint. Overridable mainly so a test can point it
		 * server-side validation; this component only needs somewhere to POST
		 * so the interaction can be exercised end to end. Change the default
		 * rather than every caller when that lands.
		 */
		endpoint?: string;
	}

	let { open = $bindable(false), endpoint = '/api/quick-add' }: Props = $props();

	const KINDS = [
		{ value: 'task', label: 'Task' },
		{ value: 'note', label: 'Note' },
		{ value: 'journal', label: 'Journal entry' }
		// No habit check-in here: it needs a specific habit and this box has no
		// picker, so the option could only ever fail. Habits are one tap away
		// on Today.
	];

	let kind = $state('task');
	let title = $state('');
	let detail = $state('');
	let saving = $state(false);
	let error = $state<string | undefined>();
	let titleEl = $state<HTMLInputElement>();

	/**
	 * Focus the text box as the sheet opens.
	 *
	 * Without this the phone keyboard does not appear until a second tap, and
	 * "one thumb, no thinking" is the whole point of the control. `autofocus`
	 * is not used: it moves focus on page load too, which is exactly the
	 * behaviour that makes it an accessibility problem.
	 */
	$effect(() => {
		if (open) titleEl?.focus();
	});

	function reset() {
		title = '';
		detail = '';
		error = undefined;
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!title.trim() || saving) return;

		saving = true;
		error = undefined;
		try {
			const response = await fetch(endpoint, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ kind, title: title.trim(), detail: detail.trim() || null })
			});

			if (response.ok) {
				reset();
				open = false;
				return;
			}

			// The endpoint's own message when it has one; it explains a
			// conflict better than a status code can.
			const said = await response
				.json()
				.then((b: { error?: string }) => b?.error)
				.catch(() => undefined);
			error = said ?? `The server refused that (${response.status}). Nothing was saved.`;
		} catch {
			error = 'Could not reach the server. Nothing was saved.';
		} finally {
			saving = false;
		}
	}
</script>

<!--
	The floating action button. Bottom right, above the navigation bar and
	inside the thumb arc of a one-handed grip — the single most-used control
	in the app should not be at the top of the screen. Hidden on wide
	viewports, where SideNav carries the same action.
-->
<button type="button" class="fab" onclick={() => (open = true)}>
	<Icon name="plus" size={26} />
	<span class="sr-only">Quick add</span>
</button>

<Sheet bind:open title="Quick add">
	<form onsubmit={submit}>
		<Field label="What?" required>
			{#snippet children(field)}
				<input
					bind:this={titleEl}
					bind:value={title}
					id={field.id}
					type="text"
					required
					enterkeyhint="done"
					autocomplete="off"
					placeholder="Book the vet"
					aria-describedby={field.describedBy}
				/>
			{/snippet}
		</Field>

		<Select label="Add as" options={KINDS} bind:value={kind} />

		<Textarea label="Details" bind:value={detail} rows={3} hint="Optional." />

		{#if error}
			<ErrorState title="Not saved" message={error} />
		{/if}

		<div class="actions">
			<Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
			<Button type="submit" variant="primary" loading={saving} disabled={!title.trim()}>
				Save
			</Button>
		</div>
	</form>
</Sheet>

<style>
	.fab {
		position: fixed;
		right: var(--sp-4);
		bottom: calc(var(--nav-h) + env(safe-area-inset-bottom) + var(--sp-3));
		z-index: var(--z-float);
		display: grid;
		place-items: center;
		width: 3.5rem;
		height: 3.5rem;
		border: none;
		border-radius: 50%;
		background: var(--c-accent);
		color: var(--c-accent-text);
		box-shadow: var(--shadow-lg);
		cursor: pointer;
	}

	@media (min-width: 48rem) {
		.fab {
			display: none;
		}
	}

	form {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--sp-2);
	}
</style>
