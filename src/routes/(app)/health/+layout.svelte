<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { Icon, appPath } from '$lib/components';
	import type { IconName } from '$lib/components';

	let { children } = $props();

	interface Section {
		href: string;
		label: string;
		icon: IconName;
	}

	/** Same six destinations as the health workspace, in the order a person
	 *  reads about their own health: the whole picture, then what needs doing,
	 *  then the three records kept over time. */
	const SECTIONS: Section[] = [
		{ href: '/health', label: 'Overview', icon: 'today' },
		{ href: '/health/medications', label: 'Medications', icon: 'check' },
		{ href: '/health/measurements', label: 'Measurements', icon: 'audit' },
		{ href: '/health/labs', label: 'Labs', icon: 'journal' },
		{ href: '/health/visits', label: 'Visits', icon: 'people' },
		{ href: '/health/symptoms', label: 'Symptoms & mood', icon: 'habits' }
	];

	/**
	 * Whether `href` is the open tab.
	 *
	 * Deliberately not `isCurrent` from `$lib/components/nav`: that helper
	 * special-cases `/` as an exact match and lets every other destination own
	 * its whole subtree, which is right for a sidebar where Health must light
	 * up for `/health/labs/<id>` too. Here `/health` is a SIBLING of the other
	 * five tabs, not their parent, so it needs the same exact-match treatment
	 * `isCurrent` gives `/` — otherwise Overview would stay highlighted on
	 * every other health page. Labs and Visits each own a `[id]` detail route,
	 * so those two still want the prefix match.
	 */
	function isOpen(pathname: string, href: string): boolean {
		const here = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
		if (href === '/health') return here === '/health';
		return here === href || here.startsWith(href + '/');
	}
</script>

<nav class="health-tabs" aria-label="Health sections">
	{#each SECTIONS as section (section.href)}
		{@const current = isOpen(page.url.pathname, section.href)}
		<a
			class="tab"
			class:current
			href={resolve(appPath(section.href))}
			aria-current={current ? 'page' : undefined}
		>
			<Icon name={section.icon} size={16} />
			{section.label}
		</a>
	{/each}
</nav>

{@render children()}

<style>
	.health-tabs {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-2);
		margin-bottom: var(--sp-6);
		padding-bottom: var(--sp-3);
		border-bottom: 1px solid var(--c-border);
		overflow-x: auto;
	}

	.tab {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		gap: var(--sp-2);
		min-height: var(--tap);
		padding: var(--sp-1) var(--sp-3);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-pill);
		background: var(--c-surface);
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
		text-decoration: none;
	}
	.tab:hover {
		border-color: var(--c-text-muted);
		color: var(--c-text);
	}
	.tab.current {
		border-color: var(--c-accent);
		background: var(--c-accent-soft);
		color: var(--c-text);
		font-weight: 600;
	}
</style>
