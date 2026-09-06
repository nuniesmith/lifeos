<script lang="ts">
	import { resolve } from '$app/paths';
	import { appPath } from './nav';
	import PageHeader from './PageHeader.svelte';

	export interface WorkspaceItem {
		label: string;
		body: string;
		symbol?: string;
		href?: string;
		meta?: string;
	}

	export interface WorkspaceSection {
		title: string;
		body: string;
		accent?: string;
		items: readonly WorkspaceItem[];
	}

	interface Props {
		title: string;
		description: string;
		sections: readonly WorkspaceSection[];
		actions?: readonly { label: string; href: string }[];
	}

	let { title, description, sections, actions: headerActions = [] }: Props = $props();
</script>

<svelte:head>
	<title>{title} · LifeOS</title>
</svelte:head>

<PageHeader {title} {description}>
	{#snippet actions()}
		{#each headerActions as action (action.href)}
			<a class="header-action" href={resolve(appPath(action.href))}>{action.label}</a>
		{/each}
	{/snippet}
</PageHeader>

<div class="workspace-page">
	{#each sections as section (section.title)}
		<section
			class="workspace-section"
			style:--section-accent={section.accent ?? 'var(--c-accent)'}
			aria-labelledby={`section-${section.title}`}
		>
			<div class="section-heading">
				<span class="section-rule" aria-hidden="true"></span>
				<div>
					<h2 id={`section-${section.title}`}>{section.title}</h2>
					<p>{section.body}</p>
				</div>
			</div>

			<div class="tile-grid">
				{#each section.items as item (item.label)}
					{#if item.href}
						<a class="tile" href={resolve(appPath(item.href))}>
							<span class="tile-symbol" aria-hidden="true">{item.symbol ?? '•'}</span>
							<span class="tile-copy">
								<strong>{item.label}</strong>
								<span>{item.body}</span>
							</span>
							<span class="tile-arrow" aria-hidden="true">↗</span>
						</a>
					{:else}
						<div class="tile">
							<span class="tile-symbol" aria-hidden="true">{item.symbol ?? '•'}</span>
							<span class="tile-copy">
								<strong>{item.label}</strong>
								<span>{item.body}</span>
							</span>
							{#if item.meta}<span class="tile-meta">{item.meta}</span>{/if}
						</div>
					{/if}
				{/each}
			</div>
		</section>
	{/each}
</div>

<style>
	.workspace-page {
		display: grid;
		gap: var(--sp-8);
	}

	.header-action {
		display: inline-flex;
		align-items: center;
		min-height: var(--tap);
		padding: 0 var(--sp-3);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-sm);
		background: var(--c-surface);
		color: var(--c-text);
		font-size: var(--fs-sm);
		text-decoration: none;
	}
	.header-action:hover {
		border-color: var(--page-accent, var(--c-accent));
		background: var(--c-surface-alt);
	}

	.workspace-section {
		--section-accent: var(--c-accent);
		padding: var(--sp-5);
		border: 1px solid var(--c-border);
		border-left: 3px solid var(--section-accent);
		border-radius: var(--radius);
		background: var(--c-surface);
	}

	.section-heading {
		display: flex;
		gap: var(--sp-4);
		align-items: flex-start;
		margin-bottom: var(--sp-5);
	}
	.section-rule {
		flex: 0 0 0.75rem;
		width: 0.75rem;
		height: 0.75rem;
		margin-top: 0.35rem;
		border-radius: 50%;
		background: var(--section-accent);
		box-shadow: 0 0 0 5px color-mix(in srgb, var(--section-accent) 15%, transparent);
	}
	h2 {
		margin: 0 0 var(--sp-1);
		font-size: var(--fs-xl);
		font-weight: 650;
	}
	.section-heading p {
		margin: 0;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
		font-style: italic;
	}

	.tile-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr));
		gap: var(--sp-3);
	}
	.tile {
		position: relative;
		display: flex;
		align-items: flex-start;
		gap: var(--sp-3);
		min-height: 5.6rem;
		padding: var(--sp-4);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-sm);
		background: var(--c-surface-alt);
		color: var(--c-text);
		text-decoration: none;
	}
	a.tile:hover {
		border-color: var(--section-accent);
		transform: translateY(-1px);
	}
	.tile-symbol {
		flex: 0 0 auto;
		width: 1.8rem;
		color: var(--section-accent);
		font-size: 1.25rem;
		line-height: 1.3;
		text-align: center;
	}
	.tile-copy {
		display: grid;
		gap: 0.2rem;
		min-width: 0;
	}
	.tile-copy strong {
		font-size: var(--fs-base);
		font-weight: 620;
	}
	.tile-copy span {
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}
	.tile-arrow,
	.tile-meta {
		margin-left: auto;
		color: var(--section-accent);
		font-size: var(--fs-sm);
	}
	.tile-meta {
		align-self: flex-end;
		font-size: var(--fs-xs);
	}
	@media (max-width: 47.999rem) {
		.workspace-section {
			padding: var(--sp-4);
		}
		.workspace-page {
			gap: var(--sp-6);
		}
	}
</style>
