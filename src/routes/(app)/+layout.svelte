<script lang="ts">
	import { resolve } from '$app/paths';
	let { data, children } = $props();
</script>

<header>
	<a class="brand" href={resolve('/')}>LifeOS</a>
	<nav>
		{#if data.user?.role === 'admin'}
			<a href={resolve('/admin/people')}>People</a>
			<a href={resolve('/admin/audit')}>Audit</a>
		{/if}
		<span class="who">{data.user?.displayName}</span>
		<form method="POST" action="/logout">
			<button type="submit">Sign out</button>
		</form>
	</nav>
</header>

{@render children()}

<style>
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--sp-4);
		padding-bottom: var(--sp-4);
		margin-bottom: var(--sp-6);
		border-bottom: 1px solid var(--c-border);
	}
	.brand {
		font-weight: 700;
		text-decoration: none;
		color: var(--c-text);
	}
	nav {
		display: flex;
		align-items: center;
		gap: var(--sp-3);
	}
	.who {
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}
	nav a {
		font-size: var(--fs-sm);
		text-decoration: none;
	}
	nav a:hover {
		text-decoration: underline;
	}
	button {
		background: none;
		border: 1px solid var(--c-border);
		border-radius: var(--radius-sm);
		padding: var(--sp-1) var(--sp-3);
		min-height: 36px;
		cursor: pointer;
	}
</style>
