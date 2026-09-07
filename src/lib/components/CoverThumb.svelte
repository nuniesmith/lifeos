<script lang="ts">
	import { resolve } from '$app/paths';
	import { appPath } from './nav';

	/**
	 * A record's Notion page cover, at list-row size.
	 *
	 * Decorative: every place this is used sits next to the record's own name,
	 * so an alt text here would be read out as a duplicate — or worse, as the
	 * original filename, which is what the export actually gives us. Empty alt
	 * is the correct answer for an image that adds nothing a screen reader
	 * cannot already get from the row.
	 */
	interface Props {
		cover: { id: string; width: number | null; height: number | null } | null;
	}

	let { cover }: Props = $props();
</script>

{#if cover}
	<img
		class="thumb"
		src={resolve(appPath(`/api/media/${cover.id}`))}
		alt=""
		width={cover.width ?? undefined}
		height={cover.height ?? undefined}
		loading="lazy"
		decoding="async"
	/>
{/if}

<style>
	.thumb {
		display: block;
		width: 3rem;
		height: 3rem;
		object-fit: cover;
		border-radius: 0.375rem;
	}
</style>
