<script lang="ts" module>
	/** What the two tag actions return. The editor's own results pass by. */
	export interface TagResult {
		tag?: { id: string; on: boolean; added: boolean };
		tagError?: string;
		/** Which list's add form failed, so the message sits beside it. */
		tagKind?: string;
	}
</script>

<script lang="ts">
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { Badge, Button, Card, Icon, Input } from '$lib/components';
	import type { JournalTagGroup, JournalTagKind, JournalTags } from './health-tags';

	interface Props {
		/** The day the page shows; every form carries it, never an entry id. */
		date: string;
		tags: JournalTags;
		result?: TagResult | null;
	}

	let { date, tags, result }: Props = $props();

	const LABELS: Record<JournalTagKind, string> = {
		symptom: 'Symptoms',
		activity: 'Activity',
		exercise: 'Exercise'
	};

	/** Singular, for the add control, which names one thing. */
	const SINGULAR: Record<JournalTagKind, string> = {
		symptom: 'symptom',
		activity: 'activity',
		exercise: 'exercise'
	};

	/** The lists shown read-only, as `/health` names them. */
	const ELSEWHERE: Record<string, string> = { mood: 'Mood', energy: 'Energy' };

	/** The word the last action touched, looked up in the data it reloaded. */
	const touched = $derived.by(() => {
		const id = result?.tag?.id;
		if (!id) return null;
		for (const group of tags.groups) {
			const word = group.words.find((w) => w.id === id);
			if (word) return { name: word.name, kind: group.kind };
		}
		return null;
	});

	/**
	 * Said once, for a screen reader, after a tap. The button's own pressed
	 * state changes too, but a state change that arrives with a network round
	 * trip is not reliably announced on its own.
	 */
	const status = $derived.by(() => {
		const tag = result?.tag;
		if (!tag) return '';
		const name = touched?.name ?? 'That word';
		if (!tag.on) return `${name} taken off this day.`;
		return tag.added ? `${name} added to the list and tagged.` : `${name} tagged.`;
	});

	/**
	 * Which lists start open. A list with something tagged, so it can be
	 * untagged in one tap; an empty one, so its add field is in view; and the
	 * one just acted on, so a page reloaded without JavaScript comes back to
	 * where the person was. Everything else stays a one-line summary: forty
	 * symptoms open at once is a screenful of scrolling on a phone.
	 */
	const opened = (group: JournalTagGroup): boolean =>
		group.words.length === 0 ||
		group.words.some((word) => word.tagged) ||
		touched?.kind === group.kind ||
		result?.tagKind === group.kind;

	/**
	 * `use:enhance`, but focus stays on the control that was used.
	 *
	 * SvelteKit's `applyAction` moves focus to the top of the page after a
	 * successful submit, as it would after a navigation. A toggle is not a
	 * navigation: sent back to the top after every word, a keyboard user would
	 * have to tab through the whole editor to reach the next one.
	 */
	const keepFocus: SubmitFunction =
		({ submitter }) =>
		async ({ update }) => {
			await update();
			if (submitter instanceof HTMLElement && submitter.isConnected) {
				submitter.focus({ preventScroll: true });
			}
		};

	const pickedIn = (group: JournalTagGroup): string =>
		group.words
			.filter((word) => word.tagged)
			.map((word) => word.name)
			.join(', ') || 'Nothing tagged';
</script>

