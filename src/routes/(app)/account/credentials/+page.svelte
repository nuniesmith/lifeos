<script lang="ts">
	let { data, form } = $props();
</script>

<svelte:head><title>Change credentials · LifeOS</title></svelte:head>

<h1>{data.mustChange ? 'Set your credentials' : 'Change your password'}</h1>

{#if data.mustChange}
	<p class="lede">
		{#if data.isBootstrap}
			This is the one-time administrator account. Choose a username and password to finish setting
			up LifeOS — the temporary credential stops working once you do.
		{:else}
			Choose a new password to continue.
		{/if}
		Every other signed-in session will be signed out.
	</p>
{/if}

{#if form?.error}
	<p class="error" role="alert">{form.error}</p>
{/if}

<form method="POST">
	<label for="newUsername">Username</label>
	<input id="newUsername" name="newUsername" autocomplete="username" value={data.username} />

	<label for="currentPassword">Current password</label>
	<input
		id="currentPassword"
		name="currentPassword"
		type="password"
		autocomplete="current-password"
		required
	/>

	<label for="newPassword">New password</label>
	<input
		id="newPassword"
		name="newPassword"
		type="password"
		autocomplete="new-password"
		minlength="12"
		required
	/>
	<span class="hint">At least 12 characters.</span>

	<label for="confirmPassword">Confirm new password</label>
	<input
		id="confirmPassword"
		name="confirmPassword"
		type="password"
		autocomplete="new-password"
		minlength="12"
		required
	/>

	<button type="submit">Save and continue</button>
</form>

<style>
	.lede {
		color: var(--c-text-muted);
		max-width: var(--measure);
	}
	form {
		display: flex;
		flex-direction: column;
		gap: var(--sp-2);
		max-width: 24rem;
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
	.hint {
		font-size: var(--fs-xs);
		color: var(--c-text-muted);
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
	.error {
		color: var(--c-crit);
		background: color-mix(in srgb, var(--c-crit) 8%, transparent);
		border: 1px solid color-mix(in srgb, var(--c-crit) 25%, transparent);
		border-radius: var(--radius-sm);
		padding: var(--sp-2) var(--sp-3);
		max-width: 24rem;
	}
</style>
