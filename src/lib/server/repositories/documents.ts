import type { Fragment } from 'postgres';
import type { Viewer } from '../auth/authz';
import { toDate } from '../db/coerce';
import {
	InvalidInput,
	atomically,
	baseColumns,
	guarded,
	householdToday,
	isUuid,
	liveScope,
	mapBase,
	pageOf,
	readableScope,
	resolveOwnership,
	toDay,
	toDayOrNull,
	toIntOrNull,
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
	type WriteFailure,
	type WriteResult
} from './base';
import { addDays } from './dates';
import {
	optionalDay,
	optionalId,
	optionalInt,
	optionalText,
	patched,
	requiredDay,
	requiredText
} from './validate';

/**
 * Life Admin HQ: documents and renewals (migration 0036).
 *
 * The source's "Life Admin HQ" database exported empty, so there is no
 * importer and no rows to carry over -- the household defined the scope
 * themselves (documents and renewals: IDs, insurance, warranties, licences)
 * and this is built fresh from that description, the same position
 * `income_entries`/`savings_contributions` started from (migration 0029).
 *
 * `documents` defaults to `private`, like `daily_logs`, not `household` like
 * most of this schema's tables: a passport or a licence is one person's
 * thing first, shared with the household only when its owner chooses to
 * (the home insurance policy). `holderPersonId` is a separate fact from
 * ownership -- whose *document* it is (a person, or a pet's own
 * registration), checked readable the same way labs-visits.ts's
 * `resolveVisitLink` checks its own three links: a holder offered by the
 * form's own picker is never a guess, so one that does not resolve refuses
 * the whole write rather than being silently dropped.
 *
 * `reference` (the brief's own example: a licence or passport number) is
 * never selected by {@link listDocuments} or {@link documentsNeedingAttention}
 * -- not merely hidden by the page that renders them -- and is left out of
 * search's indexed text in ./search.ts. Only {@link getDocument}, which backs
 * the document's own page, reads it.
 */

