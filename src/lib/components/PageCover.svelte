<script lang="ts">
	import { base } from '$app/paths';
	import type { PageTheme } from './page-themes';

	interface Props {
		theme: PageTheme;
	}

	let { theme }: Props = $props();
</script>

<div class="page-cover" class:plain={!theme.image}>
	{#if theme.image}
		<img
			src={`${base}${theme.image}`}
			alt={theme.alt}
			width="1920"
			height="540"
			fetchpriority="high"
		/>
	{:else}
		<div class="cover-fallback" aria-label={theme.alt} role="img">
			{#if theme.icon}
				<img class="fallback-icon" src={`${base}${theme.icon}`} alt="" width="188" height="164" />
			{:else}
				<span>{theme.mark ?? '✦'}</span>
			{/if}
		</div>
	{/if}
</div>

<style>
	.page-cover {
		position: relative;
		height: clamp(9rem, 12vw, 12rem);
		overflow: hidden;
		background: var(--c-surface-alt);
		border-bottom: 1px solid var(--c-border);
	}

	.page-cover::after {
		content: '';
		position: absolute;
		inset: auto 0 0;
		height: 2.5rem;
		background: linear-gradient(transparent, rgb(25 25 24 / 0.14));
		pointer-events: none;
	}

	img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
		object-position: center;
	}

	.cover-fallback {
		display: grid;
		place-items: center;
		height: 100%;
		background:
			radial-gradient(
				circle at 50% 35%,
				color-mix(in srgb, var(--page-accent) 32%, transparent),
				transparent 42%
			),
			linear-gradient(
				110deg,
				color-mix(in srgb, var(--page-accent-soft) 86%, var(--c-surface-alt)),
				var(--c-surface-alt)
			);
		color: var(--page-accent);
		font-size: clamp(2.2rem, 5vw, 4rem);
		font-weight: 300;
	}

	.fallback-icon {
		width: min(11rem, 22vw);
		height: min(9rem, 18vw);
		object-fit: contain;
		filter: drop-shadow(0 0.5rem 0.75rem rgb(0 0 0 / 0.18));
	}

	@media (max-width: 47.999rem) {
		.page-cover {
			height: 8rem;
		}
	}
</style>
