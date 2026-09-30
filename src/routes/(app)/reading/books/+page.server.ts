import {
	BOOK_STATUSES,
	getAuthor,
	getBookSeries,
	getGenre,
	listBooks,
	type BookFilters,
	type BookStatus
} from '$lib/server/repositories';
import { sql } from '$lib/server/db';
import { requireViewer } from '$lib/server/viewer';
import type { PageServerLoad } from './$types';

/**
 * The book catalogue (Reading Tracker R1).
 *
 * Filters travel as query params rather than form state, so a link from the
 * author, series or genre pages ("this author's books") is a plain URL
 * anyone can bookmark or share, not a client-side selection that resets on
 * reload.
 */

const isBookStatus = (value: string | null): value is BookStatus =>
	value !== null && (BOOK_STATUSES as readonly string[]).includes(value);

export const load: PageServerLoad = async ({ locals, url }) => {
	const viewer = await requireViewer(locals.user);

	const status = url.searchParams.get('status');
	const authorId = url.searchParams.get('author') ?? '';
	const seriesId = url.searchParams.get('series') ?? '';
	const genreId = url.searchParams.get('genre') ?? '';
	const owned = url.searchParams.get('owned') === '1';
	const search = url.searchParams.get('q') ?? '';

	const filters: BookFilters = {
		limit: 300,
		...(isBookStatus(status) ? { status } : {}),
		...(authorId ? { authorId } : {}),
		...(seriesId ? { seriesId } : {}),
		...(genreId ? { genreId } : {}),
		...(owned ? { owned: true } : {}),
		...(search.trim() ? { search: search.trim() } : {})
	};

	const [books, activeAuthor, activeSeries, activeGenre] = await Promise.all([
		listBooks(sql, viewer, filters),
		authorId ? getAuthor(sql, viewer, authorId) : Promise.resolve(null),
		seriesId ? getBookSeries(sql, viewer, seriesId) : Promise.resolve(null),
		genreId ? getGenre(sql, viewer, genreId) : Promise.resolve(null)
	]);

	return {
		books,
		statuses: BOOK_STATUSES,
		filters: {
			status: isBookStatus(status) ? status : '',
			authorId,
			seriesId,
			genreId,
			owned,
			search
		},
		activeAuthor,
		activeSeries,
		activeGenre
	};
};
