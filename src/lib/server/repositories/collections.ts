import type { Fragment } from 'postgres';
import type { Viewer } from '../auth/authz';
import {
	InvalidInput,
	baseColumns,
	guarded,
	isUuid,
	liveScope,
	mapBase,
	pageOf,
	readableScope,
	resolveOwnership,
	toBool,
	toDayOrNull,
	toInt,
	toIntOrNull,
	toNumberOrNull,
	toText,
	toTextOrNull,
	writableBy,
	writableScope,
	writeScoped,
	type BaseRow,
	type OwnershipInput,
	type PageOptions,
	type Queryable,
	type RecordBase,
	type WriteResult
} from './base';
import { toDateOrNull } from '../db/coerce';
import { optionalText, requiredText } from './validate';

/**
 * People, wishlist, watchlist and bills (MODEL-002, feature pack 4).
 *
 * Grouped because they reference each other: a wishlist item is for a person,
 * and a subscription is both a bill and the streaming service the watchlist
 * points at. See migration 0014.
 */

const toStringArray = (value: unknown): string[] =>
	Array.isArray(value) ? value.map((v) => String(v)) : [];

function oneOf<T extends string>(
	value: unknown,
	allowed: readonly T[],
	label: string,
	fallback: T
): T {
	if (value === undefined || value === null || value === '') return fallback;
	const v = String(value)
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, '_');
	if (!allowed.includes(v as T)) {
		throw new InvalidInput(`${label} must be one of ${allowed.join(', ')}`);
	}
	return v as T;
}

// ─── people ────────────────────────────────────────────────────────────────

export const PERSON_KINDS = ['me', 'person', 'place', 'pet'] as const;
export type PersonKind = (typeof PERSON_KINDS)[number];

export interface Person extends RecordBase {
	name: string;
	kind: PersonKind;
	groups: string[];
	birthday: string | null;
	notes: string | null;
}

interface PersonRow extends BaseRow {
	name: string;
	kind: string;
	groups: unknown;
	birthday: string | null;
	notes: string | null;
}

const PEOPLE = 'people';

const peopleColumns = (sql: Queryable): Fragment => sql`
	${baseColumns(sql)},
	name, kind, groups, birthday::text as birthday, notes`;

const mapPerson = (row: PersonRow): Person => ({
	...mapBase(row),
	name: toText(row.name),
	kind: row.kind as PersonKind,
	groups: toStringArray(row.groups),
	birthday: toDayOrNull(row.birthday),
	notes: toTextOrNull(row.notes)
});

export interface PersonFilters extends PageOptions {
	kind?: PersonKind | readonly PersonKind[];
	group?: string;
	search?: string;
	includeArchived?: boolean;
}

export async function listPeople(
	sql: Queryable,
	viewer: Viewer,
	filters: PersonFilters = {}
): Promise<Person[]> {
	const { limit, offset } = pageOf(filters);
	const kinds = filters.kind ? (Array.isArray(filters.kind) ? filters.kind : [filters.kind]) : null;

	const rows = await sql<PersonRow[]>`
		select ${peopleColumns(sql)} from ${sql(PEOPLE)}
		where ${readableScope(sql, viewer, PEOPLE)}
		  and ${liveScope(sql, PEOPLE, filters.includeArchived)}
		  ${kinds ? sql`and kind in ${sql([...kinds])}` : sql``}
		  ${filters.group ? sql`and ${filters.group} = any(groups)` : sql``}
		  ${filters.search ? sql`and name ilike ${'%' + filters.search.trim() + '%'}` : sql``}
		order by name asc
		limit ${limit} offset ${offset}
	`;
	return rows.map(mapPerson);
}

export interface PersonInput extends OwnershipInput {
	name?: unknown;
	kind?: unknown;
	groups?: unknown;
	birthday?: unknown;
	notes?: unknown;
}

