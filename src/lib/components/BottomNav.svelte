<script lang="ts">
	import { resolve } from '$app/paths';
	import Icon from './Icon.svelte';
	import Sheet from './Sheet.svelte';
	import {
		BAR_DESTINATIONS,
		OVERFLOW_DESTINATIONS,
		adminDestinationsFor,
		appPath,
		isCurrent
	} from './nav';

	interface Props {
		user: { displayName: string; role: string } | null | undefined;
		pathname: string;
	}

	let { user, pathname }: Props = $props();

	let moreOpen = $state(false);

	const adminLinks = $derived(adminDestinationsFor(user?.role));

	// The "More" button is itself a current-section indicator: if you are
	// inside a destination that lives behind it, the button lights up.
	const inOverflow = $derived(
		[...OVERFLOW_DESTINATIONS, ...adminLinks].some((d) => isCurrent(pathname, d.href))
	);
</script>

<!--
	The phone's primary navigation. Four destinations plus More: a fifth
	makes each target narrower than a thumb on a 360px screen, and the
	acceptance gate for this project is a one-handed phone workflow.
-->
<nav class="bar" aria-label="Main">
	<ul>
		{#each BAR_DESTINATIONS as d (d.href)}
			{@const current = isCurrent(pathname, d.href)}
			<li>
				<a
					href={resolve(appPath(d.href))}
					aria-current={current ? 'page' : undefined}
					class:current
				>
					<Icon name={d.icon} size={22} />
					<span>{d.label}</span>
				</a>
			</li>
		{/each}
		<li>
			<button
				type="button"
				class:current={inOverflow}
				aria-expanded={moreOpen}
				onclick={() => (moreOpen = true)}
			>
				<Icon name="more" size={22} />
				<span>More</span>
			</button>
		</li>
	</ul>
</nav>

<Sheet bind:open={moreOpen} title="More">
	<ul class="sheet-list">
		{#each OVERFLOW_DESTINATIONS as d (d.href)}
			{@const current = isCurrent(pathname, d.href)}
			<li>
				<a
					href={resolve(appPath(d.href))}
					aria-current={current ? 'page' : undefined}
					onclick={() => (moreOpen = false)}
				>
					<Icon name={d.icon} size={20} />
					{d.label}
				</a>
			</li>
		{/each}
	</ul>

	{#if adminLinks.length > 0}
		<p class="group">Admin</p>
		<ul class="sheet-list">
			{#each adminLinks as d (d.href)}
				{@const current = isCurrent(pathname, d.href)}
				<li>
					<a
						href={resolve(appPath(d.href))}
						aria-current={current ? 'page' : undefined}
						onclick={() => (moreOpen = false)}
					>
						<Icon name={d.icon} size={20} />
						{d.label}
					</a>
				</li>
			{/each}
		</ul>
	{/if}

	<p class="group">{user?.displayName ?? 'Account'}</p>
	<ul class="sheet-list">
		<li>
			<a href={resolve('/account/credentials')} onclick={() => (moreOpen = false)}>
				<Icon name="people" size={20} />
				Your credentials
			</a>
		</li>
		<li>
			<form method="POST" action="/logout">
				<button type="submit">
					<Icon name="signOut" size={20} />
					Sign out
				</button>
			</form>
		</li>
	</ul>
</Sheet>

<style>
	.bar {
		position: fixed;
		inset-inline: 0;
		bottom: 0;
		z-index: var(--z-nav);
		background: var(--c-nav-bg);
		border-top: 1px solid var(--c-border);
		/* Clears the home indicator on a modern phone. */
		padding-bottom: env(safe-area-inset-bottom);
	}

	@media (min-width: 48rem) {
		.bar {
			display: none;
		}
	}

	.bar ul {
		display: flex;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.bar li {
		flex: 1 1 0;
		min-width: 0;
	}

	.bar a,
	.bar button {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2px;
		width: 100%;
		min-height: var(--nav-h);
		padding: var(--sp-1) 2px;
		border: none;
		background: none;
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
		font-weight: 600;
		text-decoration: none;
		cursor: pointer;
	}

	.bar span {
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* Colour alone must not carry the current section; the bar shows a rule
	   above the active item as well. */
	.bar .current {
		color: var(--c-accent);
		box-shadow: inset 0 2px 0 var(--c-accent);
	}

	.bar :focus-visible {
		outline-offset: -3px;
	}

	.sheet-list {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.sheet-list a,
	.sheet-list button {
		display: flex;
		align-items: center;
		gap: var(--sp-3);
		width: 100%;
		min-height: var(--tap);
		padding: var(--sp-2) var(--sp-2);
		border: none;
		border-radius: var(--radius-sm);
		background: none;
		color: var(--c-text);
		font-size: var(--fs-base);
		font-weight: 550;
		text-align: left;
		text-decoration: none;
		cursor: pointer;
	}
	.sheet-list a:hover,
	.sheet-list button:hover {
		background: var(--c-surface-alt);
	}

	.sheet-list [aria-current='page'] {
		color: var(--c-accent);
	}

	.group {
		margin: var(--sp-4) 0 var(--sp-1);
		padding: 0 var(--sp-2);
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}
</style>
