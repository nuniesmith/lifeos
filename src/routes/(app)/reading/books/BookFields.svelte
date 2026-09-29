<script lang="ts">
	import { Input, Select, Textarea } from '$lib/components';
	import {
		AUDIENCE_LABELS,
		CATEGORY_LABELS,
		FORMAT_LABELS,
		PACE_LABELS,
		RATING_OPTIONS,
		STATUS_LABELS,
		type BookFormValues
	} from './form';

	/**
	 * Every field on a book, shared between the new-book page and the edit
	 * form on the book's own page — see `./form.ts` for why.
	 */
	interface Props {
		values: BookFormValues;
	}
	let { values }: Props = $props();

	const statusOptions = Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }));
	const categoryOptions = Object.entries(CATEGORY_LABELS).map(([value, label]) => ({
		value,
		label
	}));
	const audienceOptions = Object.entries(AUDIENCE_LABELS).map(([value, label]) => ({
		value,
		label
	}));
	const formatOptions = Object.entries(FORMAT_LABELS).map(([value, label]) => ({ value, label }));
	const paceOptions = Object.entries(PACE_LABELS).map(([value, label]) => ({ value, label }));
</script>

<Input
	label="Title"
	name="title"
	value={values.title}
	required
	maxlength={300}
	autocomplete="off"
/>
<Input label="Subtitle" name="subtitle" value={values.subtitle} maxlength={300} />

<div class="row">
	<Input
		label="Series"
		name="seriesName"
		value={values.seriesName}
		placeholder="Series name, if any"
	/>
	<Input
		label="Position in series"
		name="seriesPosition"
		type="number"
		inputmode="decimal"
		step="0.01"
		min="0.01"
		value={values.seriesPosition}
		hint="1.5 works, for a novella between two books."
	/>
</div>

<Input
	label="Authors"
	name="authorNames"
	value={values.authorNames}
	placeholder="Comma-separated: Ann Leckie, N.K. Jemisin"
/>
<Input
	label="Genres"
	name="genreNames"
	value={values.genreNames}
	placeholder="Comma-separated: Cozy Mystery, Fantasy"
/>

<div class="row">
	<Select label="Status" name="status" options={statusOptions} value={values.status} />
	<Select
		label="Category"
		name="category"
		options={categoryOptions}
		placeholder="Not set"
		value={values.category}
	/>
	<Select
		label="Audience"
		name="audience"
		options={audienceOptions}
		placeholder="Not set"
		value={values.audience}
	/>
	<Select
		label="Format"
		name="format"
		options={formatOptions}
		placeholder="Not set"
		value={values.format}
	/>
</div>

<div class="row">
	<Input
		label="Pages"
		name="pages"
		type="number"
		inputmode="numeric"
		min="1"
		value={values.pages}
	/>
	<Input
		label="Audiobook length"
		name="audiobookMinutes"
		type="number"
		inputmode="numeric"
		min="1"
		value={values.audiobookMinutes}
		hint="Minutes"
	/>
	<Input label="ISBN" name="isbn" value={values.isbn} placeholder="10 or 13 digits" />
	<Input label="Release date" name="releaseDate" type="date" value={values.releaseDate} />
</div>

<div class="row">
	<Select
		label="Rating"
		name="rating"
		options={RATING_OPTIONS}
		placeholder="Not rated"
		value={values.rating}
	/>
	<Input
		label="Spice"
		name="spice"
		type="number"
		inputmode="numeric"
		min="0"
		max="5"
		value={values.spice}
		hint="0 to 5"
	/>
	<Select
		label="Pace"
		name="pace"
		options={paceOptions}
		placeholder="Not set"
		value={values.pace}
	/>
</div>

<div class="checks">
	<label class="check">
		<input type="checkbox" name="owned" checked={values.owned} />
		<span>Owned</span>
	</label>
	<label class="check">
		<input type="checkbox" name="favourite" checked={values.favourite} />
		<span>Favourite</span>
	</label>
</div>

<Input label="Tropes" name="tropes" value={values.tropes} placeholder="Comma-separated" />
<Input label="Moods" name="moods" value={values.moods} placeholder="Comma-separated" />
<Input label="Tags" name="tags" value={values.tags} placeholder="Comma-separated" />
<Textarea label="Content warnings" name="contentWarnings" value={values.contentWarnings} rows={2} />

<Textarea
	label="Description"
	name="description"
	value={values.description}
	rows={4}
	hint="Markdown works: headings, lists, links."
/>
<Textarea
	label="Notes"
	name="notes"
	value={values.notes}
	rows={4}
	hint="Markdown works: headings, lists, links."
/>

<Input
	label="StoryGraph link"
	name="storygraphUrl"
	value={values.storygraphUrl}
	placeholder="https://"
/>
<Input label="Recommended by" name="recommendedBy" value={values.recommendedBy} />

<style>
	.row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 10rem), 1fr));
		gap: var(--sp-4);
	}
	.checks {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-4);
	}
	.check {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		min-height: var(--tap);
		font-size: var(--fs-sm);
	}
</style>