export function createPerson(
	sql: Queryable,
	viewer: Viewer,
	input: PersonInput
): Promise<WriteResult<Person>> {
	return guarded<Person>(async () => {
		const name = requiredText(input.name, 'name', 200);
		const { ownerUserId, visibility } = resolveOwnership(viewer, input, {
			ownerUserId: null,
			visibility: 'household'
		});
		const groups = Array.isArray(input.groups)
			? input.groups.map(String)
			: typeof input.groups === 'string' && input.groups.trim()
				? input.groups
						.split(',')
						.map((g) => g.trim())
						.filter(Boolean)
				: [];

		// See migration 0016: the database no longer forbids a repeated name,
		// because a unique index there aborts a whole import over one label the
		// source happens to use twice. Someone typing a duplicate is still told.
		const rows = await sql<PersonRow[]>`
			insert into ${sql(PEOPLE)} (
				household_id, owner_user_id, visibility, name, kind, groups, birthday,
				notes, created_by, updated_by
			)
			select ${viewer.householdId}::uuid, ${ownerUserId}::uuid, ${visibility}, ${name},
				${oneOf(input.kind, PERSON_KINDS, 'kind', 'person')},
				${groups}::text[],
				${(input.birthday as string) || null}::date,
				${optionalText(input.notes, 'notes')},
				${viewer.userId}::uuid, ${viewer.userId}::uuid
			where not exists (
				select 1 from ${sql(PEOPLE)} existing
				where existing.household_id = ${viewer.householdId}::uuid
				  and lower(trim(existing.name)) = lower(trim(${name}))
				  and existing.archived_at is null
			)
			returning ${peopleColumns(sql)}
		`;
		const row = rows[0];
		if (!row)
			return { ok: false, reason: 'invalid', message: 'someone by that name already exists' };
		return { ok: true, record: mapPerson(row) };
	});
}

/** The groups in use, for the page's filter chips. */
export async function personGroups(sql: Queryable, viewer: Viewer): Promise<string[]> {
	const rows = await sql<{ group: string }[]>`
		select distinct unnest(groups) as "group" from ${sql(PEOPLE)}
		where ${readableScope(sql, viewer, PEOPLE)} and archived_at is null
		order by "group" asc
	`;
	return rows.map((r) => toText(r.group));
}

// ─── the wishlist ──────────────────────────────────────────────────────────

export const WISHLIST_STATUSES = ['wanted', 'bought', 'given', 'declined'] as const;
export type WishlistStatus = (typeof WISHLIST_STATUSES)[number];

export interface WishlistItem extends RecordBase {
	name: string;
	itemType: string | null;
	status: WishlistStatus;
	priceRange: string | null;
	purpose: string | null;
	shopSource: string | null;
	url: string | null;
	occasion: string | null;
	forPersonId: string | null;
	forPersonName: string | null;
	isFavourite: boolean;
}

interface WishlistRow extends BaseRow {
	name: string;
	item_type: string | null;
	status: string;
	price_range: string | null;
	purpose: string | null;
	shop_source: string | null;
	url: string | null;
	occasion: string | null;
	for_person_id: string | null;
	for_person_name: string | null;
	is_favourite: unknown;
}

const WISHLIST = 'wishlist_items';

const mapWishlist = (row: WishlistRow): WishlistItem => ({
	...mapBase(row),
	name: toText(row.name),
	itemType: toTextOrNull(row.item_type),
	status: row.status as WishlistStatus,
	priceRange: toTextOrNull(row.price_range),
	purpose: toTextOrNull(row.purpose),
	shopSource: toTextOrNull(row.shop_source),
	url: toTextOrNull(row.url),
	occasion: toTextOrNull(row.occasion),
	forPersonId: row.for_person_id,
	forPersonName: toTextOrNull(row.for_person_name),
	isFavourite: toBool(row.is_favourite)
});

export interface WishlistFilters extends PageOptions {
	status?: WishlistStatus | readonly WishlistStatus[];
	forPersonId?: string;
	occasion?: string;
	includeArchived?: boolean;
}

export async function listWishlist(
	sql: Queryable,
	viewer: Viewer,
	filters: WishlistFilters = {}
): Promise<WishlistItem[]> {
	const { limit, offset } = pageOf(filters);
	const statuses = filters.status
		? Array.isArray(filters.status)
			? filters.status
			: [filters.status]
		: null;

	// `w` is aliased and every base column qualified: joining `people` for the
	// recipient's name would otherwise make `id` ambiguous.
	const rows = await sql<WishlistRow[]>`
		select w.id, w.household_id, w.owner_user_id, w.visibility, w.notion_page_id,
		       w.source_record_id, w.created_at, w.updated_at, w.created_by, w.updated_by,
		       w.archived_at,
		       w.name, w.item_type, w.status, w.price_range, w.purpose, w.shop_source,
		       w.url, w.occasion, w.for_person_id, w.is_favourite,
		       p.name as for_person_name
		from ${sql(WISHLIST)} w
		left join ${sql(PEOPLE)} p on p.id = w.for_person_id
		where ${readableScope(sql, viewer, 'w')}
		  and ${liveScope(sql, 'w', filters.includeArchived)}
		  ${statuses ? sql`and w.status in ${sql([...statuses])}` : sql``}
		  ${filters.forPersonId && isUuid(filters.forPersonId) ? sql`and w.for_person_id = ${filters.forPersonId}::uuid` : sql``}
		  ${filters.occasion ? sql`and w.occasion = ${filters.occasion}` : sql``}
		order by w.name asc
		limit ${limit} offset ${offset}
	`;
	return rows.map(mapWishlist);
}

