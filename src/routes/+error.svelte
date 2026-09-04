<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
</script>

<svelte:head><title>{page.status} · LifeOS</title></svelte:head>

<h1>{page.status}</h1>
<p>{page.error?.message ?? 'Something went wrong.'}</p>
{#if page.error?.requestId}
	<p class="rid">Reference <code>{page.error.requestId}</code></p>
{/if}
<p><a href={resolve('/')}>Back to start</a></p>

<style>
	.rid {
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}
	code {
		font-family: var(--font-mono);
	}
</style>
