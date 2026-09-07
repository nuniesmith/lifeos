<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import {
		Badge,
		Button,
		Card,
		EmptyState,
		Input,
		List,
		ListRow,
		PageHeader,
		appPath
	} from '$lib/components';

	let { data, form } = $props();

	const KIND_LABELS: Record<string, string> = {
		me: 'Me',
		person: 'Person',
		place: 'Place',
		pet: 'Pet'
	};
</script>

<svelte:head><title>People &amp; Places · LifeOS</title></svelte:head>

<PageHeader title="People & Places" description="Who is in your life, and what they would like.">
	{#snippet meta()}<span>{data.people.length} recorded</span>{/snippet}
</PageHeader>

{#if form?.error}<p class="notice error" role="alert">{form.error}</p>{/if}

<div class="stack">
	{#if data.groups.length > 0}
		<div class="filters">
			<a class="chip" class:on={!data.group} href={resolve(appPath('/people'))}>Everyone</a>
			{#each data.groups as group (group)}
				<a
					class="chip"
					class:on={data.group === group}
					href={resolve(appPath(`/people?group=${encodeURIComponent(group)}`))}
				>
					{group}
				</a>
			{/each}
		</div>
	{/if}

	<Card>
		<form method="POST" action="?/add" class="add" use:enhance>
			<div class="grow">
				<Input label="Name" name="name" placeholder="Who or where?" required />
			</div>
			<div><Input label="Groups" name="groups" placeholder="Family, Friends" /></div>
			<Button type="submit">Add</Button>
		</form>
	</Card>

	<Card flush>
		{#if data.people.length === 0}
			<EmptyState
				title="Nobody recorded yet"
				description="Birthdays, gift ideas and the places that matter."
				icon="people"
			/>
		{:else}
			<List label="People and places">
				{#each data.people as person (person.id)}
					{@const gifts = data.giftsFor[person.id] ?? []}
					<ListRow title={person.name} meta={person.groups.join(' · ') || undefined}>
						{#snippet lead()}<Badge tone="neutral">{KIND_LABELS[person.kind] ?? person.kind}</Badge
							>{/snippet}
						{#snippet trail()}
							{#if person.birthday}<span class="quiet">Born {person.birthday}</span>{/if}
						{/snippet}
						{#if gifts.length > 0}
							<ul class="gifts">
								{#each gifts as gift (gift.id)}
									<li>{gift.name}{gift.occasion ? ` · ${gift.occasion}` : ''}</li>
								{/each}
							</ul>
						{/if}
					</ListRow>
				{/each}
			</List>
		{/if}
	</Card>
</div>

<style>
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
	}
	.filters {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-2);
	}
	.chip {
		padding: 0.15rem var(--sp-3);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-pill);
		background: var(--c-surface-alt);
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
		text-decoration: none;
	}
	.chip.on {
		border-color: var(--c-accent);
		background: color-mix(in srgb, var(--c-accent) 12%, transparent);
		color: var(--c-text);
	}
	.add {
		display: flex;
		gap: var(--sp-3);
		align-items: flex-end;
		flex-wrap: wrap;
	}
	.add .grow {
		flex: 1;
		min-width: 12rem;
	}
	.quiet {
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
	}
	.gifts {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-2);
		margin: 0.3rem 0 0;
		padding: 0;
		list-style: none;
	}
	.gifts li {
		padding: 0.05rem var(--sp-2);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-pill);
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
	}
	.notice {
		padding: var(--sp-2) var(--sp-3);
		border-radius: var(--radius-sm);
		margin-bottom: var(--sp-4);
	}
	.notice.error {
		color: var(--c-crit);
		border: 1px solid color-mix(in srgb, var(--c-crit) 25%, transparent);
		background: color-mix(in srgb, var(--c-crit) 8%, transparent);
	}
</style>
