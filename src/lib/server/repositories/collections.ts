import type { Fragment } from 'postgres';
import type { Viewer } from '../auth/authz';
import {
	InvalidInput,
	atomically,
	baseColumns,
	getScoped,
	guarded,
	householdToday,
	isUuid,
	liveScope,
	mapBase,
	pageOf,
	readableScope,
	resolveOwnership,
	toBool,
	toDay,
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
import { toDate, toDateOrNull } from '../db/coerce';
import { addDays, daysInMonth } from './dates';
import {
	optionalDay,
	optionalNumber,
	optionalText,
	patched,
	requiredText
} from './validate';

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
	email?: unknown;
	phone?: unknown;
	address?: unknown;
}

/** A comma-separated string from the quick-add form, or an array from anywhere else. */
function parseGroups(value: unknown): string[] {
	if (Array.isArray(value)) return value.map(String);
	if (typeof value === 'string' && value.trim()) {
		return value
			.split(',')
			.map((g) => g.trim())
			.filter(Boolean);
	}
	return [];
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
		const groups = parseGroups(input.groups);

		// See migration 0016: the database no longer forbids a repeated name,
		// because a unique index there aborts a whole import over one label the
		// source happens to use twice. Someone typing a duplicate is still told.
		const rows = await sql<PersonRow[]>`
			insert into ${sql(PEOPLE)} (
				household_id, owner_user_id, visibility, name, kind, groups, birthday,
				notes, email, phone, address, created_by, updated_by
			)
			select ${viewer.householdId}::uuid, ${ownerUserId}::uuid, ${visibility}, ${name},
				${oneOf(input.kind, PERSON_KINDS, 'kind', 'person')},
				${groups}::text[],
				${optionalDay(input.birthday, 'birthday')}::date,
				${optionalText(input.notes, 'notes')},
				${optionalText(input.email, 'email', 320)},
				${optionalText(input.phone, 'phone', 40)},
				${optionalText(input.address, 'address', 500)},
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

// ─── a person's own page ────────────────────────────────────────────────────
//
// Contact details are not on `Person` / `peopleColumns` above: that shape is
// what every list, card and search result is built from, and a column those
// queries never select cannot leak through them by accident. `PersonDetail`
// is the wider shape the person's own page reads, and `getPerson` is the only
// function in this module that returns it.

export interface PersonDetail extends Person {
	email: string | null;
	phone: string | null;
	address: string | null;
}

interface PersonDetailRow extends PersonRow {
	email: string | null;
	phone: string | null;
	address: string | null;
}

const personDetailColumns = (sql: Queryable): Fragment => sql`
	${peopleColumns(sql)}, email, phone, address`;

const mapPersonDetail = (row: PersonDetailRow): PersonDetail => ({
	...mapPerson(row),
	email: toTextOrNull(row.email),
	phone: toTextOrNull(row.phone),
	address: toTextOrNull(row.address)
});

export async function getPerson(
	sql: Queryable,
	viewer: Viewer,
	id: string
): Promise<PersonDetail | null> {
	const row = await getScoped<PersonDetailRow>(
		sql,
		PEOPLE,
		id,
		readableScope(sql, viewer, PEOPLE),
		personDetailColumns(sql)
	);
	return row ? mapPersonDetail(row) : null;
}

export function updatePerson(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	patch: PersonInput,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<PersonDetail>> {
	return guarded<PersonDetail>(async () => {
		const current = await getPerson(sql, viewer, id);
		if (!current) return { ok: false, reason: 'not_found' };

		const next = {
			name: patched(patch, 'name', current.name, (v) => requiredText(v, 'name', 200)),
			kind: patched(patch, 'kind', current.kind, (v) =>
				oneOf(v, PERSON_KINDS, 'kind', current.kind)
			),
			// `parseGroups` never throws, so an explicit `'groups' in patch` check
			// (rather than `patched`, which needs a validator that can) is what
			// keeps a patch with no `groups` key from wiping the existing list.
			groups: 'groups' in patch ? parseGroups(patch.groups) : current.groups,
			birthday: patched(patch, 'birthday', current.birthday, (v) => optionalDay(v, 'birthday')),
			notes: patched(patch, 'notes', current.notes, (v) => optionalText(v, 'notes')),
			email: patched(patch, 'email', current.email, (v) => optionalText(v, 'email', 320)),
			phone: patched(patch, 'phone', current.phone, (v) => optionalText(v, 'phone', 40)),
			address: patched(patch, 'address', current.address, (v) => optionalText(v, 'address', 500))
		};
		const ownership = resolveOwnership(viewer, patch, {
			ownerUserId: current.ownerUserId,
			visibility: current.visibility
		});

		return writeScoped<PersonDetailRow, PersonDetail>({
			sql,
			table: PEOPLE,
			id,
			readScope: readableScope(sql, viewer, PEOPLE),
			writeScope: writableScope(sql, viewer, PEOPLE),
			...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
			assignments: sql`
				name = ${next.name}, kind = ${next.kind}, groups = ${next.groups}::text[],
				birthday = ${next.birthday}::date, notes = ${next.notes},
				email = ${next.email}, phone = ${next.phone}, address = ${next.address},
				owner_user_id = ${ownership.ownerUserId}::uuid, visibility = ${ownership.visibility},
				updated_at = now(), updated_by = ${viewer.userId}::uuid`,
			columns: personDetailColumns(sql),
			map: mapPersonDetail,
			mayWrite: writableBy(viewer)
		});
	});
}

/**
 * "Delete": archived people leave /people and search but stay reachable from
 * their own page and the Archive, and are recoverable — see base.ts's header.
 *
 * Hand-rolled rather than built on base.ts's `archiveScoped` because that
 * helper leaves `updated_at` to a database trigger, and `people` (added in
 * migration 0014, alongside `wishlist_items`, `media_items` and `bills`) has
 * never had one — every write in this file sets it by hand instead, this one
 * included.
 */
export function setPersonArchived(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	archived: boolean,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<PersonDetail>> {
	return guarded<PersonDetail>(async () =>
		writeScoped<PersonDetailRow, PersonDetail>({
			sql,
			table: PEOPLE,
			id,
			readScope: readableScope(sql, viewer, PEOPLE),
			writeScope: writableScope(sql, viewer, PEOPLE),
			...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
			assignments: sql`
				archived_at = case when ${archived}::boolean then now() else null end,
				updated_at = now(), updated_by = ${viewer.userId}::uuid`,
			columns: personDetailColumns(sql),
			map: mapPersonDetail,
			mayWrite: writableBy(viewer)
		})
	);
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
	purpose?: unknown;
	shopSource?: unknown;
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
				price_range, purpose, shop_source, url, occasion, for_person_id, is_favourite,
				created_by, updated_by
			) values (
				${viewer.householdId}::uuid, ${ownerUserId}::uuid, ${visibility}, ${name},
				${optionalText(input.itemType, 'type')},
				${oneOf(input.status, WISHLIST_STATUSES, 'status', 'wanted')},
				${optionalText(input.priceRange, 'price range')},
				${optionalText(input.purpose, 'purpose')},
				${optionalText(input.shopSource, 'shop')},
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

// An UPDATE's own RETURNING cannot reach across the join that gives every
// other read here `forPersonName`, so a write reads back only this table's
// own columns and re-fetches through `getWishlistItem` for the name — the
// same two-step shape `createWishlistItem` above already uses.
const wishlistColumns = (sql: Queryable): Fragment => sql`
	${baseColumns(sql)},
	name, item_type, status, price_range, purpose, shop_source, url, occasion,
	for_person_id, is_favourite`;

export function updateWishlistItem(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	patch: WishlistInput,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<WishlistItem>> {
	return guarded<WishlistItem>(async () => {
		const current = await getWishlistItem(sql, viewer, id);
		if (!current) return { ok: false, reason: 'not_found' };

		const next = {
			name: patched(patch, 'name', current.name, (v) => requiredText(v, 'name', 300)),
			itemType: patched(patch, 'itemType', current.itemType, (v) => optionalText(v, 'type')),
			status: patched(patch, 'status', current.status, (v) =>
				oneOf(v, WISHLIST_STATUSES, 'status', current.status)
			),
			priceRange: patched(patch, 'priceRange', current.priceRange, (v) =>
				optionalText(v, 'price range')
			),
			purpose: patched(patch, 'purpose', current.purpose, (v) => optionalText(v, 'purpose')),
			shopSource: patched(patch, 'shopSource', current.shopSource, (v) => optionalText(v, 'shop')),
			url: patched(patch, 'url', current.url, (v) => optionalText(v, 'url')),
			occasion: patched(patch, 'occasion', current.occasion, (v) => optionalText(v, 'occasion')),
			isFavourite: patched(
				patch,
				'isFavourite',
				current.isFavourite,
				(v) => v === true || v === 'on' || v === 'true'
			)
		};

		// Re-checked readable on every save, the same way creating one does, so
		// an edit cannot attach an id the viewer cannot see (rule: a link is
		// checked in the same query that writes it). Leaving `forPersonId` out
		// of the patch entirely keeps the existing link — the CASE is what
		// tells "not mentioned" apart from "mentioned as empty", inside the one
		// statement that also does the write.
		const forPersonGiven = 'forPersonId' in patch;
		const rawForPersonId =
			typeof patch.forPersonId === 'string' && isUuid(patch.forPersonId) ? patch.forPersonId : null;

		const ownership = resolveOwnership(viewer, patch, {
			ownerUserId: current.ownerUserId,
			visibility: current.visibility
		});

		const result = await writeScoped<WishlistRow, WishlistItem>({
			sql,
			table: WISHLIST,
			id,
			readScope: readableScope(sql, viewer, WISHLIST),
			writeScope: writableScope(sql, viewer, WISHLIST),
			...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
			assignments: sql`
				name = ${next.name}, item_type = ${next.itemType}, status = ${next.status},
				price_range = ${next.priceRange}, purpose = ${next.purpose},
				shop_source = ${next.shopSource}, url = ${next.url}, occasion = ${next.occasion},
				is_favourite = ${next.isFavourite}::boolean,
				for_person_id = case when ${forPersonGiven}::boolean then
					(select p.id from ${sql(PEOPLE)} p
					 where p.id = ${rawForPersonId}::uuid and ${readableScope(sql, viewer, 'p')})
					else for_person_id end,
				owner_user_id = ${ownership.ownerUserId}::uuid, visibility = ${ownership.visibility},
				updated_at = now(), updated_by = ${viewer.userId}::uuid`,
			columns: wishlistColumns(sql),
			map: mapWishlist,
			mayWrite: writableBy(viewer)
		});
		if (!result.ok) return result;

		// The name-joined shape every other read of this table returns.
		const found = await getWishlistItem(sql, viewer, result.record.id);
		if (!found) throw new Error('update returned no readable row');
		return { ok: true, record: found };
	});
}

/**
 * Marks an item bought, given, declined, or back on the list: one fact
 * stated outright rather than a field flipped, the same reasoning as a
 * recipe's "made it today" (see `food/recipes/[id]/+page.server.ts`) —
 * repeating it is harmless, so it carries no version to conflict over.
 */
export function setWishlistItemStatus(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	status: unknown
): Promise<WriteResult<WishlistItem>> {
	return guarded<WishlistItem>(async () => {
		const next = oneOf(status, WISHLIST_STATUSES, 'status', 'wanted');
		const result = await writeScoped<WishlistRow, WishlistItem>({
			sql,
			table: WISHLIST,
			id,
			readScope: readableScope(sql, viewer, WISHLIST),
			writeScope: writableScope(sql, viewer, WISHLIST),
			assignments: sql`
				status = ${next}, updated_at = now(), updated_by = ${viewer.userId}::uuid`,
			columns: wishlistColumns(sql),
			map: mapWishlist,
			mayWrite: writableBy(viewer)
		});
		if (!result.ok) return result;
		const found = await getWishlistItem(sql, viewer, result.record.id);
		if (!found) throw new Error('update returned no readable row');
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

export const BILL_TYPES = ['bill', 'subscription'] as const;
export type BillType = (typeof BILL_TYPES)[number];

export interface Bill extends RecordBase {
	name: string;
	type: BillType;
	amount: number | null;
	currency: string;
	frequency: BillFrequency | null;
	nextDueOn: string | null;
	category: string | null;
	account: string | null;
	autopay: boolean;
	status: BillStatus;
	freeTrialEndsOn: string | null;
	/** What the trial converts to — a second price beside the trial's own
	 *  (often zero) `amount`, so "free now, $14.99 after" is two facts rather
	 *  than one the household has to remember on their own. */
	trialPrice: number | null;
	/** A management or cancel link. Rendered through `safeLinkUrl` — see
	 *  src/lib/server/markdown.ts — never trusted as-is. */
	url: string | null;
	notes: string | null;
	/** The amount normalised to a month, so a year's worth can be compared. */
	monthlyEquivalent: number | null;
}

interface BillRow extends BaseRow {
	name: string;
	type: string;
	amount: unknown;
	currency: string;
	frequency: string | null;
	next_due_on: string | null;
	category: string | null;
	account: string | null;
	autopay: unknown;
	status: string;
	free_trial_ends_on: string | null;
	trial_price: unknown;
	url: string | null;
	notes: string | null;
}

const BILLS = 'bills';

const billColumns = (sql: Queryable): Fragment => sql`
	${baseColumns(sql)},
	name, type, amount, currency, frequency, next_due_on::text as next_due_on,
	category, account, autopay, status,
	free_trial_ends_on::text as free_trial_ends_on, trial_price, url, notes`;

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
		type: row.type as BillType,
		amount,
		currency: toText(row.currency),
		frequency,
		nextDueOn: toDayOrNull(row.next_due_on),
		category: toTextOrNull(row.category),
		account: toTextOrNull(row.account),
		autopay: toBool(row.autopay),
		status: row.status as BillStatus,
		freeTrialEndsOn: toDayOrNull(row.free_trial_ends_on),
		trialPrice: toNumberOrNull(row.trial_price),
		url: toTextOrNull(row.url),
		notes: toTextOrNull(row.notes),
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
	type?: unknown;
	amount?: unknown;
	currency?: unknown;
	frequency?: unknown;
	nextDueOn?: unknown;
	category?: unknown;
	account?: unknown;
	autopay?: unknown;
	status?: unknown;
	freeTrialEndsOn?: unknown;
	trialPrice?: unknown;
	url?: unknown;
	notes?: unknown;
}

/** Zero or greater — the CHECK `amount` and `trial_price` share, distinct
 *  from a strictly-positive one like a payment's own amount. */
function nonNegativeAmount(value: unknown, field: string): number | null {
	const n = optionalNumber(value, field);
	if (n !== null && n < 0) throw new InvalidInput(`${field} must be zero or greater`);
	return n;
}

/** A checkbox as a form actually sends it: present and `'on'`, or absent. */
const checkboxBool = (value: unknown): boolean => value === true || value === 'on';

function currencyOf(value: unknown, fallback: string): string {
	if (value === undefined || value === null || value === '') return fallback;
	return String(value).toUpperCase().slice(0, 3);
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
				household_id, owner_user_id, visibility, name, type, amount, currency,
				frequency, next_due_on, category, account, autopay, status,
				free_trial_ends_on, trial_price, url, notes, created_by, updated_by
			) values (
				${viewer.householdId}::uuid, ${ownerUserId}::uuid, ${visibility}, ${name},
				${oneOf(input.type, BILL_TYPES, 'type', 'bill')},
				${nonNegativeAmount(input.amount, 'amount')}::numeric,
				${currencyOf(input.currency, 'CAD')},
				${input.frequency ? oneOf(input.frequency, BILL_FREQUENCIES, 'frequency', 'monthly') : null},
				${optionalDay(input.nextDueOn, 'next due date')}::date,
				${optionalText(input.category, 'category')},
				${optionalText(input.account, 'account')},
				${checkboxBool(input.autopay)}::boolean,
				${oneOf(input.status, BILL_STATUSES, 'status', 'active')},
				${optionalDay(input.freeTrialEndsOn, 'trial end date')}::date,
				${nonNegativeAmount(input.trialPrice, 'trial price')}::numeric,
				${optionalText(input.url, 'link', 2000)},
				${optionalText(input.notes, 'notes')},
				${viewer.userId}::uuid, ${viewer.userId}::uuid
			)
			returning ${billColumns(sql)}
		`;
		const row = rows[0];
		if (!row) throw new Error('insert returned no row');
		return { ok: true, record: mapBill(row) };
	});
}

