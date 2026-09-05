<script lang="ts">
	let { data, form } = $props();
	const fmt = (d: Date | null) => (d ? new Date(d).toLocaleString() : '—');
</script>

<svelte:head><title>People · LifeOS</title></svelte:head>

<h1>People</h1>

{#if form?.error}
	<p class="notice error" role="alert">{form.error}</p>
{/if}

{#if form?.created || form?.reset}
	{@const c = form.created ?? form.reset}
	<div class="notice credential" role="status">
		<strong>One-time password for {c.username}</strong>
		<code>{c.password}</code>
		<span>Shown once. Hand it over now — they must change it at first sign-in.</span>
	</div>
{/if}

<div class="scroll-x">
	<table>
		<thead>
			<tr><th>Person</th><th>Username</th><th>Role</th><th>Last sign-in</th><th>Actions</th></tr>
		</thead>
		<tbody>
			{#each data.members as m (m.id)}
				<tr class:disabled={m.disabledAt}>
					<td>
						{m.displayName}
						{#if m.disabledAt}<span class="tag">disabled</span>{/if}
						{#if m.mustChangeCredentials}<span class="tag warn">must rotate</span>{/if}
					</td>
					<td>{m.username ?? '—'}</td>
					<td>{m.role}</td>
					<td class="numeric">{fmt(m.lastLoginAt)}</td>
					<td class="actions">
						<form method="POST" action="?/reset">
							<input type="hidden" name="userId" value={m.id} />
							<input type="hidden" name="username" value={m.username} />
							<button type="submit">Reset password</button>
						</form>
						<form method="POST" action="?/disable">
							<input type="hidden" name="userId" value={m.id} />
							<input type="hidden" name="disabled" value={m.disabledAt ? 'false' : 'true'} />
							<button type="submit" disabled={m.id === data.me && !m.disabledAt}>
								{m.disabledAt ? 'Enable' : 'Disable'}
							</button>
						</form>
						<form method="POST" action="?/role">
							<input type="hidden" name="userId" value={m.id} />
							<input type="hidden" name="role" value={m.role === 'admin' ? 'member' : 'admin'} />
							<button type="submit">Make {m.role === 'admin' ? 'member' : 'admin'}</button>
						</form>
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<h2>Add someone</h2>
<form method="POST" action="?/create" class="create">
	<label for="displayName">Name</label>
	<input id="displayName" name="displayName" required />
	<label for="username">Username</label>
	<input id="username" name="username" required />
	<label for="role">Role</label>
	<select id="role" name="role">
		<option value="member">member</option>
		<option value="admin">admin</option>
	</select>
	<button type="submit">Create account</button>
</form>

<style>
	table {
		width: 100%;
		font-size: var(--fs-sm);
	}
	th,
	td {
		text-align: left;
		padding: var(--sp-2) var(--sp-3);
		border-bottom: 1px solid var(--c-border);
		white-space: nowrap;
	}
	th {
		color: var(--c-text-muted);
		font-weight: 600;
	}
	tr.disabled td {
		opacity: 0.55;
	}
	.tag {
		display: inline-block;
		margin-left: var(--sp-2);
		padding: 0 var(--sp-2);
		border-radius: 999px;
		font-size: var(--fs-xs);
		background: var(--c-surface-alt);
		color: var(--c-text-muted);
	}
	.tag.warn {
		color: var(--c-warn);
	}
	.actions {
		display: flex;
		gap: var(--sp-2);
	}
	.actions button {
		min-height: 32px;
		padding: 0 var(--sp-2);
		font-size: var(--fs-xs);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-sm);
		background: var(--c-surface);
		cursor: pointer;
	}
	.actions button:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.create {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: var(--sp-2) var(--sp-3);
		align-items: center;
		max-width: 26rem;
	}
	.create button {
		grid-column: 2;
		justify-self: start;
		padding: var(--sp-2) var(--sp-4);
		border: none;
		border-radius: var(--radius-sm);
		background: var(--c-accent);
		color: var(--c-accent-text);
		font-weight: 600;
		cursor: pointer;
	}
	.create input,
	.create select {
		padding: var(--sp-2);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-sm);
		background: var(--c-surface);
	}
	.notice {
		padding: var(--sp-3);
		border-radius: var(--radius-sm);
		margin-bottom: var(--sp-4);
	}
	.error {
		color: var(--c-crit);
		border: 1px solid color-mix(in srgb, var(--c-crit) 25%, transparent);
	}
	.credential {
		display: flex;
		flex-direction: column;
		gap: var(--sp-2);
		border: 1px solid var(--c-accent);
		background: color-mix(in srgb, var(--c-accent) 7%, transparent);
	}
	.credential code {
		font-family: var(--font-mono);
		font-size: var(--fs-lg);
		user-select: all;
	}
	.credential span {
		font-size: var(--fs-sm);
		color: var(--c-text-muted);
	}
</style>