export async function getWishlistItem(
	sql: Queryable,
	viewer: Viewer,
	id: string
): Promise<WishlistItem | null> {
	if (!isUuid(id)) return null;
	const rows = await sql<WishlistRow[]>`
		select w.id, w.household_id, w.owner_user_id, w.visibility, w.notion_page_id,
		       w.source_record_id, w.created_at, w.updated_at, w.created_by, w.updated_by,
		       w.archived_at,
		       w.name, w.item_type, w.status, w.price_range, w.purpose, w.shop_source,
		       w.url, w.occasion, w.for_person_id, w.is_favourite,
		       p.name as for_person_name
		from ${sql(WISHLIST)} w
		left join ${sql(PEOPLE)} p on p.id = w.for_person_id
		where w.id = ${id}::uuid and ${readableScope(sql, viewer, 'w')}
		limit 1
	`;
	return rows[0] ? mapWishlist(rows[0]) : null;
}

export interface WishlistInput extends OwnershipInput {
	name?: unknown;
	itemType?: unknown;
	status?: unknown;
	priceRange?: unknown;
	url?: unknown;
	occasion?: unknown;
	forPersonId?: unknown;
	isFavourite?: unknown;
}

export function createWishlistItem(
	sql: Queryable,
	viewer: Viewer,
	input: WishlistInput
): Promise<WriteResult<WishlistItem>> {
	return guarded<WishlistItem>(async () => {
		const name = requiredText(input.name, 'name', 300);
		const { ownerUserId, visibility } = resolveOwnership(viewer, input, {
			ownerUserId: null,
			visibility: 'household'
		});
		const forPersonId =
			typeof input.forPersonId === 'string' && isUuid(input.forPersonId) ? input.forPersonId : null;

		// The recipient is resolved against the household in SQL, so an id from
		// somewhere else lands as null rather than as a foreign row.
		const rows = await sql<{ id: string }[]>`
			insert into ${sql(WISHLIST)} (
				household_id, owner_user_id, visibility, name, item_type, status,
				price_range, url, occasion, for_person_id, is_favourite,
				created_by, updated_by
			) values (
				${viewer.householdId}::uuid, ${ownerUserId}::uuid, ${visibility}, ${name},
				${optionalText(input.itemType, 'type')},
				${oneOf(input.status, WISHLIST_STATUSES, 'status', 'wanted')},
				${optionalText(input.priceRange, 'price range')},
				${optionalText(input.url, 'url')},
				${optionalText(input.occasion, 'occasion')},
				(select p.id from ${sql(PEOPLE)} p
				 where p.id = ${forPersonId}::uuid and ${readableScope(sql, viewer, 'p')}),
				${input.isFavourite === true || input.isFavourite === 'on'}::boolean,
				${viewer.userId}::uuid, ${viewer.userId}::uuid
			)
			returning id
		`;
		const id = rows[0]?.id;
		if (!id) throw new Error('insert returned no row');

		// Re-read through the same join the list uses, so the returned record
		// carries the recipient's name rather than only their id.
		const found = await getWishlistItem(sql, viewer, id);
		if (!found) throw new Error('insert returned no readable row');
		return { ok: true, record: found };
	});
}

// ─── the watchlist ─────────────────────────────────────────────────────────

