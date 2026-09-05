<script lang="ts">
	import { applyAction, enhance } from '$app/forms';
	let { form } = $props();
	let submitting = $state(false);
</script>

<svelte:head><title>Sign in · LifeOS</title></svelte:head>

<h1>Sign in</h1>

{#if form?.error}
	<p class="error" role="alert">{form.error}</p>
{/if}

<form
	method="POST"
	use:enhance={() => {
		submitting = true;
		// applyAction, not update(): a successful sign-in returns a redirect
		// result, and update() re-renders the page instead of following it —
		// which left the browser sitting on /login after a valid login while
		// the server had already created the session.
		return async ({ result }) => {
			submitting = false;
			await applyAction(result);
		};
	}}
>
	<label for="username">Username</label>
	<input
		id="username"
		name="username"
		autocomplete="username"
		required
		value={form?.username ?? ''}
	/>

	<label for="password">Password</label>
	<input id="password" name="password" type="password" autocomplete="current-password" required />

	<button type="submit" disabled={submitting}>{submitting ? 'Signing in…' : 'Sign in'}</button>
</form>

<style>
	form {
		display: flex;
		flex-direction: column;
		gap: var(--sp-2);
		max-width: 22rem;
	}
	label {
		font-size: var(--fs-sm);
		color: var(--c-text-muted);
		margin-top: var(--sp-2);
	}
	input {
		padding: var(--sp-2) var(--sp-3);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-sm);
		background: var(--c-surface);
	}
	button {
		margin-top: var(--sp-4);
		padding: var(--sp-2) var(--sp-4);
		border: none;
		border-radius: var(--radius-sm);
		background: var(--c-accent);
		color: var(--c-accent-text);
		font-weight: 600;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.6;
		cursor: progress;
	}
	.error {
		color: var(--c-crit);
		background: color-mix(in srgb, var(--c-crit) 8%, transparent);
		border: 1px solid color-mix(in srgb, var(--c-crit) 25%, transparent);
		border-radius: var(--radius-sm);
		padding: var(--sp-2) var(--sp-3);
		max-width: 22rem;
	}
</style>
