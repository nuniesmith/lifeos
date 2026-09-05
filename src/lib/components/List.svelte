<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		/**
		 * An accessible name for the list, when the surrounding heading does
		 * not already supply one.
		 */
		label?: string;
		children: Snippet;
	}

	let { label, children }: Props = $props();
</script>

<!--
	A real <ul>. Screen readers announce "list, 6 items", which is how a
	non-sighted user knows how much is on the page before reading it — a
	stack of <div>s says nothing.
-->
<ul aria-label={label}>
	{@render children()}
</ul>

<style>
	ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	/* Dividers between rows, but not above the first or below the last, so a
	   flush card body has no doubled border against its own edge. */
	ul > :global(li + li) {
		border-top: 1px solid var(--c-border);
	}
</style>
