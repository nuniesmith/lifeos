<script lang="ts">
	import { resolve } from '$app/paths';
	import Icon from './Icon.svelte';
	import { APP_DESTINATIONS, adminDestinationsFor, appPath, isCurrent } from './nav';

	interface Props {
		/** The signed-in user, from the (app) layout's server load. */
		user: { displayName: string; role: string } | null | undefined;
		/** The current path, so the open section can be marked. */
		pathname: string;
		onQuickAdd: () => void;
	}

	let { user, pathname, onQuickAdd }: Props = $props();

	const adminLinks = $derived(adminDestinationsFor(user?.role));
</script>

<!--
	The wide-viewport navigation. Hidden below 48rem, where BottomNav takes
	over: two components rather than one that changes shape, because a sidebar
	and a bottom bar want genuinely different markup order — but both read the
	same destination list, so they cannot drift apart.
-->
<nav class="side" aria-label="Sections">
	<a class="brand" href={resolve('/')}>LifeOS</a>

	<button type="button" class="quick" onclick={onQuickAdd}>
		<Icon name="plus" size={18} />
		Quick add
	</button>

	<ul>
		{#each APP_DESTINATIONS as d (d.href)}
			{@const current = isCurrent(pathname, d.href)}
			<li>
				<a
					href={resolve(appPath(d.href))}
					aria-current={current ? 'page' : undefined}
					class:current
				>
					<Icon name={d.icon} size={18} />
					{d.label}
				</a>
			</li>
		{/each}
	</ul>

	{#if adminLinks.length > 0}
		<p class="group">Admin</p>
		<ul>
			{#each adminLinks as d (d.href)}
				{@const current = isCurrent(pathname, d.href)}
				<li>
					<a
						href={resolve(appPath(d.href))}
						aria-current={current ? 'page' : undefined}
						class:current
					>
						<Icon name={d.icon} size={18} />
						{d.label}
					</a>
				</li>
			{/each}
		</ul>
	{/if}

	<div class="account">
		<a class="who" href={resolve('/account/credentials')}>{user?.displayName ?? 'Account'}</a>
		<form method="POST" action="/logout">
			<button type="submit">
				<Icon name="signOut" size={16} />
				Sign out
			</button>
		</form>
	</div>
</nav>

<style>
	.side {
		display: none;
	}

	@media (min-width: 48rem) {
		.side {
			display: flex;
			flex-direction: column;
			gap: var(--sp-2);
			/* Follows the page rather than scrolling away, and never taller
			   than the viewport. */
			position: sticky;
			top: var(--sp-4);
			max-height: calc(100dvh - var(--sp-8));
			overflow-y: auto;
		}
	}

	.brand {
		font-size: var(--fs-lg);
		font-weight: 700;
		color: var(--c-text);
		text-decoration: none;
		padding: var(--sp-1) var(--sp-2);
	}

	.quick {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--sp-2);
		margin: var(--sp-2) 0;
		padding: 0 var(--sp-3);
		border: none;
		border-radius: var(--radius-sm);
		background: var(--c-accent);
		color: var(--c-accent-text);
		font-size: var(--fs-sm);
		font-weight: 600;
		cursor: pointer;
	}

	ul {
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	li a {
		display: flex;
		align-items: center;
		gap: var(--sp-3);
		min-height: var(--tap);
		padding: 0 var(--sp-3);
		border-radius: var(--radius-sm);
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
		font-weight: 550;
		text-decoration: none;
	}
	li a:hover {
		background: var(--c-surface-alt);
		color: var(--c-text);
	}

	.current {
		background: var(--c-accent-soft);
		color: var(--c-accent);
	}

	.group {
		margin: var(--sp-4) 0 var(--sp-1);
		padding: 0 var(--sp-3);
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	.account {
		margin-top: auto;
		padding-top: var(--sp-4);
		border-top: 1px solid var(--c-border);
	}

	.who {
		display: block;
		padding: 0 var(--sp-3);
		color: var(--c-text);
		font-size: var(--fs-sm);
		font-weight: 600;
		text-decoration: none;
		overflow-wrap: anywhere;
	}
	.who:hover {
		color: var(--c-accent);
	}

	.account button {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		width: 100%;
		padding: 0 var(--sp-3);
		border: none;
		background: none;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
		text-align: left;
		cursor: pointer;
	}
	.account button:hover {
		color: var(--c-text);
	}
</style>
