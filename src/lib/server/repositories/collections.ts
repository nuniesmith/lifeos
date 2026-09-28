import type { Fragment } from 'postgres';
import type { Viewer } from '../auth/authz';
import {
	InvalidInput,
	MAX_LIMIT,
	archiveScoped,
	baseColumns,
	getScoped,
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
import { toDate, toDateOrNull } from '../db/coerce';
import {
	optionalDay,
	optionalInt,
	optionalText,
	patched,
	requiredDay,
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
	/** Whether this is worth watching again -- plan §13's "watch again", set
	 *  from the full edit and read by nothing else yet. */
	watchAgain: boolean;
	startedOn: string | null;
	finishedOn: string | null;
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
	watch_again: unknown;
	started_on: string | null;
	finished_on: string | null;
	last_watched_at: unknown;
}

const MEDIA = 'media_items';

const mediaColumns = (sql: Queryable): Fragment => sql`
	${baseColumns(sql)},
	name, media_type, status, rating, genre, streaming_service, release_year,
	total_seasons, current_season, current_episode, times_watched, why_saved,
	is_favourite, watch_again, started_on::text as started_on,
	finished_on::text as finished_on, last_watched_at`;

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
	watchAgain: toBool(row.watch_again),
	startedOn: toDayOrNull(row.started_on),
	finishedOn: toDayOrNull(row.finished_on),
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

export async function getMediaItem(
	sql: Queryable,
	viewer: Viewer,
	id: string
): Promise<MediaItem | null> {
	const row = await getScoped<MediaRow>(
		sql,
		MEDIA,
		id,
		readableScope(sql, viewer, MEDIA),
		mediaColumns(sql)
	);
	return row ? mapMedia(row) : null;
}

/** Streaming services already in use, for the picker's filter and as
 *  suggestions on the add/edit forms. Free text (migration 0014), so this is
 *  a convenience list, not a constraint someone else's guess could violate. */
export async function mediaStreamingServices(sql: Queryable, viewer: Viewer): Promise<string[]> {
	const rows = await sql<{ streaming_service: string }[]>`
		select distinct streaming_service from ${sql(MEDIA)}
		where ${readableScope(sql, viewer, MEDIA)} and streaming_service is not null
		order by streaming_service asc
	`;
	return rows.map((r) => toText(r.streaming_service));
}

export interface MediaItemInput extends OwnershipInput {
	name?: unknown;
	mediaType?: unknown;
	status?: unknown;
	genre?: unknown;
	streamingService?: unknown;
	releaseYear?: unknown;
	totalSeasons?: unknown;
}

/**
 * Adds a title to the watchlist. Only a name is required (plan §13, feature
 * 1) -- a title is often saved on a recommendation, with everything else
 * filled in once it is actually being watched, through {@link updateMediaItem}.
 */
export function createMediaItem(
	sql: Queryable,
	viewer: Viewer,
	input: MediaItemInput
): Promise<WriteResult<MediaItem>> {
	return guarded<MediaItem>(async () => {
		const name = requiredText(input.name, 'name', 300);
		// Household-shared by default, like the wishlist and bills this table
		// was migrated alongside (migration 0014): a watchlist is something
		// both members add to and pick from, not a private list by default.
		const { ownerUserId, visibility } = resolveOwnership(viewer, input, {
			ownerUserId: null,
			visibility: 'household'
		});

		const rows = await sql<MediaRow[]>`
			insert into ${sql(MEDIA)} (
				household_id, owner_user_id, visibility, name, media_type, status,
				genre, streaming_service, release_year, total_seasons,
				created_by, updated_by
			) values (
				${viewer.householdId}::uuid, ${ownerUserId}::uuid, ${visibility}, ${name},
				${oneOf(input.mediaType, MEDIA_TYPES, 'type', 'other')},
				${oneOf(input.status, MEDIA_STATUSES, 'status', 'want_to_watch')},
				${optionalText(input.genre, 'genre')},
				${optionalText(input.streamingService, 'streaming service')},
				${optionalInt(input.releaseYear, 'release year', { min: 1850, max: 2200 })},
				${optionalInt(input.totalSeasons, 'total seasons', { min: 0 })},
				${viewer.userId}::uuid, ${viewer.userId}::uuid
			)
			returning ${mediaColumns(sql)}
		`;
		const row = rows[0];
		if (!row) throw new Error('insert returned no row');
		return { ok: true, record: mapMedia(row) };
	});
}

export interface MediaItemPatch extends OwnershipInput {
	name?: unknown;
	mediaType?: unknown;
	status?: unknown;
	genre?: unknown;
	streamingService?: unknown;
	releaseYear?: unknown;
	totalSeasons?: unknown;
	currentSeason?: unknown;
	currentEpisode?: unknown;
	rating?: unknown;
	whySaved?: unknown;
	isFavourite?: unknown;
	watchAgain?: unknown;
	startedOn?: unknown;
	finishedOn?: unknown;
}

/**
 * The full edit of a title (plan §13, feature 2): every field except
 * `timesWatched` and `lastWatchedAt`, which are not here on purpose. Both are
 * history -- the importer's own counts, plus whatever {@link logMediaViewing}
 * has added since -- and a plain field edit must not be able to overwrite
 * that history by way of a stray form value. `setMediaStatus` keeps its own
 * increment-on-watched side effect for the quick queue actions; a status
 * changed through this full edit is a plain field like any other here, with
 * no side effect of its own.
 */
export function updateMediaItem(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	patch: MediaItemPatch,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<MediaItem>> {
	return guarded<MediaItem>(async () => {
		const current = await getMediaItem(sql, viewer, id);
		if (!current) return { ok: false, reason: 'not_found' };

		const next = {
			name: patched(patch, 'name', current.name, (v) => requiredText(v, 'name', 300)),
			mediaType: patched(patch, 'mediaType', current.mediaType, (v) =>
				oneOf(v, MEDIA_TYPES, 'type', current.mediaType)
			),
			status: patched(patch, 'status', current.status, (v) =>
				oneOf(v, MEDIA_STATUSES, 'status', current.status)
			),
			genre: patched(patch, 'genre', current.genre, (v) => optionalText(v, 'genre')),
			streamingService: patched(patch, 'streamingService', current.streamingService, (v) =>
				optionalText(v, 'streaming service')
			),
			releaseYear: patched(patch, 'releaseYear', current.releaseYear, (v) =>
				optionalInt(v, 'release year', { min: 1850, max: 2200 })
			),
			totalSeasons: patched(patch, 'totalSeasons', current.totalSeasons, (v) =>
				optionalInt(v, 'total seasons', { min: 0 })
			),
			currentSeason: patched(patch, 'currentSeason', current.currentSeason, (v) =>
				optionalInt(v, 'current season', { min: 0 })
			),
			currentEpisode: patched(patch, 'currentEpisode', current.currentEpisode, (v) =>
				optionalInt(v, 'current episode', { min: 0 })
			),
			rating: patched(patch, 'rating', current.rating, (v) =>
				optionalInt(v, 'rating', { min: 1, max: 5 })
			),
			whySaved: patched(patch, 'whySaved', current.whySaved, (v) => optionalText(v, 'why saved')),
			isFavourite: patched(patch, 'isFavourite', current.isFavourite, (v) => v === true),
			watchAgain: patched(patch, 'watchAgain', current.watchAgain, (v) => v === true),
			startedOn: patched(patch, 'startedOn', current.startedOn, (v) =>
				optionalDay(v, 'started on')
			),
			finishedOn: patched(patch, 'finishedOn', current.finishedOn, (v) =>
				optionalDay(v, 'finished on')
			)
		};

		const ownership = resolveOwnership(viewer, patch, {
			ownerUserId: current.ownerUserId,
			visibility: current.visibility
		});

		return writeScoped<MediaRow, MediaItem>({
			sql,
			table: MEDIA,
			id,
			readScope: readableScope(sql, viewer, MEDIA),
			writeScope: writableScope(sql, viewer, MEDIA),
			expectedUpdatedAt,
			assignments: sql`
				name = ${next.name}, media_type = ${next.mediaType}, status = ${next.status},
				genre = ${next.genre}, streaming_service = ${next.streamingService},
				release_year = ${next.releaseYear}, total_seasons = ${next.totalSeasons},
				current_season = ${next.currentSeason}, current_episode = ${next.currentEpisode},
				rating = ${next.rating}, why_saved = ${next.whySaved},
				is_favourite = ${next.isFavourite}, watch_again = ${next.watchAgain},
				started_on = ${next.startedOn}::date, finished_on = ${next.finishedOn}::date,
				owner_user_id = ${ownership.ownerUserId}::uuid, visibility = ${ownership.visibility},
				updated_at = now(), updated_by = ${viewer.userId}::uuid`,
			columns: mediaColumns(sql),
			map: mapMedia,
			mayWrite: writableBy(viewer)
		});
	});
}

/** Archives or restores a title. It leaves /entertainment and search's live
 *  results and waits in the Archive; its viewing history is untouched. */
export const setMediaItemArchived = (
	sql: Queryable,
	viewer: Viewer,
	id: string,
	archived: boolean,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<MediaItem>> =>
	archiveScoped<MediaRow, MediaItem>({
		sql,
		table: MEDIA,
		viewer,
		id,
		archived,
		expectedUpdatedAt,
		columns: mediaColumns(sql),
		map: mapMedia
	});

/**
 * Runs `fn` as one transaction, or as a savepoint when `sql` is already a
 * transaction, so "log a viewing" (an insert plus an update to the same
 * item, which must not take effect only halfway) is atomic on its own and
 * still composes inside a caller's transaction (base.ts, rule 3).
 */
function atomically<T>(sql: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> {
	return ('savepoint' in sql ? sql.savepoint(fn) : sql.begin(fn)) as Promise<T>;
}

// ─── per-viewing history ────────────────────────────────────────────────────

export interface MediaViewing {
	id: string;
	mediaItemId: string;
	watchedOn: string;
	season: number | null;
	episode: number | null;
	note: string | null;
	loggedBy: string | null;
	createdAt: Date;
}

interface MediaViewingRow {
	id: string;
	media_item_id: string;
	watched_on: string;
	season: unknown;
	episode: unknown;
	note: string | null;
	logged_by: string | null;
	created_at: unknown;
}

const VIEWINGS = 'media_viewings';

const viewingColumns = (sql: Queryable): Fragment => sql`
	id, media_item_id, watched_on::text as watched_on, season, episode, note, logged_by, created_at`;

const mapViewing = (row: MediaViewingRow): MediaViewing => ({
	id: row.id,
	mediaItemId: row.media_item_id,
	watchedOn: row.watched_on,
	season: toIntOrNull(row.season),
	episode: toIntOrNull(row.episode),
	note: toTextOrNull(row.note),
	loggedBy: row.logged_by,
	createdAt: toDate(row.created_at)
});

/** Every logged viewing of one title, most recent first. Scoped through the
 *  title itself (migration 0025's own header): a viewing has no visibility
 *  of its own, so seeing its history requires being able to see the title. */
export async function listMediaViewings(
	sql: Queryable,
	viewer: Viewer,
	mediaItemId: string
): Promise<MediaViewing[]> {
	if (!isUuid(mediaItemId)) return [];
	const rows = await sql<MediaViewingRow[]>`
		select ${viewingColumns(sql)} from ${sql(VIEWINGS)}
		where media_item_id = ${mediaItemId}::uuid
		  and exists (
		      select 1 from ${sql(MEDIA)}
		      where id = ${mediaItemId}::uuid and ${readableScope(sql, viewer, MEDIA)}
		  )
		order by watched_on desc, created_at desc
	`;
	return rows.map(mapViewing);
}

export interface MediaViewingInput {
	watchedOn?: unknown;
	season?: unknown;
	episode?: unknown;
	note?: unknown;
}

/**
 * Logs one viewing of a title (plan §13, feature 3) and keeps the title's own
 * summary in step: `times_watched` gains one and `last_watched_at` moves
 * forward to cover it, never backward past a more recent viewing already on
 * record. Both statements run in one transaction so a failure between them
 * cannot leave a viewing logged with no count to show for it.
 *
 * `times_watched` is only ever added to, never recomputed from a count of
 * this table's rows: the importer's own figure has no viewing rows behind
 * it, and counting rows instead would silently erase that history the moment
 * anyone logged a single new viewing.
 */
export function logMediaViewing(
	sql: Queryable,
	viewer: Viewer,
	mediaItemId: string,
	input: MediaViewingInput
): Promise<WriteResult<MediaViewing>> {
	return guarded<MediaViewing>(async () => {
		if (!isUuid(mediaItemId)) return { ok: false, reason: 'not_found' };
		const watchedOn = requiredDay(input.watchedOn, 'date watched');
		const season = optionalInt(input.season, 'season', { min: 0 });
		const episode = optionalInt(input.episode, 'episode', { min: 0 });
		const note = optionalText(input.note, 'note');
		// Noon UTC on the day watched: a stable instant for a value that is
		// only ever compared to itself and to what is already stored, so the
		// exact hour does not matter -- only that it lands on the right day
		// and is never taken from now(), which would misdate a backfilled
		// viewing of something actually watched last week.
		const watchedInstant = `${watchedOn}T12:00:00.000Z`;

		return atomically(sql, async (tx) => {
			const item = await getMediaItem(tx, viewer, mediaItemId);
			if (!item) return { ok: false, reason: 'not_found' };
			if (!writableBy(viewer)(item)) return { ok: false, reason: 'forbidden' };

			const rows = await tx<MediaViewingRow[]>`
				insert into ${tx(VIEWINGS)} (
					household_id, media_item_id, watched_on, season, episode, note, logged_by
				)
				select m.household_id, m.id, ${watchedOn}::date, ${season}, ${episode}, ${note},
				       ${viewer.userId}::uuid
				from ${tx(MEDIA)} m
				where m.id = ${mediaItemId}::uuid and ${writableScope(tx, viewer, 'm')}
				returning ${viewingColumns(tx)}
			`;
			const viewing = rows[0];
			// The scope is re-checked here in the statement itself rather than
			// trusted from the read a moment ago -- the same reason writeScoped
			// (base.ts) puts its own predicate in the UPDATE rather than relying
			// on an earlier SELECT that a concurrent change could have outrun.
			if (!viewing) return { ok: false, reason: 'conflict' };

			await tx`
				update ${tx(MEDIA)} m
				set times_watched = m.times_watched + 1,
				    last_watched_at = greatest(
				        coalesce(m.last_watched_at, ${watchedInstant}::timestamptz),
				        ${watchedInstant}::timestamptz
				    ),
				    updated_at = now(), updated_by = ${viewer.userId}::uuid
				where m.id = ${mediaItemId}::uuid and ${writableScope(tx, viewer, 'm')}
			`;

			return { ok: true, record: mapViewing(viewing) };
		});
	});
}

// ─── what should we watch? ──────────────────────────────────────────────────

export interface MediaPickerFilters {
	mediaType?: MediaType;
	streamingService?: string;
}

/**
 * A random suggestion from what the household has not started yet (plan
 * §13, feature 4).
 *
 * "Not watched yet" is the real `want_to_watch` status (migration 0014), not
 * an invented reading of `timesWatched === 0`: something dropped partway
 * through, or already mid-rewatch, is not what "what should we watch"
 * is asking for.
 *
 * The pick happens in JS over every matching row rather than
 * `order by random() limit 1`, so a test can pin `random` and know exactly
 * which title comes back (plan's randomness rule) rather than asserting only
 * that *some* row was returned.
 */
export async function pickMediaToWatch(
	sql: Queryable,
	viewer: Viewer,
	filters: MediaPickerFilters = {},
	random: () => number = Math.random
): Promise<MediaItem | null> {
	const rows = await sql<MediaRow[]>`
		select ${mediaColumns(sql)} from ${sql(MEDIA)}
		where ${readableScope(sql, viewer, MEDIA)}
		  and ${liveScope(sql, MEDIA)}
		  and status = 'want_to_watch'
		  ${filters.mediaType ? sql`and media_type = ${filters.mediaType}` : sql``}
		  ${filters.streamingService ? sql`and streaming_service = ${filters.streamingService}` : sql``}
		order by name asc
		limit ${MAX_LIMIT}
	`;
	if (rows.length === 0) return null;
	const index = Math.min(rows.length - 1, Math.floor(random() * rows.length));
	return mapMedia(rows[index]!);
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
