<script lang="ts">
	import { resolve } from '$app/paths';
	import Icon from './Icon.svelte';
	import { adminDestinationsFor, appPath, isCurrent } from './nav';
	import { WORKSPACE_GROUPS } from './workspace-nav';

	interface Props {
		user: { displayName: string; role: string } | null | undefined;
		pathname: string;
		onQuickAdd: () => void;
	}

	let { user, pathname, onQuickAdd }: Props = $props();
	const adminLinks = $derived(adminDestinationsFor(user?.role));
</script>

<nav class="side" aria-label="Sections">
	<a class="brand" href={resolve('/')}>Life OS<span>Personal workspace</span></a>
	<button type="button" class="quick" onclick={onQuickAdd}>
		<Icon name="plus" size={17} />
		Quick add
	</button>
	<a
		class="home destination"
		class:current={isCurrent(pathname, '/')}
		href={resolve('/')}
		aria-current={isCurrent(pathname, '/') ? 'page' : undefined}
	>
		<Icon name="today" size={17} />
		Home
		<span class="today-label">Today</span>
	</a>
	<!-- Search sits with Home rather than inside a group: it reaches across
	     every group, so filing it under one of them would be a lie. -->
	<a
		class="destination"
		class:current={isCurrent(pathname, '/search')}
		href={resolve(appPath('/search'))}
		aria-current={isCurrent(pathname, '/search') ? 'page' : undefined}
	>
		<Icon name="search" size={17} />
		Search
	</a>

	{#each WORKSPACE_GROUPS as group (group.id)}
		<section aria-labelledby={`nav-${group.id}`}>
			<h2 id={`nav-${group.id}`} style:color={group.color}>
				<span class="group-dot" aria-hidden="true"></span>{group.label}
			</h2>
			<ul>
				{#each group.items as item (item.label)}
					<li>
						{#if item.href}
							{@const current = isCurrent(pathname, item.href)}
							<a
								class="destination"
								class:current
								href={resolve(appPath(item.href))}
								aria-current={current ? 'page' : undefined}
							>
								<Icon name={item.icon} size={16} />
								{item.label}
							</a>
						{:else}
							<span class="destination upcoming">
								<Icon name={item.icon} size={16} />
								{item.label}<small>Upcoming</small>
							</span>
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/each}

	{#if adminLinks.length > 0}
		<section aria-labelledby="nav-admin">
			<h2 id="nav-admin">ADMIN</h2>
			<ul>
				{#each adminLinks as item (item.href)}
					<li>
						<a
							class="destination"
							class:current={isCurrent(pathname, item.href)}
							href={resolve(appPath(item.href))}
							aria-current={isCurrent(pathname, item.href) ? 'page' : undefined}
						>
							<Icon name={item.icon} size={16} />
							{item.label}
						</a>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<div class="account">
		<a class="who" href={resolve('/account/credentials')}>{user?.displayName ?? 'Account'}</a>
		<form method="POST" action="/logout">
			<button type="submit"><Icon name="signOut" size={16} />Sign out</button>
		</form>
	</div>
</nav>

<style>
	.side {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 1rem 0.75rem;
	}
	.brand {
		padding: 0.25rem 0.5rem 1rem;
		color: var(--c-text);
		font-size: 1rem;
		font-weight: 650;
		text-decoration: none;
	}
	.brand span {
		display: block;
		margin-top: 0.15rem;
		color: var(--c-text-muted);
		font-size: 0.69rem;
		font-weight: 400;
	}
	.quick {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin-bottom: 0.35rem;
		padding: 0 0.6rem;
		min-height: 35px;
		border: 1px solid var(--c-border);
		border-radius: 4px;
		background: var(--c-surface-alt);
		color: var(--c-text);
		font-size: 0.8rem;
		cursor: pointer;
	}
	.quick:hover {
		border-color: var(--c-text-muted);
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.destination {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		min-height: 32px;
		padding: 0.3rem 0.55rem;
		border-radius: 4px;
		color: var(--c-text-muted);
		font-size: 0.79rem;
		text-decoration: none;
	}
	a.destination:hover {
		background: var(--c-surface-alt);
		color: var(--c-text);
	}
	.destination.current {
		background: var(--c-accent-soft);
		color: var(--c-text);
	}
	h2 {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 1.1rem 0 0.4rem;
		padding: 0 0.55rem;
		font-size: 0.61rem;
		font-weight: 650;
		letter-spacing: 0.13em;
	}
	.group-dot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: currentColor;
	}
	.today-label,
	small {
		margin-left: auto;
		font-size: 0.58rem;
		letter-spacing: 0.02em;
		color: var(--c-text-muted);
	}
	.upcoming {
		opacity: 0.68;
	}
	small {
		opacity: 0.7;
	}
	.account {
		margin-top: 1.25rem;
		padding-top: 0.8rem;
		border-top: 1px solid var(--c-border);
	}
	.who {
		display: block;
		padding: 0.25rem 0.55rem;
		color: var(--c-text);
		font-size: 0.8rem;
		font-weight: 550;
		text-decoration: none;
		overflow-wrap: anywhere;
	}
	.account button {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		width: 100%;
		min-height: 35px;
		padding: 0 0.55rem;
		border: 0;
		background: none;
		color: var(--c-text-muted);
		font-size: 0.75rem;
		cursor: pointer;
	}
	.account button:hover {
		color: var(--c-text);
	}
	@media (max-width: 47.999rem) {
		.side {
			max-height: 65dvh;
			overflow-y: auto;
		}
		.destination,
		.quick,
		.account button {
			min-height: 44px;
		}
	}
</style>
