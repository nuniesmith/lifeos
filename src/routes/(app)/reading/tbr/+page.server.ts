import {
	BOOK_FORMATS,
	getGenre,
	listBooks,
	listGenres,
	pickTbr,
	type BookFormat
} from '$lib/server/repositories';
import { sql } from '$lib/server/db';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * The TBR pile (Reading Tracker R2): every book on the viewer's to-be-read
 * shelf, oldest added first — a queue worked through front-to-back, the
 * opposite order from the home page's "Up next" (reading.ts's `listBooks`
 * order comment) — plus "Pick my next read", the same shape as
 * /entertainment/pick (plan §13's "what should we watch?").
 *
 * The genre/format/owned filters travel as query params for the list below,
 * the same reason /reading/books's filters do (that page's own comment): a
 * shared or reloaded link reproduces the same list. The picker starts from
 * those same three query params, but "Another" re-rolls from its own inline
 * filters (this form's own <Select>s) rather than navigating — exactly how
 * /entertainment/pick's `roll` action works.
 */

const isBookFormat = (value: string | null): value is BookFormat =>
	value !== null && (BOOK_FORMATS as readonly string[]).includes(value);

export const load: PageServerLoad = async ({ locals, url }) => {
	const viewer = await requireViewer(locals.user);

	const genreId = url.searchParams.get('genre') ?? '';
	const formatParam = url.searchParams.get('format');
	const format = isBookFormat(formatParam) ? formatParam : undefined;
	const owned = url.searchParams.get('owned') === '1';

	const filters = {
		...(genreId ? { genreId } : {}),
		...(format ? { format } : {}),
		...(owned ? { owned: true as const } : {})
	};

	const [books, genres, activeGenre, suggestion] = await Promise.all([
		listBooks(sql, viewer, { status: 'tbr', order: 'tbr_added_asc', limit: 300, ...filters }),
		listGenres(sql, viewer, { limit: 300 }),
		genreId ? getGenre(sql, viewer, genreId) : Promise.resolve(null),
		pickTbr(sql, viewer, filters)
	]);

	return {
		books,
		genres,
		formats: BOOK_FORMATS,
		activeGenre,
		filters: { genreId, format: format ?? '', owned },
		suggestion,
		suggestionFilters: { genreId, format: format ?? '', owned: owned ? '1' : '' }
	};
};

export const actions: Actions = {
	roll: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const genreId = String(form.get('genreId') ?? '');
		const formatRaw = form.get('format');
		const format = isBookFormat(typeof formatRaw === 'string' ? formatRaw : null)
			? (formatRaw as BookFormat)
			: undefined;
		const owned = form.get('owned') === '1';

		const suggestion = await pickTbr(sql, viewer, {
			...(genreId ? { genreId } : {}),
			...(format ? { format } : {}),
			...(owned ? { owned: true } : {})
		});

		return {
			suggestion,
			suggestionFilters: { genreId, format: format ?? '', owned: owned ? '1' : '' }
		};
	}
};
