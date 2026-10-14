<script lang="ts">
	import { resolve } from '$app/paths';
	import { Badge, PageHeader, appPath } from '$lib/components';

	let { data } = $props();

	type Month = (typeof data.months)[number];

	const money = (amount: number): string =>
		new Intl.NumberFormat(undefined, { style: 'currency', currency: data.currency }).format(amount);

	const monthName = (month: string): string =>
		new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, {
			month: 'long',
			year: 'numeric',
			timeZone: 'UTC'
		});

	const quiet = (m: Month): boolean =>
		m.incomeExpected === 0 && m.incomeReceived === 0 && m.billPayments === 0 && m.saved === 0;

	const range = $derived(
		data.months.length > 0
			? `${monthName(data.months[data.months.length - 1]!.month)} – ${monthName(data.months[0]!.month)}`
			: ''
	);
</script>

<svelte:head><title>Money by month · LifeOS</title></svelte:head>

<PageHeader
	title="Money by month"
	description={range}
	back={{ href: '/finance', label: 'Financial Hub' }}
/>

<nav class="steps" aria-label="Other months">
	<a class="step" href={resolve(appPath(`/finance/months?to=${data.earlier}`))} rel="prev">
		← Earlier
	</a>
	{#if data.later}
		<a class="step" href={resolve(appPath(`/finance/months?to=${data.later}`))} rel="next">
			Later →
		</a>
	{/if}
</nav>

<ol class="months">
	{#each data.months as m (m.month)}
		<li>
			<article aria-labelledby={`month-${m.month}`}>
				<header>
					<h2 id={`month-${m.month}`}>{monthName(m.month)}</h2>
					{#if m.month === data.thisMonth}<Badge tone="accent">So far</Badge>{/if}
				</header>
				{#if quiet(m)}
					<p class="muted">Nothing recorded.</p>
				{:else}
					<dl>
						<div>
							<dt>Received</dt>
							<dd>
								{money(m.incomeReceived)}
								<span class="sub">of {money(m.incomeExpected)} expected</span>
							</dd>
						</div>
						<div>
							<dt>Bills paid</dt>
							<dd>
								{money(m.billsPaid)}
								<span class="sub"
									>{m.billPayments}
									{m.billPayments === 1 ? 'payment' : 'payments'}</span
								>
							</dd>
						</div>
						<div>
							<dt>Saved</dt>
							<dd>{money(m.saved)}</dd>
						</div>
					</dl>
				{/if}
			</article>
		</li>
	{/each}
</ol>

<style>
	.steps {
		display: flex;
		justify-content: space-between;
		gap: var(--sp-2);
		margin-bottom: var(--sp-4);
	}
	.step {
		display: inline-flex;
		align-items: center;
		min-height: var(--tap);
		padding: 0 var(--sp-3);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-pill);
		background: var(--c-surface);
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
		text-decoration: none;
		white-space: nowrap;
	}
	.step:hover {
		border-color: var(--c-accent);
		color: var(--c-text);
	}
	.step[rel='next'] {
		margin-left: auto;
	}

	.months {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
		gap: var(--sp-3);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	article {
		height: 100%;
		padding: var(--sp-4);
		border: 1px solid var(--c-border);
		border-radius: var(--radius);
		background: var(--c-surface);
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--sp-2);
		margin-bottom: var(--sp-3);
	}
	h2 {
		margin: 0;
		font-size: var(--fs-base);
		font-weight: 650;
	}
	dl {
		display: grid;
		gap: var(--sp-2);
		margin: 0;
	}
	dl > div {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: var(--sp-3);
	}
	dt {
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}
	dd {
		display: grid;
		justify-items: end;
		margin: 0;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.sub,
	.muted {
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
		font-weight: 400;
	}
	.muted {
		margin: 0;
		font-size: var(--fs-sm);
	}
</style>