<Card title="What you noticed" subtitle="Private to you, and counted on Health">
	<!-- Always in the document, so a change to its text is announced. A
	     polite live region rather than role="status": the page's status is
	     the editor's "Saved." line, and this only echoes a control's own
	     state to a screen reader. -->
	<p class="sr-only" aria-live="polite" aria-atomic="true">{status}</p>

	{#if result?.tagError && !result.tagKind}
		<p class="notice" role="alert">{result.tagError}</p>
	{/if}

	<div class="groups">
		{#each tags.groups as group (group.kind)}
			<details class="group" open={opened(group)}>
				<summary>
					<span class="titles">
						<span class="kind">{LABELS[group.kind]}</span>
						<!-- The tagged words in text, so what is on the day reads
						     without opening the list or telling colours apart. -->
						<span class="picked">{pickedIn(group)}</span>
					</span>
					<span class="chevron" aria-hidden="true"><Icon name="chevron" size={18} /></span>
				</summary>

				{#if group.words.length === 0}
					<p class="empty">No {LABELS[group.kind].toLowerCase()} on the list yet.</p>
				{:else}
					<ul class="words" aria-label={`${LABELS[group.kind]} for this day`}>
						{#each group.words as word (word.id)}
							<li>
								<!-- The state asked for travels, not a flip: a double tap
								     lands on the same row instead of undoing itself. -->
								<form method="POST" action="?/tag" use:enhance={keepFocus}>
									<input type="hidden" name="date" value={date} />
									<input type="hidden" name="id" value={word.id} />
									<input type="hidden" name="on" value={word.tagged ? 'false' : 'true'} />
									<button type="submit" class="word" aria-pressed={word.tagged}>
										<span class="mark" aria-hidden="true">
											<Icon name={word.tagged ? 'check' : 'plus'} size={16} />
										</span>
										<span class="name">{word.name}</span>
									</button>
								</form>
							</li>
						{/each}
					</ul>
				{/if}

				<form method="POST" action="?/addTag" class="add" use:enhance={keepFocus}>
					<input type="hidden" name="date" value={date} />
					<input type="hidden" name="kind" value={group.kind} />
					<div class="grow">
						<Input
							label={`New ${SINGULAR[group.kind]}`}
							name="name"
							required
							maxlength={200}
							autocomplete="off"
						/>
					</div>
					<!-- Three of these on the page; the name says which list. -->
					<Button type="submit" icon="plus" aria-label={`Add ${SINGULAR[group.kind]} and tag it`}
						>Add</Button
					>
				</form>
				{#if result?.tagError && result.tagKind === group.kind}
					<p class="notice inside" role="alert">{result.tagError}</p>
				{/if}
			</details>
		{/each}
	</div>

	{#if tags.alsoLogged.length > 0}
		<div class="elsewhere">
			<p class="also">Also on this day</p>
			<ul>
				{#each tags.alsoLogged as term (term.id)}
					<li><Badge>{ELSEWHERE[term.kind] ?? term.kind}</Badge> {term.name}</li>
				{/each}
			</ul>
			<p class="footnote">
				Imported with the day. Mood and energy are recorded in the entry above.
			</p>
		</div>
	{/if}

	<p class="footnote">
		A new word joins the household's list. Which days you tag stays private to you.
	</p>
</Card>

<style>
	.groups {
		display: flex;
		flex-direction: column;
		gap: var(--sp-2);
	}

	.group {
		border: 1px solid var(--c-border);
		border-radius: var(--radius-sm);
		background: var(--c-surface);
	}

	summary {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		min-height: var(--tap);
		padding: var(--sp-2) var(--sp-3);
		cursor: pointer;
		list-style: none;
	}
	summary::-webkit-details-marker {
		display: none;
	}
	/* "Nothing tagged" sits beside the list's name; a longer run of tagged
	   words drops to its own full-width line rather than being squeezed into
	   a column beside it, or pushing the chevron and the page sideways. */
	.titles {
		display: flex;
		flex: 1;
		flex-wrap: wrap;
		align-items: baseline;
		column-gap: var(--sp-2);
		min-width: 0;
	}
	.kind {
		flex: none;
		font-weight: 600;
	}
	.picked {
		min-width: 0;
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
		line-height: 1.4;
		overflow-wrap: anywhere;
	}
	.chevron {
		flex: none;
		color: var(--c-text-muted);
		transition: transform var(--dur-fast) var(--ease);
	}
	details[open] .chevron {
		transform: rotate(90deg);
	}

	.empty {
		margin: 0;
		padding: 0 var(--sp-3) var(--sp-2);
		color: var(--c-text-muted);
		font-size: var(--fs-sm);
	}

	.words {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-2);
		margin: 0;
		padding: 0 var(--sp-3) var(--sp-3);
		list-style: none;
	}
	.words li {
		max-width: 100%;
	}

	/* A pill, but a full-height one: this is the control, not a label on it. */
	.word {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-1);
		max-width: 100%;
		min-height: var(--tap);
		padding: var(--sp-1) var(--sp-3) var(--sp-1) var(--sp-2);
		border: 1px solid var(--c-border);
		border-radius: var(--radius-pill);
		background: var(--c-surface-alt);
		color: var(--c-text);
		font-size: var(--fs-sm);
		line-height: 1.3;
		text-align: left;
		cursor: pointer;
	}
	.word:hover {
		border-color: var(--c-accent);
	}
	/* Tagged is said three ways — the tick in place of the plus, the weight
	   and the fill — so it survives a colour-blind eye and a grey printout. */
	.word[aria-pressed='true'] {
		border-color: var(--c-accent);
		background: var(--c-accent-soft);
		font-weight: 600;
	}
	.mark {
		display: inline-flex;
		flex: none;
		color: var(--c-text-muted);
	}
	.word[aria-pressed='true'] .mark {
		color: var(--c-accent);
	}
	.name {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.add {
		display: flex;
		gap: var(--sp-2);
		align-items: flex-end;
		padding: 0 var(--sp-3) var(--sp-3);
	}
	.grow {
		flex: 1;
		min-width: 0;
	}

	.notice {
		margin: 0 0 var(--sp-3);
		padding: var(--sp-2) var(--sp-3);
		border: 1px solid color-mix(in srgb, var(--c-crit) 25%, transparent);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--c-crit) 8%, transparent);
		color: var(--c-crit);
	}
	.notice.inside {
		margin: 0 var(--sp-3) var(--sp-3);
	}

	.elsewhere {
		margin-top: var(--sp-4);
	}
	.also {
		margin: 0 0 var(--sp-2);
		font-size: var(--fs-sm);
		font-weight: 600;
		color: var(--c-text-muted);
	}
	.elsewhere ul {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-2) var(--sp-4);
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: var(--fs-sm);
	}

	.footnote {
		margin: var(--sp-3) 0 0;
		color: var(--c-text-muted);
		font-size: var(--fs-xs);
	}
</style>