export const MEDIA_TYPES = ['movie', 'tv', 'other'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

export const MEDIA_STATUSES = [
	'want_to_watch',
	'watching',
	'watched',
	'paused',
	'dropped'
] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

export interface MediaItem extends RecordBase {
	name: string;
	mediaType: MediaType;
	status: MediaStatus;
	rating: number | null;
	genre: string | null;
	streamingService: string | null;
	releaseYear: number | null;
	totalSeasons: number | null;
	currentSeason: number | null;
	currentEpisode: number | null;
	timesWatched: number;
	whySaved: string | null;
	isFavourite: boolean;
	lastWatchedAt: Date | null;
}

interface MediaRow extends BaseRow {
	name: string;
	media_type: string;
	status: string;
	rating: unknown;
	genre: string | null;
	streaming_service: string | null;
	release_year: unknown;
	total_seasons: unknown;
	current_season: unknown;
	current_episode: unknown;
	times_watched: unknown;
	why_saved: string | null;
	is_favourite: unknown;
	last_watched_at: unknown;
}

const MEDIA = 'media_items';

const mediaColumns = (sql: Queryable): Fragment => sql`
	${baseColumns(sql)},
	name, media_type, status, rating, genre, streaming_service, release_year,
	total_seasons, current_season, current_episode, times_watched, why_saved,
	is_favourite, last_watched_at`;

const mapMedia = (row: MediaRow): MediaItem => ({
	...mapBase(row),
	name: toText(row.name),
	mediaType: row.media_type as MediaType,
	status: row.status as MediaStatus,
	rating: toIntOrNull(row.rating),
	genre: toTextOrNull(row.genre),
	streamingService: toTextOrNull(row.streaming_service),
	releaseYear: toIntOrNull(row.release_year),
	totalSeasons: toIntOrNull(row.total_seasons),
	currentSeason: toIntOrNull(row.current_season),
	currentEpisode: toIntOrNull(row.current_episode),
	timesWatched: toInt(row.times_watched),
	whySaved: toTextOrNull(row.why_saved),
	isFavourite: toBool(row.is_favourite),
	lastWatchedAt: toDateOrNull(row.last_watched_at)
});

export interface MediaFilters extends PageOptions {
	status?: MediaStatus | readonly MediaStatus[];
	mediaType?: MediaType;
	includeArchived?: boolean;
}

export async function listMedia(
	sql: Queryable,
	viewer: Viewer,
	filters: MediaFilters = {}
): Promise<MediaItem[]> {
	const { limit, offset } = pageOf(filters);
	const statuses = filters.status
		? Array.isArray(filters.status)
			? filters.status
			: [filters.status]
		: null;

	const rows = await sql<MediaRow[]>`
		select ${mediaColumns(sql)} from ${sql(MEDIA)}
		where ${readableScope(sql, viewer, MEDIA)}
		  and ${liveScope(sql, MEDIA, filters.includeArchived)}
		  ${statuses ? sql`and status in ${sql([...statuses])}` : sql``}
		  ${filters.mediaType ? sql`and media_type = ${filters.mediaType}` : sql``}
		order by last_watched_at desc nulls last, name asc
		limit ${limit} offset ${offset}
	`;
	return rows.map(mapMedia);
}

export function setMediaStatus(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	status: MediaStatus
): Promise<WriteResult<MediaItem>> {
	return guarded<MediaItem>(async () => {
		const next = oneOf(status, MEDIA_STATUSES, 'status', 'want_to_watch');
		return writeScoped<MediaRow, MediaItem>({
			sql,
			table: MEDIA,
			id,
			readScope: readableScope(sql, viewer, MEDIA),
			writeScope: writableScope(sql, viewer, MEDIA),
			assignments: sql`
				status = ${next},
				-- Marking something watched is itself a watch: the count and the
				-- date are what the "watch again?" question is answered from.
				times_watched = case when ${next} = 'watched'
					then times_watched + 1 else times_watched end,
				last_watched_at = case when ${next} in ('watched', 'watching')
					then now() else last_watched_at end,
				finished_on = case when ${next} = 'watched'
					then current_date else finished_on end,
				updated_at = now(), updated_by = ${viewer.userId}::uuid`,
			columns: mediaColumns(sql),
			map: mapMedia,
			mayWrite: writableBy(viewer)
		});
	});
}

// ─── bills ─────────────────────────────────────────────────────────────────

export const BILL_FREQUENCIES = [
	'weekly',
	'biweekly',
	'monthly',
	'quarterly',
	'annual',
	'one_off'
] as const;
export type BillFrequency = (typeof BILL_FREQUENCIES)[number];

export const BILL_STATUSES = ['active', 'free_trial', 'paused', 'cancelled'] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

export interface Bill extends RecordBase {
	name: string;
	amount: number | null;
	currency: string;
	frequency: BillFrequency | null;
	nextDueOn: string | null;
	category: string | null;
	account: string | null;
	autopay: boolean;
	status: BillStatus;
	freeTrialEndsOn: string | null;
	/** The amount normalised to a month, so a year's worth can be compared. */
	monthlyEquivalent: number | null;
}

interface BillRow extends BaseRow {
	name: string;
	amount: unknown;
	currency: string;
	frequency: string | null;
	next_due_on: string | null;
	category: string | null;
	account: string | null;
	autopay: unknown;
	status: string;
	free_trial_ends_on: string | null;
}

const BILLS = 'bills';

const billColumns = (sql: Queryable): Fragment => sql`
	${baseColumns(sql)},
	name, amount, currency, frequency, next_due_on::text as next_due_on,
	category, account, autopay, status,
	free_trial_ends_on::text as free_trial_ends_on`;

/** How many of each period fit in a month, for the normalised figure. */
const PER_MONTH: Record<BillFrequency, number> = {
	weekly: 52 / 12,
	biweekly: 26 / 12,
	monthly: 1,
	quarterly: 1 / 3,
	annual: 1 / 12,
	// A one-off has no recurring cost, so it contributes nothing to a monthly
	// total rather than contributing its whole amount every month.
	one_off: 0
};

function mapBill(row: BillRow): Bill {
	const amount = toNumberOrNull(row.amount);
	const frequency = (row.frequency as BillFrequency | null) ?? null;
	return {
		...mapBase(row),
		name: toText(row.name),
		amount,
		currency: toText(row.currency),
		frequency,
		nextDueOn: toDayOrNull(row.next_due_on),
		category: toTextOrNull(row.category),
		account: toTextOrNull(row.account),
		autopay: toBool(row.autopay),
		status: row.status as BillStatus,
		freeTrialEndsOn: toDayOrNull(row.free_trial_ends_on),
		monthlyEquivalent:
			amount !== null && frequency !== null
				? Math.round(amount * PER_MONTH[frequency] * 100) / 100
				: null
	};
}

export async function listBills(
	sql: Queryable,
	viewer: Viewer,
	filters: {
		status?: BillStatus | readonly BillStatus[];
		includeArchived?: boolean;
	} & PageOptions = {}
): Promise<Bill[]> {
	const { limit, offset } = pageOf(filters);
	const statuses = filters.status
		? Array.isArray(filters.status)
			? filters.status
			: [filters.status]
		: null;

	const rows = await sql<BillRow[]>`
		select ${billColumns(sql)} from ${sql(BILLS)}
		where ${readableScope(sql, viewer, BILLS)}
		  and ${liveScope(sql, BILLS, filters.includeArchived)}
		  ${statuses ? sql`and status in ${sql([...statuses])}` : sql``}
		order by next_due_on asc nulls last, name asc
		limit ${limit} offset ${offset}
	`;
	return rows.map(mapBill);
}

export interface BillInput extends OwnershipInput {
	name?: unknown;
	amount?: unknown;
	currency?: unknown;
	frequency?: unknown;
	nextDueOn?: unknown;
	category?: unknown;
	autopay?: unknown;
	status?: unknown;
}

export function createBill(
	sql: Queryable,
	viewer: Viewer,
	input: BillInput
): Promise<WriteResult<Bill>> {
	return guarded<Bill>(async () => {
		const name = requiredText(input.name, 'name', 200);
		const { ownerUserId, visibility } = resolveOwnership(viewer, input, {
			ownerUserId: null,
			visibility: 'household'
		});

		const rows = await sql<BillRow[]>`
			insert into ${sql(BILLS)} (
				household_id, owner_user_id, visibility, name, amount, currency,
				frequency, next_due_on, category, autopay, status, created_by, updated_by
			) values (
				${viewer.householdId}::uuid, ${ownerUserId}::uuid, ${visibility}, ${name},
				${toNumberOrNull(input.amount ?? null)}::numeric,
				${String(input.currency ?? 'CAD')
					.toUpperCase()
					.slice(0, 3)},
				${input.frequency ? oneOf(input.frequency, BILL_FREQUENCIES, 'frequency', 'monthly') : null},
				${(input.nextDueOn as string) || null}::date,
				${optionalText(input.category, 'category')},
				${input.autopay === true || input.autopay === 'on'}::boolean,
				${oneOf(input.status, BILL_STATUSES, 'status', 'active')},
				${viewer.userId}::uuid, ${viewer.userId}::uuid
			)
			returning ${billColumns(sql)}
		`;
		const row = rows[0];
		if (!row) throw new Error('insert returned no row');
		return { ok: true, record: mapBill(row) };
	});
}

/**
 * What the recurring commitments come to in a month.
 *
 * Only active and trialling bills count: a cancelled subscription is history,
 * and a one-off has no monthly cost at all.
 */
export async function monthlyCommitment(
	sql: Queryable,
	viewer: Viewer
): Promise<{ total: number; currency: string; count: number }> {
	const bills = await listBills(sql, viewer, { status: ['active', 'free_trial'], limit: 500 });
	const total = bills.reduce((sum, bill) => sum + (bill.monthlyEquivalent ?? 0), 0);
	return {
		total: Math.round(total * 100) / 100,
		currency: bills[0]?.currency ?? 'CAD',
		count: bills.length
	};
}
