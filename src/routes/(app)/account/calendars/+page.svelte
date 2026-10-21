<script lang="ts">
	let { data, form } = $props();

	const when = (d: Date | string | null) => (d ? new Date(d).toLocaleString() : 'not yet');
	const providerLabel = (p: string, url: string | null) =>
		p === 'google' ? 'Google' : url === data.icloudUrl ? 'iCloud' : 'CalDAV';
</script>

<svelte:head><title>Calendars · LifeOS</title></svelte:head>

<h1>Calendars</h1>
<p class="lede">
	Your Google and iCloud calendars, shown on LifeOS's calendar, and one Google calendar LifeOS adds
	its own tasks, visits, bills and dates to. Only you see your connections here.
</p>

{#if form?.error}
	<p class="error" role="alert">{form.error}</p>
{:else if form?.ok}
	<p class="ok" role="status">{form.ok}</p>
{/if}

{#if data.connections.length > 0}
	<section aria-labelledby="yours">
		<h2 id="yours">Connected</h2>
		{#each data.connections as c (c.id)}
			<article class="connection">
				<header>
					<strong>{providerLabel(c.provider, c.serverUrl)}</strong>
					<span class="muted">{c.account}</span>
					<span class="muted">· synced {when(c.lastSyncedAt)}</span>
					<form method="POST" action="?/remove">
						<input type="hidden" name="connectionId" value={c.id} />
						<button type="submit" class="quiet">Remove</button>
					</form>
				</header>
				{#if c.lastError}<p class="error">{c.lastError}</p>{/if}
				<ul>
					{#each c.sources as s (s.id)}
						<li>
							<span class="swatch" style:background={s.color ?? 'var(--c-border)'}></span>
							<span class="name">{s.name}</span>
							{#if s.isPushTarget}<span class="badge">LifeOS writes here</span>{/if}
							<form method="POST" action="?/updateSource" class="inline">
								<input type="hidden" name="sourceId" value={s.id} />
								<label
									><input type="checkbox" name="importEnabled" checked={s.importEnabled} /> Show</label
								>
								<label class="sr-only" for={`vis-${s.id}`}>Who sees it</label>
								<select id={`vis-${s.id}`} name="visibility" value={s.visibility}>
									<option value="private">Just me</option>
									<option value="household">The household</option>
								</select>
								<button type="submit" class="quiet">Save</button>
							</form>
							{#if c.provider === 'google'}
								<form method="POST" action="?/setTarget" class="inline">
									<input type="hidden" name="sourceId" value={s.isPushTarget ? '' : s.id} />
									<button type="submit" class="quiet">
										{s.isPushTarget ? 'Stop adding LifeOS items' : 'Add LifeOS items here'}
									</button>
								</form>
							{/if}
							{#if s.lastError}<p class="error">{s.lastError}</p>{/if}
						</li>
					{/each}
				</ul>
			</article>
		{/each}
		<form method="POST" action="?/syncNow">
			<button type="submit">Sync now</button>
		</form>
	</section>
{/if}

<section aria-labelledby="icloud">
	<h2 id="icloud">Add iCloud</h2>
	{#if data.problems.LIFEOS_SECRET_KEY}
		<p class="error">iCloud can't be connected: {data.problems.LIFEOS_SECRET_KEY}.</p>
	{:else if !data.canStoreSecrets}
		<p class="notice">
			Not available yet: the server needs a LIFEOS_SECRET_KEY to store a password safely.
		</p>
	{:else}
		<ol class="steps">
			<li>
				At <a href="https://account.apple.com" rel="noreferrer" target="_blank">account.apple.com</a
				>, open Sign-In and Security, then App-Specific Passwords, and make one called "LifeOS".
			</li>
			<li>Enter your Apple ID and that password here. Your Apple ID's own password won't work.</li>
		</ol>
		{#if form?.section === 'caldav' && form?.error}<p class="error" role="alert">
				{form.error}
			</p>{/if}
		<form method="POST" action="?/addCaldav">
			<label for="account">Apple ID</label>
			<input id="account" name="account" type="email" autocomplete="username" required />
			<label for="secret">App-specific password</label>
			<input id="secret" name="secret" type="password" autocomplete="off" required />
			<details>
				<summary>Another CalDAV server</summary>
				<label for="serverUrl">Server address</label>
				<input id="serverUrl" name="serverUrl" type="url" placeholder={data.icloudUrl} />
			</details>
			<button type="submit">Connect</button>
		</form>
	{/if}
</section>

<section aria-labelledby="google">
	<h2 id="google">Add a Google calendar</h2>
	{#if data.problems.LIFEOS_GOOGLE_SA_FILE}
		<p class="error">Google can't be used: {data.problems.LIFEOS_GOOGLE_SA_FILE}.</p>
	{:else if !data.serviceAccountEmail}
		<p class="notice">Not available yet: Google isn't configured on the server.</p>
	{:else}
		<ol class="steps">
			<li>
				In Google Calendar's settings, open the calendar, and under "Share with specific people" add <code
					>{data.serviceAccountEmail}</code
				>: "See all event details" for a calendar to show here, or "Make changes to events" for the
				calendar LifeOS adds its items to (make a new one called "LifeOS" for that).
			</li>
			<li>Copy the Calendar ID from "Integrate calendar", and paste it below.</li>
		</ol>
		{#if form?.section === 'google' && form?.error}<p class="error" role="alert">
				{form.error}
			</p>{/if}
		<form method="POST" action="?/addGoogle">
			<label for="calendarId">Calendar ID</label>
			<input id="calendarId" name="calendarId" required />
			<label class="check"
				><input type="checkbox" name="pushTarget" /> LifeOS adds its own items to this calendar</label
			>
			<button type="submit">Add</button>
		</form>
	{/if}
</section>

<style>
	.lede,
	.muted {
		color: var(--c-text-muted);
	}
	.lede {
		max-width: var(--measure);
	}
	section {
		margin-top: var(--sp-6);
	}
	.connection {
		border: 1px solid var(--c-border);
		border-radius: var(--radius);
		padding: var(--sp-3);
		margin-bottom: var(--sp-3);
	}
	.connection header {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--sp-2);
	}
	.connection header form {
		margin-left: auto;
	}
	ul {
		list-style: none;
		padding: 0;
		margin: var(--sp-2) 0 0;
		display: flex;
		flex-direction: column;
		gap: var(--sp-2);
	}
	li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--sp-2);
	}
	.swatch {
		width: 0.75rem;
		height: 0.75rem;
		border-radius: 50%;
		flex: none;
	}
	.name {
		font-weight: 600;
	}
	.badge {
		font-size: var(--fs-sm);
		padding: 0 var(--sp-2);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-pill);
	}
	form:not(.inline) {
		display: flex;
		flex-direction: column;
		gap: var(--sp-2);
		max-width: 24rem;
	}
	form.inline {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-2);
	}
	label {
		font-size: var(--fs-sm);
		color: var(--c-text-muted);
	}
	input:not([type='checkbox']),
	select {
		padding: var(--sp-2) var(--sp-3);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-sm);
		background: var(--c-surface);
		color: inherit;
		font: inherit;
	}
	button {
		align-self: flex-start;
		padding: var(--sp-2) var(--sp-4);
		font: inherit;
		cursor: pointer;
	}
	button.quiet {
		padding: var(--sp-1) var(--sp-2);
		font-size: var(--fs-sm);
	}
	.steps {
		max-width: var(--measure);
		color: var(--c-text-muted);
	}
	.error {
		color: var(--c-crit);
	}
	.ok {
		color: var(--c-ok);
	}
	.notice {
		color: var(--c-text-muted);
		font-style: italic;
	}
	code {
		font-family: var(--font-mono);
		overflow-wrap: anywhere;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
	}
</style>
