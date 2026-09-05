<script lang="ts">
	import { page } from '$app/state';
	import BottomNav from '$lib/components/BottomNav.svelte';
	import QuickAdd from '$lib/components/QuickAdd.svelte';
	import SideNav from '$lib/components/SideNav.svelte';

	let { data, children } = $props();

	/**
	 * One piece of shell state, held here rather than inside QuickAdd, because
	 * two separate controls open the same sheet: the floating button on a
	 * phone and the sidebar button on a wide screen.
	 */
	let quickAddOpen = $state(false);
</script>

<!--
	The authenticated shell.

	Below 48rem this is a single column with a fixed bottom bar and a floating
	quick-add button; above it, a sticky sidebar beside the content. Both
	navigations render from the same destination list in $lib/components/nav.ts.

	The admin links are hidden for a member, but that is tidiness, not access
	control — +layout.server.ts and requireAdmin refuse those routes on the
	server whatever this markup does.
-->
<div class="shell">
	<SideNav user={data.user} pathname={page.url.pathname} onQuickAdd={() => (quickAddOpen = true)} />

	<div class="pane">
		{@render children()}
	</div>
</div>

<QuickAdd bind:open={quickAddOpen} />
<BottomNav user={data.user} pathname={page.url.pathname} />

<style>
	.shell {
		display: grid;
		grid-template-columns: 1fr;
		/* Clears the fixed bottom bar and the floating button, plus the home
		   indicator on a phone that has one. */
		padding-bottom: calc(var(--nav-h) + env(safe-area-inset-bottom) + var(--sp-8));
	}

	@media (min-width: 48rem) {
		.shell {
			/* minmax(0, 1fr) rather than 1fr: without the zero minimum, a wide
			   child (a table, a code block) grows the track and the whole page
			   scrolls sideways instead of the child scrolling inside itself. */
			grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
			gap: var(--sp-8);
			align-items: start;
			padding-bottom: 0;
		}
	}

	.pane {
		min-width: 0;
	}
</style>
