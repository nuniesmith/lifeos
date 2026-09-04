<script lang="ts">
	import '$lib/styles/tokens.css';
	let { children } = $props();
</script>

<a class="skip" href="#main">Skip to content</a>
<main id="main">
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
</style>