export async function getBill(sql: Queryable, viewer: Viewer, id: string): Promise<Bill | null> {
	const row = await getScoped<BillRow>(
		sql,
		BILLS,
		id,
		readableScope(sql, viewer, BILLS),
		billColumns(sql)
	);
	return row ? mapBill(row) : null;
}

export function updateBill(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	patch: BillInput,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<Bill>> {
	return guarded<Bill>(async () => {
		const current = await getBill(sql, viewer, id);
		if (!current) return { ok: false, reason: 'not_found' };

		const next = {
			name: patched(patch, 'name', current.name, (v) => requiredText(v, 'name', 200)),
			type: patched(patch, 'type', current.type, (v) => oneOf(v, BILL_TYPES, 'type', current.type)),
			amount: patched(patch, 'amount', current.amount, (v) => nonNegativeAmount(v, 'amount')),
			currency: patched(patch, 'currency', current.currency, (v) =>
				currencyOf(v, current.currency)
			),
			frequency: patched(patch, 'frequency', current.frequency, (v) =>
				v ? oneOf(v, BILL_FREQUENCIES, 'frequency', current.frequency ?? 'monthly') : null
			),
			nextDueOn: patched(patch, 'nextDueOn', current.nextDueOn, (v) =>
				optionalDay(v, 'next due date')
			),
			category: patched(patch, 'category', current.category, (v) => optionalText(v, 'category')),
			account: patched(patch, 'account', current.account, (v) => optionalText(v, 'account')),
			autopay: patched(patch, 'autopay', current.autopay, checkboxBool),
			status: patched(patch, 'status', current.status, (v) =>
				oneOf(v, BILL_STATUSES, 'status', current.status)
			),
			freeTrialEndsOn: patched(patch, 'freeTrialEndsOn', current.freeTrialEndsOn, (v) =>
				optionalDay(v, 'trial end date')
			),
			trialPrice: patched(patch, 'trialPrice', current.trialPrice, (v) =>
				nonNegativeAmount(v, 'trial price')
			),
			url: patched(patch, 'url', current.url, (v) => optionalText(v, 'link', 2000)),
			notes: patched(patch, 'notes', current.notes, (v) => optionalText(v, 'notes'))
		};
		const ownership = resolveOwnership(viewer, patch, {
			ownerUserId: current.ownerUserId,
			visibility: current.visibility
		});

		return writeScoped<BillRow, Bill>({
			sql,
			table: BILLS,
			id,
			readScope: readableScope(sql, viewer, BILLS),
			writeScope: writableScope(sql, viewer, BILLS),
			...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
			assignments: sql`
				name = ${next.name}, type = ${next.type}, amount = ${next.amount}::numeric,
				currency = ${next.currency}, frequency = ${next.frequency},
				next_due_on = ${next.nextDueOn}::date, category = ${next.category},
				account = ${next.account}, autopay = ${next.autopay}::boolean, status = ${next.status},
				free_trial_ends_on = ${next.freeTrialEndsOn}::date,
				trial_price = ${next.trialPrice}::numeric, url = ${next.url}, notes = ${next.notes},
				owner_user_id = ${ownership.ownerUserId}::uuid, visibility = ${ownership.visibility},
				updated_at = now(), updated_by = ${viewer.userId}::uuid`,
			columns: billColumns(sql),
			map: mapBill,
			mayWrite: writableBy(viewer)
		});
	});
}

/** "Delete": archived bills leave /finance but stay recoverable from the
 *  Archive, like everything else in LifeOS (base.ts's header). Hand-rolled
 *  rather than built on base.ts's `archiveScoped`, the same reason
 *  `setPersonArchived` is: that helper leaves `updated_at` to a database
 *  trigger, and `bills` (added in migration 0014, alongside `people`) has
 *  never had one. */
export function setBillArchived(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	archived: boolean,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<Bill>> {
	return guarded<Bill>(async () =>
		writeScoped<BillRow, Bill>({
			sql,
			table: BILLS,
			id,
			readScope: readableScope(sql, viewer, BILLS),
			writeScope: writableScope(sql, viewer, BILLS),
			...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
			assignments: sql`
				archived_at = case when ${archived}::boolean then now() else null end,
				updated_at = now(), updated_by = ${viewer.userId}::uuid`,
			columns: billColumns(sql),
			map: mapBill,
			mayWrite: writableBy(viewer)
		})
	);
}

/**
 * Adds whole months to a day, clamping into a shorter month rather than
 * rolling into the next one — the same rule `nextOccurrence` in dates.ts uses
 * for a recurring important date, reimplemented here for a specific number of
 * months at a time rather than that function's year-or-month recurrence walk.
 */
function addMonthsClamped(day: string, months: number): string {
	const [year, month, date] = day.split('-').map(Number);
	const total = year! * 12 + (month! - 1) + months;
	const y = Math.floor(total / 12);
	const m = (total % 12) + 1;
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${y}-${pad(m)}-${pad(Math.min(date!, daysInMonth(y, m)))}`;
}

/**
 * The due date after one payment, for whichever frequency the table's own
 * CHECK allows.
 *
 * `one_off` has no next occurrence at all: paying it is the end of it, not a
 * schedule to keep advancing, so the date clears rather than repeating. A
 * bill with no frequency recorded (the column is nullable — imported data
 * that never said, or a genuinely irregular bill) is left exactly where it
 * was: there is no period to add a multiple of, and guessing one would
 * silently invent a schedule nobody set. Exported for its own unit tests, the
 * same reason `placeInZone` in health-measurements.ts is.
 */
export function advanceDueDate(
	current: string | null,
	frequency: BillFrequency | null
): string | null {
	if (current === null || frequency === null) return current;
	switch (frequency) {
		case 'weekly':
			return addDays(current, 7);
		case 'biweekly':
			return addDays(current, 14);
		case 'monthly':
			return addMonthsClamped(current, 1);
		case 'quarterly':
			return addMonthsClamped(current, 3);
		case 'annual':
			return addMonthsClamped(current, 12);
		case 'one_off':
			return null;
	}
}

// ─── bill payments ──────────────────────────────────────────────────────────

export interface BillPayment {
	id: string;
	billId: string;
	amountPaid: number;
	paidOn: string;
	note: string | null;
	previousNextDueOn: string | null;
	createdAt: Date;
	createdBy: string | null;
}

interface BillPaymentRow {
	id: string;
	bill_id: string;
	amount_paid: unknown;
	paid_on: string;
	note: string | null;
	previous_next_due_on: string | null;
	created_at: unknown;
	created_by: string | null;
}

const BILL_PAYMENTS = 'bill_payments';

function mapBillPayment(row: BillPaymentRow): BillPayment {
	return {
		id: row.id,
		billId: row.bill_id,
		amountPaid: toNumberOrNull(row.amount_paid) ?? 0,
		paidOn: toDay(row.paid_on),
		note: toTextOrNull(row.note),
		previousNextDueOn: toDayOrNull(row.previous_next_due_on),
		createdAt: toDate(row.created_at),
		createdBy: row.created_by
	};
}

/** Most recent first: the list this feeds only ever asks "what happened
 *  lately", and only the newest row may be undone (see `deleteBillPayment`). */
export async function listBillPayments(
	sql: Queryable,
	viewer: Viewer,
	billId: string
): Promise<BillPayment[]> {
	if (!isUuid(billId)) return [];
	const rows = await sql<BillPaymentRow[]>`
		select p.id, p.bill_id, p.amount_paid, p.paid_on::text as paid_on, p.note,
		       p.previous_next_due_on::text as previous_next_due_on, p.created_at, p.created_by
		from ${sql(BILL_PAYMENTS)} p
		join ${sql(BILLS)} b on b.id = p.bill_id
		where p.bill_id = ${billId}::uuid and ${readableScope(sql, viewer, 'b')}
		order by p.paid_on desc, p.created_at desc
	`;
	return rows.map(mapBillPayment);
}

export interface BillPaymentInput {
	amountPaid?: unknown;
	paidOn?: unknown;
	note?: unknown;
}

export interface BillPaymentResult {
	bill: Bill;
	payment: BillPayment;
}

/**
 * Records a payment against a bill and advances its due date by one period,
 * in one transaction (base.ts's `atomically`): a payment logged with no
 * matching change to `next_due_on`, or a due date moved with nothing in the
 * log to say why, would each be a silent half of "mark paid".
 */
export function recordBillPayment(
	sql: Queryable,
	viewer: Viewer,
	billId: string,
	input: BillPaymentInput
): Promise<WriteResult<BillPaymentResult>> {
	if (!isUuid(billId)) return Promise.resolve({ ok: false, reason: 'not_found' });

	return guarded(() =>
		atomically(sql, async (tx): Promise<WriteResult<BillPaymentResult>> => {
			// Locked, so two concurrent "mark paid" taps cannot both advance the
			// due date from the same starting point.
			const [row] = await tx<BillRow[]>`
				select ${billColumns(tx)} from ${tx(BILLS)}
				where id = ${billId}::uuid and ${writableScope(tx, viewer, BILLS)}
				for update
			`;
			if (!row) return { ok: false, reason: 'not_found' };
			const bill = mapBill(row);

			const paidOn =
				optionalDay(input.paidOn, 'date paid') ?? (await householdToday(tx, viewer.householdId));
			const amountPaid = optionalNumber(input.amountPaid, 'amount paid') ?? bill.amount;
			if (amountPaid === null || amountPaid <= 0) {
				throw new InvalidInput('enter an amount paid greater than 0');
			}
			const note = optionalText(input.note, 'note', 500);
			const nextDueOn = advanceDueDate(bill.nextDueOn, bill.frequency);

			const [payment] = await tx<BillPaymentRow[]>`
				insert into ${tx(BILL_PAYMENTS)} (
					bill_id, amount_paid, paid_on, note, previous_next_due_on, created_by
				) values (
					${billId}::uuid, ${amountPaid}::numeric, ${paidOn}::date, ${note},
					${bill.nextDueOn}::date, ${viewer.userId}::uuid
				)
				returning id, bill_id, amount_paid, paid_on::text as paid_on, note,
				          previous_next_due_on::text as previous_next_due_on, created_at, created_by
			`;
			if (!payment) throw new Error('insert returned no row');

			const [updatedRow] = await tx<BillRow[]>`
				update ${tx(BILLS)} set next_due_on = ${nextDueOn}::date,
					updated_at = now(), updated_by = ${viewer.userId}::uuid
				where id = ${billId}::uuid
				returning ${billColumns(tx)}
			`;
			if (!updatedRow) throw new Error('update returned no row');

			return { ok: true, record: { bill: mapBill(updatedRow), payment: mapBillPayment(payment) } };
		})
	);
}

/**
 * Undoes a payment: deletes the log row and puts the bill's due date back to
 * what it was immediately before that payment moved it.
 *
 * Only the most recent payment for the bill may be undone. An older row's own
 * "previous due date" is real, but restoring it would jump the bill's due
 * date backwards past every payment recorded since — silently undoing work
 * nobody asked to undo. The bill page only ever offers Undo on the newest row
 * for the same reason.
 */
export function deleteBillPayment(
	sql: Queryable,
	viewer: Viewer,
	billId: string,
	paymentId: string
): Promise<WriteResult<Bill>> {
	if (!isUuid(billId) || !isUuid(paymentId)) {
		return Promise.resolve({ ok: false, reason: 'not_found' });
	}

	return guarded(() =>
		atomically(sql, async (tx): Promise<WriteResult<Bill>> => {
			const [row] = await tx<BillRow[]>`
				select ${billColumns(tx)} from ${tx(BILLS)}
				where id = ${billId}::uuid and ${writableScope(tx, viewer, BILLS)}
				for update
			`;
			if (!row) return { ok: false, reason: 'not_found' };

			const [latest] = await tx<{ id: string; previous_next_due_on: string | null }[]>`
				select id, previous_next_due_on::text as previous_next_due_on
				from ${tx(BILL_PAYMENTS)}
				where bill_id = ${billId}::uuid
				order by paid_on desc, created_at desc
				limit 1
				for update
			`;
			if (!latest || latest.id !== paymentId) {
				return {
					ok: false,
					reason: 'invalid',
					message: 'only the most recent payment can be undone'
				};
			}

			await tx`delete from ${tx(BILL_PAYMENTS)} where id = ${paymentId}::uuid`;

			const [updated] = await tx<BillRow[]>`
				update ${tx(BILLS)} set next_due_on = ${latest.previous_next_due_on}::date,
					updated_at = now(), updated_by = ${viewer.userId}::uuid
				where id = ${billId}::uuid
				returning ${billColumns(tx)}
			`;
			if (!updated) throw new Error('update returned no row');
			return { ok: true, record: mapBill(updated) };
		})
	);
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
