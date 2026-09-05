<script lang="ts">
	let { data } = $props();
</script>

<svelte:head><title>Audit · LifeOS</title></svelte:head>

<h1>Audit</h1>
<p class="lede">Authentication and account events. Record content never appears here.</p>

<div class="scroll-x">
	<table>
		<thead><tr><th>When</th><th>Event</th><th>Detail</th></tr></thead>
		<tbody>
			{#each data.entries as e (e.id)}
				<tr>
					<td class="numeric">{new Date(e.at).toLocaleString()}</td>
					<td><code>{e.event}</code></td>
					<td class="detail">{JSON.stringify(e.detail)}</td>
				</tr>
			{:else}
				<tr><td colspan="3" class="empty">No events recorded yet.</td></tr>
			{/each}
		</tbody>
	</table>
</div>

<style>
	.lede {
		color: var(--c-text-muted);
	}
	table {
		width: 100%;
		font-size: var(--fs-sm);
	}
	th,
	td {
		text-align: left;
		padding: var(--sp-2) var(--sp-3);
		border-bottom: 1px solid var(--c-border);
		vertical-align: top;
	}
	th {
		color: var(--c-text-muted);
	}
	code {
		font-family: var(--font-mono);
	}
	.detail {
		color: var(--c-text-muted);
		max-width: 40ch;
		overflow-wrap: anywhere;
	}
	.empty {
		color: var(--c-text-muted);
		text-align: center;
		padding: var(--sp-8);
	}
</style>
