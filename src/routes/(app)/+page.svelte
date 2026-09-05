<script lang="ts">
	import { resolve } from '$app/paths';
</script>

<svelte:head><title>LifeOS</title></svelte:head>

<h1>LifeOS</h1>
<p class="lede">
	Self-hosted replacement for the Notion workspace. No application features are built yet — this
	page exists so the Phase&nbsp;1 gate can prove a clean clone starts, builds, and serves.
</p>
<p>
	<a href={resolve('/api/health/live')}>Liveness</a> ·
	<a href={resolve('/api/health/ready')}>Readiness</a>
</p>

<style>
	.lede {
		color: var(--c-text-muted);
		font-size: var(--fs-lg);
	}
</style>
