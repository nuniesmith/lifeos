<script lang="ts">
	import { onMount } from 'svelte';

	type Theme = 'light' | 'dark';

	let theme = $state<Theme>('dark');

	function setTheme(next: Theme) {
		theme = next;
		document.documentElement.dataset.theme = next;
		localStorage.setItem('lifeos-theme', next);
	}

	function toggle() {
		setTheme(theme === 'dark' ? 'light' : 'dark');
	}

	onMount(() => {
		const saved = localStorage.getItem('lifeos-theme');
		if (saved === 'light' || saved === 'dark') theme = saved;
		else theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
	});
</script>

<button
	type="button"
	class="theme-toggle"
	aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
	aria-pressed={theme === 'light'}
	onclick={toggle}
>
	<span class="sun" aria-hidden="true">☼</span>
	<span class="track"><span class="thumb"></span></span>
	<span class="moon" aria-hidden="true">☾</span>
</button>

<style>
	.theme-toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		min-height: 2.25rem;
		padding: 0 0.35rem;
		border: 1px solid var(--c-border);
		border-radius: 999px;
		background: var(--c-surface);
		color: var(--c-text-muted);
		cursor: pointer;
	}
	.theme-toggle:hover {
		color: var(--c-text);
		border-color: var(--c-text-muted);
	}
	.sun,
	.moon {
		font-size: 0.9rem;
		line-height: 1;
	}
	.track {
		position: relative;
		width: 1.7rem;
		height: 0.95rem;
		border-radius: 999px;
		background: var(--c-border);
	}
	.thumb {
		position: absolute;
		top: 2px;
		left: 2px;
		width: calc(0.95rem - 4px);
		height: calc(0.95rem - 4px);
		border-radius: 50%;
		background: var(--c-text);
		transition: transform var(--dur-fast) var(--ease);
	}
	.theme-toggle[aria-pressed='true'] .thumb {
		transform: translateX(0.75rem);
	}
	@media (max-width: 47.999rem) {
		.theme-toggle {
			min-width: 44px;
			min-height: 44px;
			justify-content: center;
			padding: 0 0.25rem;
		}
		.theme-toggle .sun,
		.theme-toggle .moon {
			display: none;
		}
	}
</style>