export const DOCUMENT_KINDS = [
	'id',
	'insurance',
	'warranty',
	'licence',
	'registration',
	'membership',
	'certificate',
	'other'
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/**
 * Defaults to 'other' when absent, the same shape collections.ts's own local
 * `oneOf` gives `bills.type`/`wishlist_items.status`: always one of a known
 * set, but with a safe fallback for a caller -- a test fixture, most often --
 * that does not mention it. The quick-add and edit forms always send one of
 * these exact strings from a `<Select>`, so no case- or punctuation-folding
 * is needed the way collections.ts's import-era helper needs for messier
 * input.
 */
function documentKind(value: unknown): DocumentKind {
	if (value === null || value === undefined || value === '') return 'other';
	if ((DOCUMENT_KINDS as readonly string[]).includes(value as string)) {
		return value as DocumentKind;
	}
	throw new InvalidInput(`kind must be one of ${DOCUMENT_KINDS.join(', ')}`);
}

// ─── attention state ────────────────────────────────────────────────────────

export type AttentionState = 'expired' | 'due' | 'ok' | 'none';

/**
 * Where a document's expiry sits against today and its own renewal lead
 * time. Pure and unit-tested at its boundaries, the same way `rangeStatus` is
 * in labs-visits.ts, so a renewal's lead-time change cannot leave a cached
 * flag stale against it.
 *
 * `expired` and `due` are both inclusive at the boundary that matters to
 * them: a document expiring exactly today is `due`, not yet `expired` (that
 * starts the day after), and one expiring exactly `renewLeadDays` away is
 * already `due`, not `ok` -- the household asked to be warned FROM that day,
 * not only strictly after it.
 */
export function attentionState(
	expiresOn: string | null,
	today: string,
	renewLeadDays: number
): AttentionState {
	if (expiresOn === null) return 'none';
	if (expiresOn < today) return 'expired';
	if (expiresOn <= addDays(today, renewLeadDays)) return 'due';
	return 'ok';
}

// ─── documents ───────────────────────────────────────────────────────────────

export interface LifeDocument extends RecordBase {
	title: string;
	kind: DocumentKind;
	holderPersonId: string | null;
	/** Denormalised for display, null when the viewer cannot read the holder
	 *  (the same shape `SavingsContribution.goalTitle` uses for its own link,
	 *  in savings.ts) even though a holder that resolved at write time is
	 *  ordinarily readable -- a person's visibility can still be narrowed
	 *  afterwards. */
	holderName: string | null;
	issuer: string | null;
	/** Never present on a {@link DocumentSummary} -- see the module header. */
	reference: string | null;
	issuedOn: string | null;
	expiresOn: string | null;
	renewLeadDays: number;
	location: string | null;
	url: string | null;
	notes: string | null;
}

/** What every list and the Today card may show: everything but `reference`. */
export type DocumentSummary = Omit<LifeDocument, 'reference'>;

interface DocumentWriteRow extends BaseRow {
	title: string;
	kind: string;
	holder_person_id: string | null;
	issuer: string | null;
	reference: string | null;
	issued_on: string | null;
	expires_on: string | null;
	renew_lead_days: number;
	location: string | null;
	url: string | null;
	notes: string | null;
}

/** {@link DocumentWriteRow} plus the one joined column every read adds. */
interface DocumentJoinRow extends DocumentWriteRow {
	holder_name: string | null;
}

interface DocumentSummaryRow extends BaseRow {
	title: string;
	kind: string;
	holder_person_id: string | null;
	issuer: string | null;
	issued_on: string | null;
	expires_on: string | null;
	renew_lead_days: number;
	location: string | null;
	url: string | null;
	notes: string | null;
	holder_name: string | null;
}

const DOCUMENTS = 'documents';
const PEOPLE = 'people';

/** A document's own columns, unqualified -- correct only where the FROM is
 *  `documents` alone with no join, which is every write's RETURNING clause. */
const documentWriteColumns = (sql: Queryable): Fragment => sql`
	${baseColumns(sql)},
	title, kind, holder_person_id, issuer, reference,
	issued_on::text as issued_on, expires_on::text as expires_on,
	renew_lead_days, location, url, notes`;

/**
 * Maps a write's own RETURNING row, with `holderName` left null.
 *
 * An UPDATE's own RETURNING cannot reach across the join that gives every
 * other read here `holderName` -- the identical limitation
 * `savings_contributions`/`wishlist_items` hit for their own joined display
 * field -- so every write below re-fetches through {@link getDocument} once
 * it has committed, and this mapper's output is only ever the intermediate
 * value `writeScoped` needs on the way there.
 */
function mapDocumentWrite(row: DocumentWriteRow): LifeDocument {
	return {
		...mapBase(row),
		title: toText(row.title),
		kind: row.kind as DocumentKind,
		holderPersonId: row.holder_person_id,
		holderName: null,
		issuer: toTextOrNull(row.issuer),
		reference: toTextOrNull(row.reference),
		issuedOn: toDayOrNull(row.issued_on),
		expiresOn: toDayOrNull(row.expires_on),
		renewLeadDays: toIntOrNull(row.renew_lead_days) ?? 30,
		location: toTextOrNull(row.location),
		url: toTextOrNull(row.url),
		notes: toTextOrNull(row.notes)
	};
}

/** Explicit `d.`/`p.`-qualified columns: joining `people`, itself a
 *  RecordBase-shaped table, makes every unqualified base column ambiguous --
 *  the same reason `savingsColumns` in savings.ts hand-qualifies its own. */
const documentColumns = (sql: Queryable): Fragment => sql`
	d.id, d.household_id, d.owner_user_id, d.visibility, d.notion_page_id, d.source_record_id,
	d.created_at, d.updated_at, d.created_by, d.updated_by, d.archived_at,
	d.title, d.kind, d.holder_person_id, d.issuer, d.reference,
	d.issued_on::text as issued_on, d.expires_on::text as expires_on,
	d.renew_lead_days, d.location, d.url, d.notes,
	p.name as holder_name`;

const documentSummaryColumns = (sql: Queryable): Fragment => sql`
	d.id, d.household_id, d.owner_user_id, d.visibility, d.notion_page_id, d.source_record_id,
	d.created_at, d.updated_at, d.created_by, d.updated_by, d.archived_at,
	d.title, d.kind, d.holder_person_id, d.issuer,
	d.issued_on::text as issued_on, d.expires_on::text as expires_on,
	d.renew_lead_days, d.location, d.url, d.notes,
	p.name as holder_name`;

function mapDocument(row: DocumentJoinRow): LifeDocument {
	return { ...mapDocumentWrite(row), holderName: toTextOrNull(row.holder_name) };
}

function mapDocumentSummary(row: DocumentSummaryRow): DocumentSummary {
	return {
		...mapBase(row),
		title: toText(row.title),
		kind: row.kind as DocumentKind,
		holderPersonId: row.holder_person_id,
		holderName: toTextOrNull(row.holder_name),
		issuer: toTextOrNull(row.issuer),
		issuedOn: toDayOrNull(row.issued_on),
		expiresOn: toDayOrNull(row.expires_on),
		renewLeadDays: toIntOrNull(row.renew_lead_days) ?? 30,
		location: toTextOrNull(row.location),
		url: toTextOrNull(row.url),
		notes: toTextOrNull(row.notes)
	};
}

export async function getDocument(
	sql: Queryable,
	viewer: Viewer,
	id: string
): Promise<LifeDocument | null> {
	if (!isUuid(id)) return null;
	const rows = await sql<DocumentJoinRow[]>`
		select ${documentColumns(sql)}
		from ${sql(DOCUMENTS)} d
		left join ${sql(PEOPLE)} p on p.id = d.holder_person_id and ${readableScope(sql, viewer, 'p')}
		where d.id = ${id}::uuid and ${readableScope(sql, viewer, 'd')}
		limit 1
	`;
	return rows[0] ? mapDocument(rows[0]) : null;
}

export interface DocumentFilters extends PageOptions {
	kind?: DocumentKind;
	holder?: string;
	/** Expired, or within its own renewal lead time -- the Needs Attention
	 *  set, on the household's clock. */
	attention?: boolean;
	includeArchived?: boolean;
}

export async function listDocuments(
	sql: Queryable,
	viewer: Viewer,
	filters: DocumentFilters = {}
): Promise<DocumentSummary[]> {
	const { limit, offset } = pageOf(filters);
	const holderId = filters.holder && isUuid(filters.holder) ? filters.holder : null;
	const today = filters.attention ? await householdToday(sql, viewer.householdId) : null;

	const rows = await sql<DocumentSummaryRow[]>`
		select ${documentSummaryColumns(sql)}
		from ${sql(DOCUMENTS)} d
		left join ${sql(PEOPLE)} p on p.id = d.holder_person_id and ${readableScope(sql, viewer, 'p')}
		where ${readableScope(sql, viewer, 'd')}
		  and ${liveScope(sql, 'd', filters.includeArchived)}
		  ${filters.kind ? sql`and d.kind = ${filters.kind}` : sql``}
		  ${holderId ? sql`and d.holder_person_id = ${holderId}::uuid` : sql``}
		  ${
				today !== null
					? sql`and d.expires_on is not null
			          and d.expires_on <= (${today}::date + d.renew_lead_days)`
					: sql``
			}
		-- Soonest expiry first, with no expiry last (postgres's own default for
		-- ASC); everything /life-admin and the Today card need, already in the
		-- one order a caller has to split into "needs attention" / "later" /
		-- "no expiry" -- see that page's own load.
		order by d.expires_on asc, d.title asc
		limit ${limit} offset ${offset}
	`;
	return rows.map(mapDocumentSummary);
}

export interface DocumentInput extends OwnershipInput {
	title?: unknown;
	kind?: unknown;
	holderPersonId?: unknown;
	issuer?: unknown;
	reference?: unknown;
	issuedOn?: unknown;
	expiresOn?: unknown;
	renewLeadDays?: unknown;
	location?: unknown;
	url?: unknown;
	notes?: unknown;
}

const HOLDER_KINDS = ['me', 'person', 'pet'] as const;

/**
 * Resolves `holderPersonId` against the household and the viewer's own read
 * access, mirroring labs-visits.ts's `resolveVisitLink`: a holder chosen
 * from the form's own picker is never a guess, so an id that does not
 * resolve means something is wrong and the save must say so, rather than
 * silently clearing it the way an optional, guessed reference would
 * (contrast `resolveGoalId` in savings.ts, for a field nothing in this
 * application's UI lets someone pick wrong). Restricted to `people.kind`
 * 'me', 'person' or 'pet' -- a document's holder is a person or a pet's
 * registration, never a place.
 */
async function resolveHolder(
	sql: Queryable,
	viewer: Viewer,
	rawHolderId: unknown
): Promise<{ ok: true; id: string | null } | { ok: false }> {
	const holderId = optionalId(rawHolderId, 'holder');
	if (holderId === null) return { ok: true, id: null };
	if (!isUuid(holderId)) return { ok: false };
	const [row] = await sql<{ id: string }[]>`
		select id from ${sql(PEOPLE)}
		where id = ${holderId}::uuid
		  and ${readableScope(sql, viewer, PEOPLE)}
		  and kind in ${sql([...HOLDER_KINDS])}
		  and archived_at is null
	`;
	return row ? { ok: true, id: row.id } : { ok: false };
}

export function createDocument(
	sql: Queryable,
	viewer: Viewer,
	input: DocumentInput
): Promise<WriteResult<LifeDocument>> {
	return guarded<LifeDocument>(() =>
		atomically(sql, async (tx): Promise<WriteResult<LifeDocument>> => {
			const title = requiredText(input.title, 'title', 200);
			const kind = documentKind(input.kind);
			const holder = await resolveHolder(tx, viewer, input.holderPersonId);
			if (!holder.ok) {
				return { ok: false, reason: 'not_found', message: 'could not find that holder' };
			}
			const issuedOn = optionalDay(input.issuedOn, 'issued on');
			const expiresOn = optionalDay(input.expiresOn, 'expires on');
			const renewLeadDays =
				optionalInt(input.renewLeadDays, 'renewal notice', { min: 0, max: 365 }) ?? 30;
			// Private by default, owned by its creator -- the `daily_logs` shape,
			// not the `bills` one: a document is one person's thing first.
			const { ownerUserId, visibility } = resolveOwnership(viewer, input, {
				ownerUserId: viewer.userId,
				visibility: 'private'
			});
			if (ownerUserId === null) throw new InvalidInput('a document needs an owner');

			const rows = await tx<{ id: string }[]>`
				insert into ${tx(DOCUMENTS)} (
					household_id, owner_user_id, visibility, title, kind, holder_person_id, issuer,
					reference, issued_on, expires_on, renew_lead_days, location, url, notes,
					created_by, updated_by
				) values (
					${viewer.householdId}::uuid, ${ownerUserId}::uuid, ${visibility}, ${title}, ${kind},
					${holder.id}::uuid, ${optionalText(input.issuer, 'issuer')},
					${optionalText(input.reference, 'reference')}, ${issuedOn}::date, ${expiresOn}::date,
					${renewLeadDays}::int, ${optionalText(input.location, 'location')},
					${optionalText(input.url, 'url')}, ${optionalText(input.notes, 'notes')},
					${viewer.userId}::uuid, ${viewer.userId}::uuid
				)
				returning id
			`;
			const id = rows[0]?.id;
			if (!id) throw new Error('insert returned no row');

			const found = await getDocument(tx, viewer, id);
			if (!found) throw new Error('insert returned no readable row');
			return { ok: true, record: found };
		})
	);
}

export function updateDocument(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	patch: DocumentInput,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<LifeDocument>> {
	return guarded<LifeDocument>(() =>
		atomically(sql, async (tx): Promise<WriteResult<LifeDocument>> => {
			const current = await getDocument(tx, viewer, id);
			if (!current) return { ok: false, reason: 'not_found' };

			// Only re-resolved when the caller actually named a holder to change
			// -- the same `'key' in patch` discipline `updateMedicalVisit` uses for
			// its own three links -- so a save that does not mention the holder
			// keeps the current one rather than forcing a fresh readability check
			// against a value nobody touched.
			const holderGiven = 'holderPersonId' in patch;
			const holder = holderGiven
				? await resolveHolder(tx, viewer, patch.holderPersonId)
				: ({ ok: true, id: current.holderPersonId } as const);
			if (!holder.ok) {
				return { ok: false, reason: 'not_found', message: 'could not find that holder' };
			}

			const next = {
				title: patched(patch, 'title', current.title, (v) => requiredText(v, 'title', 200)),
				kind: patched(patch, 'kind', current.kind, documentKind),
				issuer: patched(patch, 'issuer', current.issuer, (v) => optionalText(v, 'issuer')),
				reference: patched(patch, 'reference', current.reference, (v) =>
					optionalText(v, 'reference')
				),
				issuedOn: patched(patch, 'issuedOn', current.issuedOn, (v) => optionalDay(v, 'issued on')),
				expiresOn: patched(patch, 'expiresOn', current.expiresOn, (v) =>
					optionalDay(v, 'expires on')
				),
				renewLeadDays: patched(
					patch,
					'renewLeadDays',
					current.renewLeadDays,
					(v) => optionalInt(v, 'renewal notice', { min: 0, max: 365 }) ?? 30
				),
				location: patched(patch, 'location', current.location, (v) => optionalText(v, 'location')),
				url: patched(patch, 'url', current.url, (v) => optionalText(v, 'url')),
				notes: patched(patch, 'notes', current.notes, (v) => optionalText(v, 'notes'))
			};
			const ownership = resolveOwnership(viewer, patch, {
				ownerUserId: current.ownerUserId,
				visibility: current.visibility
			});

			const result = await writeScoped<DocumentWriteRow, LifeDocument>({
				sql: tx,
				table: DOCUMENTS,
				id,
				readScope: readableScope(tx, viewer, DOCUMENTS),
				writeScope: writableScope(tx, viewer, DOCUMENTS),
				...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
				assignments: tx`
					title = ${next.title}, kind = ${next.kind}, holder_person_id = ${holder.id}::uuid,
					issuer = ${next.issuer}, reference = ${next.reference},
					issued_on = ${next.issuedOn}::date, expires_on = ${next.expiresOn}::date,
					renew_lead_days = ${next.renewLeadDays}::int, location = ${next.location},
					url = ${next.url}, notes = ${next.notes},
					owner_user_id = ${ownership.ownerUserId}::uuid, visibility = ${ownership.visibility},
					updated_at = now(), updated_by = ${viewer.userId}::uuid`,
				columns: documentWriteColumns(tx),
				map: mapDocumentWrite,
				mayWrite: writableBy(viewer)
			});
			if (!result.ok) return result;

			const found = await getDocument(tx, viewer, id);
			if (!found) throw new Error('update returned no readable row');
			return { ok: true, record: found };
		})
	);
}

export function setDocumentArchived(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	archived: boolean
): Promise<WriteResult<LifeDocument>> {
	return guarded<LifeDocument>(async () => {
		const result = await writeScoped<DocumentWriteRow, LifeDocument>({
			sql,
			table: DOCUMENTS,
			id,
			readScope: readableScope(sql, viewer, DOCUMENTS),
			writeScope: writableScope(sql, viewer, DOCUMENTS),
			assignments: sql`
				archived_at = case when ${archived}::boolean then now() else null end,
				updated_at = now(), updated_by = ${viewer.userId}::uuid`,
			columns: documentWriteColumns(sql),
			map: mapDocumentWrite,
			mayWrite: writableBy(viewer)
		});
		if (!result.ok) return result;
		const found = await getDocument(sql, viewer, result.record.id);
		if (!found) throw new Error('archive returned no readable row');
		return { ok: true, record: found };
	});
}

// ─── the Today card ─────────────────────────────────────────────────────────

export interface DocumentAttentionItem {
	id: string;
	title: string;
	holderName: string | null;
	/** Never null here: {@link attentionState} can only answer `expired` or
	 *  `due` for a row this query's own WHERE clause let through. */
	expiresOn: string;
	state: AttentionState;
}

/**
 * Expired or due documents, the viewer's readable ones only, soonest first --
 * for the Today card's own "Documents needing attention".
 *
 * A dedicated query rather than a call to {@link listDocuments}: that
 * function hands back every field a list row needs, where this one needs
 * just enough to name the document, say whose it is, and say how urgently --
 * the same shape `resultsForVisit`/`linkedNamesForVisit` take in
 * labs-visits.ts for their own single-purpose reads.
 */
export async function documentsNeedingAttention(
	sql: Queryable,
	viewer: Viewer
): Promise<DocumentAttentionItem[]> {
	const today = await householdToday(sql, viewer.householdId);
	const rows = await sql<
		{
			id: string;
			title: string;
			holder_name: string | null;
			expires_on: string;
			renew_lead_days: number;
		}[]
	>`
		select d.id, d.title, p.name as holder_name, d.expires_on::text as expires_on,
		       d.renew_lead_days
		from ${sql(DOCUMENTS)} d
		left join ${sql(PEOPLE)} p on p.id = d.holder_person_id and ${readableScope(sql, viewer, 'p')}
		where ${readableScope(sql, viewer, 'd')}
		  and d.archived_at is null
		  and d.expires_on is not null
		  and d.expires_on <= (${today}::date + d.renew_lead_days)
		order by d.expires_on asc, d.title asc
	`;
	return rows.map((row) => ({
		id: row.id,
		title: toText(row.title),
		holderName: toTextOrNull(row.holder_name),
		expiresOn: toDay(row.expires_on),
		state: attentionState(row.expires_on, today, row.renew_lead_days)
	}));
}

// ─── renewals ────────────────────────────────────────────────────────────────

export interface DocumentRenewal {
	id: string;
	documentId: string;
	renewedOn: string;
	previousExpiresOn: string | null;
	newExpiresOn: string;
	note: string | null;
	createdAt: Date;
	createdBy: string | null;
}

interface DocumentRenewalRow {
	id: string;
	document_id: string;
	renewed_on: string;
	previous_expires_on: string | null;
	new_expires_on: string;
	note: string | null;
	created_at: unknown;
	created_by: string | null;
}

function mapRenewal(row: DocumentRenewalRow): DocumentRenewal {
	return {
		id: row.id,
		documentId: row.document_id,
		renewedOn: toDay(row.renewed_on),
		previousExpiresOn: toDayOrNull(row.previous_expires_on),
		newExpiresOn: toDay(row.new_expires_on),
		note: toTextOrNull(row.note),
		createdAt: toDate(row.created_at),
		createdBy: row.created_by
	};
}

/** Most recently ENTERED first -- see {@link deleteRenewal}'s own header for
 *  why that is `created_at`, not `renewed_on`. */
export async function listDocumentRenewals(
	sql: Queryable,
	viewer: Viewer,
	documentId: string
): Promise<DocumentRenewal[]> {
	if (!isUuid(documentId)) return [];
	const rows = await sql<DocumentRenewalRow[]>`
		select r.id, r.document_id, r.renewed_on::text as renewed_on,
		       r.previous_expires_on::text as previous_expires_on,
		       r.new_expires_on::text as new_expires_on, r.note, r.created_at, r.created_by
		from document_renewals r
		join ${sql(DOCUMENTS)} d on d.id = r.document_id
		where r.document_id = ${documentId}::uuid and ${readableScope(sql, viewer, 'd')}
		order by r.created_at desc
	`;
	return rows.map(mapRenewal);
}

/**
 * Carries a refusal out of `renewDocument`/`deleteRenewal`'s own transaction
 * as a throw, so the transaction rolls back -- the same device reading.ts's
 * `BookWriteRefused` and food.ts's `AttachFailure` use, for the identical
 * reason: the renewal log is written (or deleted) before `expires_on` is
 * moved (or restored), and returning a later refusal as plain data would
 * leave that first write committed with nothing to match it.
 *
 * Carries only the reason and message, not a full `WriteResult` -- unlike
 * `BookWriteRefused`, what this wraps is a `WriteResult<LifeDocument>`
 * refusal but the function it unwinds returns a *different* record shape
 * (`{ document, renewal }` or a bare `LifeDocument`), so there is no single
 * `T` the original failure's optional `current` could be re-typed as.
 */
class DocumentWriteRefused extends Error {
	constructor(
		readonly reason: WriteFailure,
		readonly refusalMessage?: string
	) {
		super('document write refused');
	}
}

function asRefusal<T>(err: DocumentWriteRefused): WriteResult<T> {
	return err.refusalMessage
		? { ok: false, reason: err.reason, message: err.refusalMessage }
		: { ok: false, reason: err.reason };
}

export interface RenewDocumentInput {
	newExpiresOn?: unknown;
	/** Defaults to today, on the household's own clock. */
	renewedOn?: unknown;
	note?: unknown;
}

export interface RenewDocumentResult {
	document: LifeDocument;
	renewal: DocumentRenewal;
}

/**
 * Renews a document: logs the renewal (with the expiry it replaces) and
 * moves `expires_on`, in one transaction -- the identical shape
 * `recordBillPayment` takes for its own log-then-advance write
 * (collections.ts), including the `clock_timestamp()` reasoning on
 * {@link deleteRenewal}'s header.
 *
 * The new expiry is validated before anything is written -- a document
 * cannot be "renewed" into the past or onto today, which would leave it
 * immediately due or expired again -- so an invalid date never reaches the
 * log. The write-refusal guard below still exists for the second statement,
 * the move of `expires_on` itself: it runs under the same row lock the first
 * statement already proved writable, so it is not expected to refuse in
 * practice, but a refusal there must still unwind the renewal just inserted
 * rather than leave an orphaned log entry for a move that never happened.
 */
export function renewDocument(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	input: RenewDocumentInput
): Promise<WriteResult<RenewDocumentResult>> {
	if (!isUuid(id)) return Promise.resolve({ ok: false, reason: 'not_found' });

	return guarded<RenewDocumentResult>(async () => {
		try {
			return await atomically(sql, async (tx): Promise<WriteResult<RenewDocumentResult>> => {
				// Locked, so two concurrent renewals cannot both move expires_on
				// from the same starting point -- the identical reason
				// recordBillPayment locks the bill first.
				const [row] = await tx<{ id: string; expires_on: string | null }[]>`
					select id, expires_on::text as expires_on from ${tx(DOCUMENTS)}
					where id = ${id}::uuid and ${writableScope(tx, viewer, DOCUMENTS)}
					for update
				`;
				if (!row) return { ok: false, reason: 'not_found' };
				const previousExpiresOn = toDayOrNull(row.expires_on);

				const newExpiresOn = requiredDay(input.newExpiresOn, 'new expiry date');
				const today = await householdToday(tx, viewer.householdId);
				if (newExpiresOn <= today) {
					throw new InvalidInput('the new expiry date must be after today');
				}
				const renewedOn = optionalDay(input.renewedOn, 'renewed on') ?? today;
				const note = optionalText(input.note, 'note');

				// clock_timestamp(), not the column's own now() default -- see
				// deleteRenewal's header for why undo needs the order renewals were
				// actually entered in, not the order they take effect.
				const [renewalRow] = await tx<DocumentRenewalRow[]>`
					insert into document_renewals (
						document_id, renewed_on, previous_expires_on, new_expires_on, note,
						created_by, created_at
					) values (
						${id}::uuid, ${renewedOn}::date, ${previousExpiresOn}::date, ${newExpiresOn}::date,
						${note}, ${viewer.userId}::uuid, clock_timestamp()
					)
					returning id, document_id, renewed_on::text as renewed_on,
					          previous_expires_on::text as previous_expires_on,
					          new_expires_on::text as new_expires_on, note, created_at, created_by
				`;
				if (!renewalRow) throw new Error('insert returned no row');

				const updated = await writeScoped<DocumentWriteRow, LifeDocument>({
					sql: tx,
					table: DOCUMENTS,
					id,
					readScope: readableScope(tx, viewer, DOCUMENTS),
					writeScope: writableScope(tx, viewer, DOCUMENTS),
					assignments: tx`
						expires_on = ${newExpiresOn}::date,
						updated_at = now(), updated_by = ${viewer.userId}::uuid`,
					columns: documentWriteColumns(tx),
					map: mapDocumentWrite,
					mayWrite: writableBy(viewer)
				});
				if (!updated.ok) throw new DocumentWriteRefused(updated.reason, updated.message);

				const found = await getDocument(tx, viewer, id);
				if (!found) throw new Error('renew returned no readable row');
				return { ok: true, record: { document: found, renewal: mapRenewal(renewalRow) } };
			});
		} catch (err) {
			if (err instanceof DocumentWriteRefused) return asRefusal<RenewDocumentResult>(err);
			throw err;
		}
	});
}

/**
 * Undoes a renewal: deletes the log row and puts `expires_on` back to what
 * it was immediately before that renewal moved it.
 *
 * Only the most recently ENTERED renewal for the document may be undone --
 * the identical rule, for the identical reason, as `deleteBillPayment` in
 * collections.ts: an older row's own "previous expiry" is real, but
 * restoring it would jump the date backwards past every renewal recorded
 * since. "Most recent" means entered last (`created_at`), not expiring last
 * (`new_expires_on`): a renewal entered late for a document is still the
 * newest link in the chain that undo walks back.
 */
export function deleteRenewal(
	sql: Queryable,
	viewer: Viewer,
	documentId: string,
	renewalId: string
): Promise<WriteResult<LifeDocument>> {
	if (!isUuid(documentId) || !isUuid(renewalId)) {
		return Promise.resolve({ ok: false, reason: 'not_found' });
	}

	return guarded<LifeDocument>(async () => {
		try {
			return await atomically(sql, async (tx): Promise<WriteResult<LifeDocument>> => {
				const [row] = await tx<{ id: string }[]>`
					select id from ${tx(DOCUMENTS)}
					where id = ${documentId}::uuid and ${writableScope(tx, viewer, DOCUMENTS)}
					for update
				`;
				if (!row) return { ok: false, reason: 'not_found' };

				const [latest] = await tx<{ id: string; previous_expires_on: string | null }[]>`
					select id, previous_expires_on::text as previous_expires_on
					from document_renewals
					where document_id = ${documentId}::uuid
					order by created_at desc
					limit 1
					for update
				`;
				if (!latest || latest.id !== renewalId) {
					return {
						ok: false,
						reason: 'invalid',
						message: 'only the most recently entered renewal can be undone'
					};
				}

				await tx`delete from document_renewals where id = ${renewalId}::uuid`;

				const updated = await writeScoped<DocumentWriteRow, LifeDocument>({
					sql: tx,
					table: DOCUMENTS,
					id: documentId,
					readScope: readableScope(tx, viewer, DOCUMENTS),
					writeScope: writableScope(tx, viewer, DOCUMENTS),
					assignments: tx`
						expires_on = ${latest.previous_expires_on}::date,
						updated_at = now(), updated_by = ${viewer.userId}::uuid`,
					columns: documentWriteColumns(tx),
					map: mapDocumentWrite,
					mayWrite: writableBy(viewer)
				});
				if (!updated.ok) throw new DocumentWriteRefused(updated.reason, updated.message);

				const found = await getDocument(tx, viewer, documentId);
				if (!found) throw new Error('undo returned no readable row');
				return { ok: true, record: found };
			});
		} catch (err) {
			if (err instanceof DocumentWriteRefused) return asRefusal<LifeDocument>(err);
			throw err;
		}
	});
}
