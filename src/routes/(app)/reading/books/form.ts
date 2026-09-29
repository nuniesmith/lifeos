import type { Option } from '$lib/components';
import type {
	Book,
	BookAuthorRef,
	BookGenreRef,
	BookAudience,
	BookCategory,
	BookFormat,
	BookPace,
	BookStatus
} from '$lib/server/repositories';

/**
 * The book form's field set, shared between `/reading/books/new` and
 * `/reading/books/[id]` so the two cannot render the same field two
 * different ways. Everything is a plain string (or boolean for the two
 * checkboxes) because that is what a form field holds; the repository does
 * the real parsing on submit.
 */
export interface BookFormValues {
	title: string;
	subtitle: string;
	seriesName: string;
	seriesPosition: string;
	authorNames: string;
	genreNames: string;
	status: string;
	category: string;
	audience: string;
	format: string;
	owned: boolean;
	pages: string;
	audiobookMinutes: string;
	isbn: string;
	releaseDate: string;
	rating: string;
	favourite: boolean;
	spice: string;
	pace: string;
	tropes: string;
	moods: string;
	tags: string;
	contentWarnings: string;
	description: string;
	notes: string;
	storygraphUrl: string;
	recommendedBy: string;
}

export function emptyBookFormValues(): BookFormValues {
	return {
		title: '',
		subtitle: '',
		seriesName: '',
		seriesPosition: '',
		authorNames: '',
		genreNames: '',
		status: 'tbr',
		category: '',
		audience: '',
		format: '',
		owned: false,
		pages: '',
		audiobookMinutes: '',
		isbn: '',
		releaseDate: '',
		rating: '',
		favourite: false,
		spice: '',
		pace: '',
		tropes: '',
		moods: '',
		tags: '',
		contentWarnings: '',
		description: '',
		notes: '',
		storygraphUrl: '',
		recommendedBy: ''
	};
}

/** The edit page's starting values: the stored book plus its two joins,
 *  which do not live on the `Book` record itself. */
export function bookFormValuesFromRecord(
	book: Book,
	authors: readonly BookAuthorRef[],
	genres: readonly BookGenreRef[]
): BookFormValues {
	return {
		title: book.title,
		subtitle: book.subtitle ?? '',
		seriesName: '', // Filled in by the caller once the series name is known.
		seriesPosition: book.seriesPosition?.toString() ?? '',
		authorNames: authors.map((a) => a.name).join(', '),
		genreNames: genres.map((g) => g.name).join(', '),
		status: book.status,
		category: book.category ?? '',
		audience: book.audience ?? '',
		format: book.format ?? '',
		owned: book.owned,
		pages: book.pages?.toString() ?? '',
		audiobookMinutes: book.audiobookMinutes?.toString() ?? '',
		isbn: book.isbn ?? '',
		releaseDate: book.releaseDate ?? '',
		rating: book.rating?.toString() ?? '',
		favourite: book.favourite,
		spice: book.spice?.toString() ?? '',
		pace: book.pace ?? '',
		tropes: book.tropes.join(', '),
		moods: book.moods.join(', '),
		tags: book.tags.join(', '),
		contentWarnings: book.contentWarnings ?? '',
		description: book.description ?? '',
		notes: book.notes ?? '',
		storygraphUrl: book.storygraphUrl ?? '',
		recommendedBy: book.recommendedBy ?? ''
	};
}

/**
 * What a POST to the book form sends, read into the same shape a `Book`
 * displays as — so a refused save can redisplay exactly what was typed, and
 * a successful one hands the repository values it already validates itself.
 *
 * The two checkboxes are read as real booleans here — always present,
 * whichever way they are ticked — rather than left to `patched`'s "key
 * absent" rule, which a browser's own unchecked-box-omits-the-field
 * behaviour would otherwise trigger by accident (hard rule 5's cousin: the
 * form, not the repository, is where that gets fixed).
 */
export function bookFormValuesFromForm(form: FormData): BookFormValues {
	const text = (name: string) => String(form.get(name) ?? '');
	return {
		title: text('title'),
		subtitle: text('subtitle'),
		seriesName: text('seriesName'),
		seriesPosition: text('seriesPosition'),
		authorNames: text('authorNames'),
		genreNames: text('genreNames'),
		status: text('status'),
		category: text('category'),
		audience: text('audience'),
		format: text('format'),
		owned: form.get('owned') === 'on',
		pages: text('pages'),
		audiobookMinutes: text('audiobookMinutes'),
		isbn: text('isbn'),
		releaseDate: text('releaseDate'),
		rating: text('rating'),
		favourite: form.get('favourite') === 'on',
		spice: text('spice'),
		pace: text('pace'),
		tropes: text('tropes'),
		moods: text('moods'),
		tags: text('tags'),
		contentWarnings: text('contentWarnings'),
		description: text('description'),
		notes: text('notes'),
		storygraphUrl: text('storygraphUrl'),
		recommendedBy: text('recommendedBy')
	};
}

export const STATUS_LABELS: Record<BookStatus, string> = {
	tbr: 'TBR',
	reading: 'Reading',
	paused: 'Paused',
	read: 'Read',
	dnf: 'DNF'
};

export const CATEGORY_LABELS: Record<BookCategory, string> = {
	fiction: 'Fiction',
	nonfiction: 'Nonfiction'
};

export const AUDIENCE_LABELS: Record<BookAudience, string> = {
	adult: 'Adult',
	young_adult: 'Young adult',
	middle_grade: 'Middle grade',
	children: 'Children'
};

export const FORMAT_LABELS: Record<BookFormat, string> = {
	print: 'Print',
	ebook: 'Ebook',
	audiobook: 'Audiobook'
};

export const PACE_LABELS: Record<BookPace, string> = {
	slow: 'Slow',
	medium: 'Medium',
	fast: 'Fast'
};

/** Every quarter step from 0 to 5, the way StoryGraph rates — see
 *  `optionalQuarterRating` in reading.ts. `i / 4` lands exactly on each
 *  step (0.25 is exact in binary floating point), so the string this
 *  produces round-trips through the repository with no rounding surprise. */
export const RATING_OPTIONS: readonly Option[] = Array.from({ length: 21 }, (_, i) => {
	const value = (i / 4).toString();
	return { value, label: `${value} ★` };
});
