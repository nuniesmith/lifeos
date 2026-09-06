<script lang="ts">
	import { onMount } from 'svelte';
	import { base, resolve } from '$app/paths';
	import { page } from '$app/state';
	import BottomNav from '$lib/components/BottomNav.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import PageCover from '$lib/components/PageCover.svelte';
	import QuickAdd from '$lib/components/QuickAdd.svelte';
	import SideNav from '$lib/components/SideNav.svelte';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import { pageThemeFor } from '$lib/components/page-themes';
	import { WORKSPACE_GROUPS } from '$lib/components/workspace-nav';

	let { data, children } = $props();
	let quickAddOpen = $state(false);
	let quickAddKind = $state('task');
	let sidebarPreference = $state<boolean>();
	let wideViewport = $state(false);
	const isHome = $derived(page.url.pathname === resolve('/'));
	const pageTheme = $derived(pageThemeFor(page.url.pathname));
	const sidebarOpen = $derived(sidebarPreference ?? (wideViewport && !isHome));
	const currentSection = $derived(
		WORKSPACE_GROUPS.flatMap((group) => group.items).find(
			(item) => item.href && page.url.pathname.startsWith(item.href)
		)?.label ?? (page.url.pathname.includes('/account') ? 'Settings' : 'Workspace')
	);

	function quickCapture() {
		quickAddKind = 'task';
		quickAddOpen = true;
	}

	onMount(() => {
		const media = window.matchMedia('(min-width: 48rem)');
		const syncViewport = () => (wideViewport = media.matches);
		syncViewport();
		media.addEventListener('change', syncViewport);
		return () => {
			media.removeEventListener('change', syncViewport);
		};
	});
</script>

<QuickAdd bind:open={quickAddOpen} bind:kind={quickAddKind} />

<div class="workspace-shell">
	<header class="topbar">
		<div class="breadcrumb">
			<button
				type="button"
				class="icon-button sidebar-toggle"
				aria-label={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
				aria-expanded={sidebarOpen}
				aria-controls="workspace-sidebar"
				onclick={() => (sidebarPreference = !sidebarOpen)}
			>
				<span class="menu-icon" aria-hidden="true"><i></i><i></i><i></i></span>
			</button>
			<a class="home-crumb" href={resolve('/')}>
				<img src={`${base}/images/home/home-icon.png`} alt="" width="21" height="21" />
				<span>Home</span>
			</a>
			{#if !isHome}
				<span class="divider" aria-hidden="true">/</span>
				<span class="current-section">{currentSection}</span>
			{/if}
		</div>
		<div class="topbar-actions">
			<span class="workspace-label">Your personal workspace</span>
			<ThemeToggle />
			<button
				type="button"
				class="icon-button capture"
				aria-label="Quick add"
				onclick={quickCapture}
			>
				<Icon name="plus" size={18} />
			</button>
			<a class="icon-button" href={resolve('/account/credentials')} aria-label="Settings">
				<img src={`${base}/images/home/settings-icon.png`} alt="" width="22" height="22" />
			</a>
		</div>
	</header>

	<div class="shell" class:sidebar-open={sidebarOpen}>
		<aside id="workspace-sidebar" class="sidebar-panel" hidden={!sidebarOpen}>
			<SideNav user={data.user} pathname={page.url.pathname} onQuickAdd={quickCapture} />
		</aside>
		<div
			class="pane"
			class:home-pane={isHome}
			class:themed-pane={Boolean(pageTheme)}
			style:--page-accent={pageTheme?.accent}
			style:--page-accent-soft={pageTheme?.accentSoft}
		>
			{#if pageTheme}<PageCover theme={pageTheme} />{/if}
			<div class="page-content" class:themed-content={Boolean(pageTheme)}>
				{@render children()}
			</div>
		</div>
	</div>
</div>

<BottomNav user={data.user} pathname={page.url.pathname} />

<style>
	.workspace-shell {
		min-height: 100dvh;
	}
	.topbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 3rem;
		padding: 0 1rem;
		gap: 1rem;
		border-bottom: 1px solid var(--c-border);
		background: var(--c-bg);
		font-size: 0.8rem;
	}
	.breadcrumb,
	.topbar-actions,
	.home-crumb {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		min-width: 0;
	}
	.home-crumb {
		color: var(--c-text);
		text-decoration: none;
	}
	.home-crumb img {
		object-fit: contain;
	}
	.divider {
		color: var(--c-text-muted);
		opacity: 0.5;
	}
	.current-section {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.workspace-label {
		color: var(--c-text-muted);
		font-size: 0.73rem;
	}
	.icon-button {
		display: grid;
		place-items: center;
		flex: 0 0 auto;
		width: 2.25rem;
		min-height: 2.25rem;
		padding: 0;
		border: none;
		border-radius: 4px;
		background: transparent;
		color: var(--c-text-muted);
		cursor: pointer;
	}
	.icon-button:hover {
		background: var(--c-surface-alt);
		color: var(--c-text);
	}
	.icon-button img {
		object-fit: contain;
	}
	.menu-icon {
		display: grid;
		gap: 4px;
		width: 15px;
	}
	.menu-icon i {
		display: block;
		height: 1px;
		background: currentColor;
	}
	.shell {
		padding-bottom: calc(var(--nav-h) + env(safe-area-inset-bottom) + var(--sp-8));
	}
	.sidebar-panel {
		background: var(--c-nav-bg);
		border-bottom: 1px solid var(--c-border);
	}
	.pane {
		min-width: 0;
		max-width: 65rem;
		margin: 0 auto;
		padding: 2.5rem 1.5rem;
	}
	.themed-pane {
		max-width: 90rem;
	}
	.page-content {
		min-width: 0;
	}
	.themed-pane > :global(.page-cover) {
		margin: -2.5rem -1.5rem 2.5rem;
	}
	.home-pane {
		max-width: none;
		margin: 0;
		padding: 0;
	}
	@media (max-width: 47.999rem) {
		.workspace-label,
		.capture {
			display: none;
		}
		.topbar {
			padding: 0 0.6rem;
		}
		.icon-button {
			min-width: 44px;
			min-height: 44px;
		}
	}
	@media (min-width: 48rem) {
		.shell {
			display: grid;
			grid-template-columns: minmax(0, 1fr);
			padding-bottom: 0;
		}
		.shell.sidebar-open {
			grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
		}
		.sidebar-panel {
			position: sticky;
			top: 0;
			align-self: start;
			max-height: 100dvh;
			overflow-y: auto;
			border-bottom: 0;
			border-right: 1px solid var(--c-border);
		}
		.pane {
			width: 100%;
			padding: 3rem 2.5rem;
		}
		.themed-pane > :global(.page-cover) {
			margin: -3rem -2.5rem 3rem;
		}
		.home-pane {
			padding: 0;
		}
	}
</style>
