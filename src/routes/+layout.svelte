<script lang="ts">
	import '$lib/styles/tokens.css';
	import { page } from '$app/state';
	let { children } = $props();
	const workspace = $derived(page.route.id?.startsWith('/(app)') ?? false);
</script>

<a class="skip" href="#main">Skip to content</a>
<main id="main" class:workspace>
	{@render children()}
</main>

<style>
	.skip {
		position: absolute;
		left: -9999px;
	}
	.skip:focus {
		left: var(--sp-4);
		top: var(--sp-4);
		z-index: 10;
		background: var(--c-surface);
		padding: var(--sp-2) var(--sp-3);
		border-radius: var(--radius-sm);
		box-shadow: var(--shadow);
	}
	main {
		max-width: 60rem;
		margin: 0 auto;
		padding: var(--sp-8) var(--sp-4);
	}
	main.workspace {
		max-width: none;
		margin: 0;
		padding: 0;
		min-height: 100dvh;
	}
</style>
