import type { Fragment } from 'postgres';
import type { Viewer } from '../auth/authz';
import { toDate } from '../db/coerce';
import {
	InvalidInput,
	baseColumns,
	getScoped,
	guarded,
	isUuid,
	liveScope,
	mapBase,
	pageOf,
	readableScope,
	resolveOwnership,
	toDay,
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
import { optionalId, optionalText, patched, requiredDay, requiredText } from './validate';

/**
 * Lab results and medical visits (MODEL-002, feature pack 6; migration 0020).
 *
 * Three tables, joined the way the source joins them: `lab_markers` is a small
 * household vocabulary (a marker, defined once, with its reference range) in
 * the same shape as `health_vocabulary`; `lab_results` is one draw of one
 * marker on one day, optionally tied to the `medical_visits` appointment it
 * came from.
 *
 * Nothing here stores "Out of Range?" or a marker's "Results" rollup -- both
 * are formulas over data this module already has. {@link rangeStatus} is the
 * whole of the first one: a pure function, unit-tested at its boundaries, so
 * the marker's reference range can be edited without a stored flag going
 * stale against it. The second is just "the rows in `lab_results` with this
 * `marker_id`", asked for directly rather than cached.
 *
 * Visibility follows `ingredients`/`recipes`, not `daily_log_health`: these
 * are household-shared facts about an appointment or a blood draw, not a
 * private per-day journal entry, so all three tables default to no owner and
 * `visibility = 'household'` (see migration 0020 for the fuller reasoning).
 */

// ─── range status ───────────────────────────────────────────────────────────

export type RangeStatus = 'low' | 'high' | 'in_range' | 'no_reference';

/**
 * Where a value sits against a marker's reference range.
 *
 * Bounds are inclusive at the edge -- a value exactly at the reference high is
 * "in range", not "high" -- which is the ordinary clinical reading of a range
 * and, absent a source example that lands exactly on a boundary, the least
 * surprising one to show next to a table of results.
 *
 * Either bound may be `null` on its own: several markers in the source specify
 * only one (a marker that is only ever a problem when high, say). An absent
 * bound is simply not tracked and can never fail the value, which is why this
 * checks each bound independently rather than requiring both. Both absent
 * means the marker carries no reference range at all yet, which is a
 * different fact from "confirmed in range" and is reported as such.
 */
export function rangeStatus(value: number, low: number | null, high: number | null): RangeStatus {
	if (low === null && high === null) return 'no_reference';
	if (low !== null && value < low) return 'low';
	if (high !== null && value > high) return 'high';
	return 'in_range';
}

// ─── local input helpers ───────────────────────────────────────────────────
//
// Mirrors `optionalInt`/`requiredInt` in ./validate, for the decimal fields
// here (a reference bound, a result's value) that must not be truncated.
// Kept local rather than added to the shared file while sibling agents are
// also adding repositories alongside this one.

function optionalNumber(value: unknown, field: string): number | null {
	if (value === null || value === undefined || value === '') return null;
	const n = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(n)) throw new InvalidInput(`${field} must be a number`);
	return n;
}

function requiredNumber(value: unknown, field: string): number {
	const n = optionalNumber(value, field);
	if (n === null) throw new InvalidInput(`${field} is required`);
	return n;
}

/** `numeric` never arrives null for a live row; a null here means a read bug. */
function toNumber(value: unknown): number {
	const n = toNumberOrNull(value);
	if (n === null) throw new TypeError('expected a number, received null');
	return n;
}

/** "Bloodwork, Fasting" from a form field, the same shape `recipes.courses` accepts. */
function toStringArray(value: unknown): string[] {
	if (value === undefined || value === null || value === '') return [];
	if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
	return String(value)
		.split(',')
		.map((v) => v.trim())
		.filter(Boolean);
}

/** `text[]` arrives as an array under this driver; anything else is empty. */
function fromStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

// ─── lab markers ────────────────────────────────────────────────────────────

export interface LabMarker extends RecordBase {
	name: string;
	units: string | null;
	referenceLow: number | null;
	referenceHigh: number | null;
	notes: string | null;
}

interface LabMarkerRow extends BaseRow {
	name: string;
	units: string | null;
	reference_low: unknown;
	reference_high: unknown;
	notes: string | null;
}

const MARKERS = 'lab_markers';

const markerColumns = (sql: Queryable): Fragment => sql`
	${baseColumns(sql)},
	name, units, reference_low, reference_high, notes`;

const mapMarker = (row: LabMarkerRow): LabMarker => ({
	...mapBase(row),
	name: toText(row.name),
	units: toTextOrNull(row.units),
	referenceLow: toNumberOrNull(row.reference_low),
	referenceHigh: toNumberOrNull(row.reference_high),
	notes: toTextOrNull(row.notes)
});

export interface LabMarkerFilters extends PageOptions {
	search?: string;
	includeArchived?: boolean;
}

export async function listLabMarkers(
	sql: Queryable,
	viewer: Viewer,
	filters: LabMarkerFilters = {}
): Promise<LabMarker[]> {
	const { limit, offset } = pageOf(filters);
	const rows = await sql<LabMarkerRow[]>`
		select ${markerColumns(sql)} from ${sql(MARKERS)}
		where ${readableScope(sql, viewer, MARKERS)}
		  and ${liveScope(sql, MARKERS, filters.includeArchived)}
		  ${filters.search ? sql`and name ilike ${'%' + filters.search.trim() + '%'}` : sql``}
		order by name asc
		limit ${limit} offset ${offset}
	`;
	return rows.map(mapMarker);
}

export async function getLabMarker(
	sql: Queryable,
	viewer: Viewer,
	id: string
): Promise<LabMarker | null> {
	const row = await getScoped<LabMarkerRow>(
		sql,
		MARKERS,
		id,
		readableScope(sql, viewer, MARKERS),
		markerColumns(sql)
	);
	return row ? mapMarker(row) : null;
}

export interface LabMarkerInput extends OwnershipInput {
	name?: unknown;
	units?: unknown;
	referenceLow?: unknown;
	referenceHigh?: unknown;
	notes?: unknown;
}

function markerBounds(input: LabMarkerInput): { low: number | null; high: number | null } {
	const low = optionalNumber(input.referenceLow, 'reference low');
	const high = optionalNumber(input.referenceHigh, 'reference high');
	if (low !== null && high !== null && high < low) {
		throw new InvalidInput('reference high must not be below reference low');
	}
	return { low, high };
}

export function createLabMarker(
	sql: Queryable,
	viewer: Viewer,
	input: LabMarkerInput
): Promise<WriteResult<LabMarker>> {
	return guarded<LabMarker>(async () => {
		const name = requiredText(input.name, 'name', 200);
		const { low, high } = markerBounds(input);
		const { ownerUserId, visibility } = resolveOwnership(viewer, input, {
			ownerUserId: null,
			visibility: 'household'
		});

		// A condition rather than a unique index -- migration 0016 is the reason:
		// a duplicated label must not be able to abort an import.
		const rows = await sql<LabMarkerRow[]>`
			insert into ${sql(MARKERS)} (
				household_id, owner_user_id, visibility, name, units, reference_low,
				reference_high, notes, created_by, updated_by
			)
			select ${viewer.householdId}::uuid, ${ownerUserId}::uuid, ${visibility}, ${name},
				${optionalText(input.units, 'units')}, ${low}::numeric, ${high}::numeric,
				${optionalText(input.notes, 'notes')},
				${viewer.userId}::uuid, ${viewer.userId}::uuid
			where not exists (
				select 1 from ${sql(MARKERS)} existing
				where existing.household_id = ${viewer.householdId}::uuid
				  and lower(trim(existing.name)) = lower(trim(${name}))
				  and existing.archived_at is null
			)
			returning ${markerColumns(sql)}
		`;
		const row = rows[0];
		if (!row) return { ok: false, reason: 'invalid', message: 'that marker already exists' };
		return { ok: true, record: mapMarker(row) };
	});
}

export function updateLabMarker(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	patch: LabMarkerInput,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<LabMarker>> {
	return guarded<LabMarker>(async () => {
		const current = await getLabMarker(sql, viewer, id);
		if (!current) return { ok: false, reason: 'not_found' };

		const next = {
			name: patched(patch, 'name', current.name, (v) => requiredText(v, 'name', 200)),
			units: patched(patch, 'units', current.units, (v) => optionalText(v, 'units')),
			referenceLow: patched(patch, 'referenceLow', current.referenceLow, (v) =>
				optionalNumber(v, 'reference low')
			),
			referenceHigh: patched(patch, 'referenceHigh', current.referenceHigh, (v) =>
				optionalNumber(v, 'reference high')
			),
			notes: patched(patch, 'notes', current.notes, (v) => optionalText(v, 'notes'))
		};
		if (
			next.referenceLow !== null &&
			next.referenceHigh !== null &&
			next.referenceHigh < next.referenceLow
		) {
			throw new InvalidInput('reference high must not be below reference low');
		}
		const ownership = resolveOwnership(viewer, patch, {
			ownerUserId: current.ownerUserId,
			visibility: current.visibility
		});

		return writeScoped<LabMarkerRow, LabMarker>({
			sql,
			table: MARKERS,
			id,
			readScope: readableScope(sql, viewer, MARKERS),
			writeScope: writableScope(sql, viewer, MARKERS),
			expectedUpdatedAt,
			assignments: sql`
				name = ${next.name}, units = ${next.units},
				reference_low = ${next.referenceLow}::numeric,
				reference_high = ${next.referenceHigh}::numeric,
				notes = ${next.notes},
				owner_user_id = ${ownership.ownerUserId}::uuid, visibility = ${ownership.visibility},
				updated_at = now(), updated_by = ${viewer.userId}::uuid`,
			columns: markerColumns(sql),
			map: mapMarker,
			mayWrite: writableBy(viewer)
		});
	});
}

export function setLabMarkerArchived(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	archived: boolean
): Promise<WriteResult<LabMarker>> {
	return guarded<LabMarker>(async () =>
		writeScoped<LabMarkerRow, LabMarker>({
			sql,
			table: MARKERS,
			id,
			readScope: readableScope(sql, viewer, MARKERS),
			writeScope: writableScope(sql, viewer, MARKERS),
			assignments: sql`
				archived_at = case when ${archived}::boolean then now() else null end,
				updated_at = now(), updated_by = ${viewer.userId}::uuid`,
			columns: markerColumns(sql),
			map: mapMarker,
			mayWrite: writableBy(viewer)
		})
	);
}

/** How many live results each marker has, for the marker list's chips. */
export async function labResultCounts(
	sql: Queryable,
	viewer: Viewer
): Promise<Record<string, number>> {
	const rows = await sql<{ marker_id: string; total: number }[]>`
		select marker_id, count(*)::int as total
		from lab_results
		where ${readableScope(sql, viewer, 'lab_results')}
		  and archived_at is null and marker_id is not null
		group by marker_id
	`;
	return Object.fromEntries(rows.map((r) => [r.marker_id, Number(r.total)]));
}

// ─── lab results ────────────────────────────────────────────────────────────

export interface LabResult extends RecordBase {
	/**
	 * Nullable only because the importer's relation pass can, in principle,
	 * leave a row unmatched (see migration 0020); {@link createLabResult}
	 * requires one for anything created through the application.
	 */
	markerId: string | null;
	resultDate: string;
	value: number;
	notes: string | null;
	medicalVisitId: string | null;
}

interface LabResultRow extends BaseRow {
	marker_id: string | null;
	result_date: string;
	value: unknown;
	notes: string | null;
	medical_visit_id: string | null;
}

const RESULTS = 'lab_results';

const resultColumns = (sql: Queryable): Fragment => sql`
	${baseColumns(sql)},
	marker_id, result_date::text as result_date, value, notes, medical_visit_id`;

const mapResult = (row: LabResultRow): LabResult => ({
	...mapBase(row),
	markerId: row.marker_id,
	resultDate: toDay(row.result_date),
	value: toNumber(row.value),
	notes: toTextOrNull(row.notes),
	medicalVisitId: row.medical_visit_id
});

export interface LabResultFilters extends PageOptions {
	markerId?: string;
	medicalVisitId?: string;
	includeArchived?: boolean;
	/** Chronological for a chart, most-recent-first for a table. Default: desc. */
	order?: 'asc' | 'desc';
}

export async function listLabResults(
	sql: Queryable,
	viewer: Viewer,
	filters: LabResultFilters = {}
): Promise<LabResult[]> {
	const { limit, offset } = pageOf(filters);
	const rows = await sql<LabResultRow[]>`
		select ${resultColumns(sql)} from ${sql(RESULTS)}
		where ${readableScope(sql, viewer, RESULTS)}
		  and ${liveScope(sql, RESULTS, filters.includeArchived)}
		  ${filters.markerId ? sql`and marker_id = ${filters.markerId}::uuid` : sql``}
		  ${filters.medicalVisitId ? sql`and medical_visit_id = ${filters.medicalVisitId}::uuid` : sql``}
		order by ${filters.order === 'asc' ? sql`result_date asc` : sql`result_date desc`}
		limit ${limit} offset ${offset}
	`;
	return rows.map(mapResult);
}

export async function getLabResult(
	sql: Queryable,
	viewer: Viewer,
	id: string
): Promise<LabResult | null> {
	const row = await getScoped<LabResultRow>(
		sql,
		RESULTS,
		id,
		readableScope(sql, viewer, RESULTS),
		resultColumns(sql)
	);
	return row ? mapResult(row) : null;
}

export interface LabResultInput extends OwnershipInput {
	markerId?: unknown;
	resultDate?: unknown;
	value?: unknown;
	notes?: unknown;
	medicalVisitId?: unknown;
}

export function createLabResult(
	sql: Queryable,
	viewer: Viewer,
	input: LabResultInput
): Promise<WriteResult<LabResult>> {
	return guarded<LabResult>(async () => {
		const markerId = optionalId(input.markerId, 'marker');
		if (!markerId) throw new InvalidInput('marker is required');
		const resultDate = requiredDay(input.resultDate, 'date');
		const value = requiredNumber(input.value, 'value');
		const notes = optionalText(input.notes, 'notes');
		const medicalVisitId = optionalId(input.medicalVisitId, 'visit');
		const { ownerUserId, visibility } = resolveOwnership(viewer, input, {
			ownerUserId: null,
			visibility: 'household'
		});

		// Both cross-references are checked in the statement rather than assumed
		// from the shape of the id, the same as `addRecipeIngredient`: a marker
		// from another household must not be attachable by guessing its uuid.
		// The visit is optional, so an id that does not resolve is treated as
		// "no visit" rather than failing the whole result -- the marker is the
		// one reference this cannot proceed without.
		const rows = await sql<LabResultRow[]>`
			insert into ${sql(RESULTS)} (
				household_id, owner_user_id, visibility, marker_id, result_date, value, notes,
				medical_visit_id, created_by, updated_by
			)
			select ${viewer.householdId}::uuid, ${ownerUserId}::uuid, ${visibility}, m.id,
				${resultDate}::date, ${value}::numeric, ${notes}, v.id,
				${viewer.userId}::uuid, ${viewer.userId}::uuid
			from ${sql(MARKERS)} m
			left join medical_visits v
			  on v.id = ${medicalVisitId}::uuid and ${readableScope(sql, viewer, 'v')}
			where m.id = ${markerId}::uuid and ${readableScope(sql, viewer, 'm')}
			returning ${resultColumns(sql)}
		`;
		const row = rows[0];
		if (!row) return { ok: false, reason: 'not_found' };
		return { ok: true, record: mapResult(row) };
	});
}

export function updateLabResult(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	patch: LabResultInput,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<LabResult>> {
	return guarded<LabResult>(async () => {
		const current = await getLabResult(sql, viewer, id);
		if (!current) return { ok: false, reason: 'not_found' };

		const next = {
			resultDate: patched(patch, 'resultDate', current.resultDate, (v) => requiredDay(v, 'date')),
			value: patched(patch, 'value', current.value, (v) => requiredNumber(v, 'value')),
			notes: patched(patch, 'notes', current.notes, (v) => optionalText(v, 'notes'))
		};
		const ownership = resolveOwnership(viewer, patch, {
			ownerUserId: current.ownerUserId,
			visibility: current.visibility
		});

		return writeScoped<LabResultRow, LabResult>({
			sql,
			table: RESULTS,
			id,
			readScope: readableScope(sql, viewer, RESULTS),
			writeScope: writableScope(sql, viewer, RESULTS),
			expectedUpdatedAt,
			assignments: sql`
				result_date = ${next.resultDate}::date, value = ${next.value}::numeric,
				notes = ${next.notes},
				owner_user_id = ${ownership.ownerUserId}::uuid, visibility = ${ownership.visibility},
				updated_at = now(), updated_by = ${viewer.userId}::uuid`,
			columns: resultColumns(sql),
			map: mapResult,
			mayWrite: writableBy(viewer)
		});
	});
}

export function setLabResultArchived(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	archived: boolean
): Promise<WriteResult<LabResult>> {
	return guarded<LabResult>(async () =>
		writeScoped<LabResultRow, LabResult>({
			sql,
			table: RESULTS,
			id,
			readScope: readableScope(sql, viewer, RESULTS),
			writeScope: writableScope(sql, viewer, RESULTS),
			assignments: sql`
				archived_at = case when ${archived}::boolean then now() else null end,
				updated_at = now(), updated_by = ${viewer.userId}::uuid`,
			columns: resultColumns(sql),
			map: mapResult,
			mayWrite: writableBy(viewer)
		})
	);
}

// ─── results, joined with their marker (for a visit's own page) ───────────

export interface VisitLabResult {
	id: string;
	markerId: string;
	markerName: string;
	units: string | null;
	resultDate: string;
	value: number;
	status: RangeStatus;
}

/**
 * The lab results linked to one visit, with enough of their marker to show
 * and flag them without a second query per row.
 *
 * Explicit, table-prefixed columns rather than {@link baseColumns}: this joins
 * two RecordBase-shaped tables, and the unqualified column list that works for
 * a single table is ambiguous the moment a second one with the same columns
 * enters the FROM (see `mealPlan` in ./food for the same reasoning).
 */
export async function resultsForVisit(
	sql: Queryable,
	viewer: Viewer,
	visitId: string
): Promise<VisitLabResult[]> {
	if (!isUuid(visitId)) return [];
	const rows = await sql<
		{
			id: string;
			marker_id: string;
			marker_name: string;
			units: string | null;
			result_date: string;
			value: unknown;
			reference_low: unknown;
			reference_high: unknown;
		}[]
	>`
		select lr.id, lr.marker_id, lm.name as marker_name, lm.units,
		       lr.result_date::text as result_date, lr.value,
		       lm.reference_low, lm.reference_high
		from lab_results lr
		join lab_markers lm on lm.id = lr.marker_id
		where lr.medical_visit_id = ${visitId}::uuid
		  and ${readableScope(sql, viewer, 'lr')}
		  and lr.archived_at is null
		  and exists (
			select 1 from medical_visits v
			where v.id = lr.medical_visit_id and ${readableScope(sql, viewer, 'v')}
		  )
		order by lm.name asc, lr.result_date desc
	`;
	return rows.map((row) => {
		const value = toNumber(row.value);
		return {
			id: row.id,
			markerId: row.marker_id,
			markerName: toText(row.marker_name),
			units: toTextOrNull(row.units),
			resultDate: toDay(row.result_date),
			value,
			status: rangeStatus(
				value,
				toNumberOrNull(row.reference_low),
				toNumberOrNull(row.reference_high)
			)
		};
	});
}

// ─── medical visits ─────────────────────────────────────────────────────────

export interface MedicalVisit extends RecordBase {
	reason: string;
	visitAt: Date;
	visitType: string | null;
	provider: string | null;
	location: string | null;
	amount: number | null;
	currency: string;
	paidBy: string | null;
	requirements: string[];
	familyMember: string | null;
	notes: string | null;
	dailyLogId: string | null;
}

interface MedicalVisitRow extends BaseRow {
	reason: string;
	visit_at: unknown;
	visit_type: string | null;
	provider: string | null;
	location: string | null;
	amount: unknown;
	currency: string;
	paid_by: string | null;
	requirements: unknown;
	family_member: string | null;
	notes: string | null;
	daily_log_id: string | null;
}

const VISITS = 'medical_visits';

const visitColumns = (sql: Queryable): Fragment => sql`
	${baseColumns(sql)},
	reason, visit_at, visit_type, provider, location, amount, currency, paid_by,
	requirements, family_member, notes, daily_log_id`;

function mapVisit(row: MedicalVisitRow): MedicalVisit {
	return {
		...mapBase(row),
		reason: toText(row.reason),
		// A real timestamptz, read with `toDate` like `library.ts`'s own
		// `last_interaction_at` -- never trusted to the driver's own
		// conversion (see the note atop ./base on why).
		visitAt: toDate(row.visit_at),
		visitType: toTextOrNull(row.visit_type),
		provider: toTextOrNull(row.provider),
		location: toTextOrNull(row.location),
		amount: toNumberOrNull(row.amount),
		currency: toText(row.currency),
		paidBy: toTextOrNull(row.paid_by),
		requirements: fromStringArray(row.requirements),
		familyMember: toTextOrNull(row.family_member),
		notes: toTextOrNull(row.notes),
		dailyLogId: row.daily_log_id
	};
}

export interface MedicalVisitFilters extends PageOptions {
	includeArchived?: boolean;
	/** Chronological ascending (soonest/earliest first). Default: descending. */
	order?: 'asc' | 'desc';
}

export async function listMedicalVisits(
	sql: Queryable,
	viewer: Viewer,
	filters: MedicalVisitFilters = {}
): Promise<MedicalVisit[]> {
	const { limit, offset } = pageOf(filters);
	const rows = await sql<MedicalVisitRow[]>`
		select ${visitColumns(sql)} from ${sql(VISITS)}
		where ${readableScope(sql, viewer, VISITS)}
		  and ${liveScope(sql, VISITS, filters.includeArchived)}
		order by ${filters.order === 'asc' ? sql`visit_at asc` : sql`visit_at desc`}
		limit ${limit} offset ${offset}
	`;
	return rows.map(mapVisit);
}

export async function getMedicalVisit(
	sql: Queryable,
	viewer: Viewer,
	id: string
): Promise<MedicalVisit | null> {
	const row = await getScoped<MedicalVisitRow>(
		sql,
		VISITS,
		id,
		readableScope(sql, viewer, VISITS),
		visitColumns(sql)
	);
	return row ? mapVisit(row) : null;
}

export interface MedicalVisitInput extends OwnershipInput {
	reason?: unknown;
	/** "2026-09-25", read as wall-clock in the household's own timezone. */
	visitDate?: unknown;
	/** "14:40", paired with `visitDate` -- see {@link requiredInstant}. */
	visitTime?: unknown;
	visitType?: unknown;
	provider?: unknown;
	location?: unknown;
	amount?: unknown;
	currency?: unknown;
	paidBy?: unknown;
	requirements?: unknown;
	familyMember?: unknown;
	notes?: unknown;
}

/**
 * The household's own timezone, the same column `householdToday` (./base)
 * reads. A visit's wall-clock time has to be placed in this zone rather than
 * the server process's: nothing in the Dockerfile or compose.prod.yml pins
 * the container's own `TZ`, so a bare `new Date("2026-09-25T14:40")` would
 * read the form field as UTC on most deployments -- the same class of bug
 * `sourceInstant` exists to prevent on the import side (see mappers/
 * labs-visits.ts), here on the create/edit side instead.
 */
async function householdTimeZone(sql: Queryable, householdId: string): Promise<string> {
	const [row] = await sql<{ timezone: string }[]>`
		select timezone from households where id = ${householdId}::uuid
	`;
	return row?.timezone ?? 'America/Toronto';
}

/** How far `timeZone` is ahead of UTC at `instant`, in milliseconds. */
function zoneOffsetAt(instant: number, timeZone: string): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: 'numeric',
		day: 'numeric',
		hour: 'numeric',
		minute: 'numeric',
		second: 'numeric'
	}).formatToParts(new Date(instant));
	const part = (type: Intl.DateTimeFormatPartTypes) =>
		Number(parts.find((p) => p.type === type)?.value);
	const asUtc = Date.UTC(
		part('year'),
		part('month') - 1,
		part('day'),
		part('hour'),
		part('minute'),
		part('second')
	);
	return asUtc - instant;
}

/**
 * A `date` + `time` form pair ("2026-09-25", "14:40"), read as wall-clock
 * time in `timeZone` and converted to the UTC instant it names.
 */
function wallClockToInstant(day: string, time: string, timeZone: string): Date | null {
	const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
	const t = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time.trim());
	if (!d || !t) return null;
	// Read directly from the capture groups rather than `.map(Number)` over
	// the whole match array: the seconds group is `undefined` when absent
	// (the ordinary case for a `type="time"` field with no `step`), and
	// `Number(undefined)` is `NaN` -- which `?? 0` does NOT catch, since
	// nullish coalescing does not treat NaN as nullish. `Date.UTC` with any
	// NaN component silently returns NaN, and formatting that later throws.
	const year = Number(d[1]);
	const month = Number(d[2]);
	const day_ = Number(d[3]);
	const hour = Number(t[1]);
	const minute = Number(t[2]);
	const second = t[3] === undefined ? 0 : Number(t[3]);

	// The wall-clock parts pinned to UTC first, so the arithmetic itself
	// cannot drift across a daylight-saving boundary; only `timeZone`'s own
	// offset, read from Intl, participates. Taken twice for the same reason
	// `sourceInstant` does: the offset can itself change between the first
	// guess and the instant it produces, across a DST transition.
	const naive = Date.UTC(year, month - 1, day_, hour, minute, second);
	let instant = naive - zoneOffsetAt(naive, timeZone);
	instant = naive - zoneOffsetAt(instant, timeZone);
	return new Date(instant);
}

/** The wall-clock day/time `instant` names in `timeZone` -- the inverse of {@link wallClockToInstant}. */
function instantToWallClock(instant: Date, timeZone: string): { day: string; time: string } {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit'
	}).formatToParts(instant);
	const part = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((p) => p.type === type)?.value ?? '';
	return {
		day: `${part('year')}-${part('month')}-${part('day')}`,
		time: `${part('hour')}:${part('minute')}`
	};
}

/** A `date` + `time` pair from a form, required and household-zoned. */
function requiredInstant(dayValue: unknown, timeValue: unknown, timeZone: string): string {
	if (typeof dayValue !== 'string' || !dayValue.trim()) throw new InvalidInput('date is required');
	if (typeof timeValue !== 'string' || !timeValue.trim())
		throw new InvalidInput('time is required');
	const instant = wallClockToInstant(dayValue, timeValue, timeZone);
	if (!instant) throw new InvalidInput('date is not valid');
	return instant.toISOString();
}

function optionalCurrency(value: unknown): string {
	if (value === null || value === undefined || value === '') return 'CAD';
	const text = String(value).trim().toUpperCase();
	if (text.length !== 3) throw new InvalidInput('currency must be a 3-letter code');
	return text;
}

export function createMedicalVisit(
	sql: Queryable,
	viewer: Viewer,
	input: MedicalVisitInput
): Promise<WriteResult<MedicalVisit>> {
	return guarded<MedicalVisit>(async () => {
		const reason = requiredText(input.reason, 'reason', 300);
		const timeZone = await householdTimeZone(sql, viewer.householdId);
		const visitAt = requiredInstant(input.visitDate, input.visitTime, timeZone);
		const amount = optionalNumber(input.amount, 'cost');
		if (amount !== null && amount < 0) throw new InvalidInput('cost must not be negative');
		const currency = optionalCurrency(input.currency);
		const { ownerUserId, visibility } = resolveOwnership(viewer, input, {
			ownerUserId: null,
			visibility: 'household'
		});

		const rows = await sql<MedicalVisitRow[]>`
			insert into ${sql(VISITS)} (
				household_id, owner_user_id, visibility, reason, visit_at, visit_type, provider,
				location, amount, currency, paid_by, requirements, family_member, notes,
				created_by, updated_by
			) values (
				${viewer.householdId}::uuid, ${ownerUserId}::uuid, ${visibility}, ${reason},
				${visitAt}::timestamptz, ${optionalText(input.visitType, 'visit type')},
				${optionalText(input.provider, 'provider')}, ${optionalText(input.location, 'location')},
				${amount}::numeric, ${currency}, ${optionalText(input.paidBy, 'paid by')},
				${toStringArray(input.requirements)}::text[],
				${optionalText(input.familyMember, 'family member')},
				${optionalText(input.notes, 'notes')},
				${viewer.userId}::uuid, ${viewer.userId}::uuid
			)
			returning ${visitColumns(sql)}
		`;
		const row = rows[0];
		if (!row) throw new Error('insert returned no row');
		return { ok: true, record: mapVisit(row) };
	});
}

export function updateMedicalVisit(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	patch: MedicalVisitInput,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<MedicalVisit>> {
	return guarded<MedicalVisit>(async () => {
		const current = await getMedicalVisit(sql, viewer, id);
		if (!current) return { ok: false, reason: 'not_found' };

		// `visitAt` is one instant made of two form fields. Each is `patched`
		// independently against the CURRENT wall-clock day/time (not the raw
		// instant -- see `instantToWallClock`), so a save that touches only one
		// of them still recombines correctly with the other's existing value,
		// the same as every other field below.
		const timeZone = await householdTimeZone(sql, viewer.householdId);
		const currentWall = instantToWallClock(current.visitAt, timeZone);
		const requiredWallPart = (field: string) => (v: unknown) => {
			if (typeof v !== 'string' || !v.trim()) throw new InvalidInput(`${field} is required`);
			return v.trim();
		};
		const nextDay = patched(patch, 'visitDate', currentWall.day, requiredWallPart('date'));
		const nextTime = patched(patch, 'visitTime', currentWall.time, requiredWallPart('time'));
		const visitAt = requiredInstant(nextDay, nextTime, timeZone);

		const next = {
			reason: patched(patch, 'reason', current.reason, (v) => requiredText(v, 'reason', 300)),
			visitAt,
			visitType: patched(patch, 'visitType', current.visitType, (v) =>
				optionalText(v, 'visit type')
			),
			provider: patched(patch, 'provider', current.provider, (v) => optionalText(v, 'provider')),
			location: patched(patch, 'location', current.location, (v) => optionalText(v, 'location')),
			amount: patched(patch, 'amount', current.amount, (v) => optionalNumber(v, 'cost')),
			currency: patched(patch, 'currency', current.currency, optionalCurrency),
			paidBy: patched(patch, 'paidBy', current.paidBy, (v) => optionalText(v, 'paid by')),
			requirements: patched(patch, 'requirements', current.requirements, toStringArray),
			familyMember: patched(patch, 'familyMember', current.familyMember, (v) =>
				optionalText(v, 'family member')
			),
			notes: patched(patch, 'notes', current.notes, (v) => optionalText(v, 'notes'))
		};
		if (next.amount !== null && next.amount < 0) {
			throw new InvalidInput('cost must not be negative');
		}
		const ownership = resolveOwnership(viewer, patch, {
			ownerUserId: current.ownerUserId,
			visibility: current.visibility
		});

		return writeScoped<MedicalVisitRow, MedicalVisit>({
			sql,
			table: VISITS,
			id,
			readScope: readableScope(sql, viewer, VISITS),
			writeScope: writableScope(sql, viewer, VISITS),
			expectedUpdatedAt,
			assignments: sql`
				reason = ${next.reason}, visit_at = ${next.visitAt}::timestamptz,
				visit_type = ${next.visitType}, provider = ${next.provider},
				location = ${next.location}, amount = ${next.amount}::numeric,
				currency = ${next.currency}, paid_by = ${next.paidBy},
				owner_user_id = ${ownership.ownerUserId}::uuid, visibility = ${ownership.visibility},
				requirements = ${next.requirements}::text[], family_member = ${next.familyMember},
				notes = ${next.notes},
				updated_at = now(), updated_by = ${viewer.userId}::uuid`,
			columns: visitColumns(sql),
			map: mapVisit,
			mayWrite: writableBy(viewer)
		});
	});
}

export function setMedicalVisitArchived(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	archived: boolean
): Promise<WriteResult<MedicalVisit>> {
	return guarded<MedicalVisit>(async () =>
		writeScoped<MedicalVisitRow, MedicalVisit>({
			sql,
			table: VISITS,
			id,
			readScope: readableScope(sql, viewer, VISITS),
			writeScope: writableScope(sql, viewer, VISITS),
			assignments: sql`
				archived_at = case when ${archived}::boolean then now() else null end,
				updated_at = now(), updated_by = ${viewer.userId}::uuid`,
			columns: visitColumns(sql),
			map: mapVisit,
			mayWrite: writableBy(viewer)
		})
	);
}

// ─── a visit's symptoms ─────────────────────────────────────────────────────

export interface VisitSymptom {
	vocabularyId: string;
	name: string;
}

/** The symptom terms attached to a visit (`health_vocabulary`, kind = 'symptom'). */
export async function symptomsForVisit(
	sql: Queryable,
	viewer: Viewer,
	visitId: string
): Promise<VisitSymptom[]> {
	if (!isUuid(visitId)) return [];
	const rows = await sql<{ vocabulary_id: string; name: string }[]>`
		select s.vocabulary_id, v.name
		from medical_visit_symptoms s
		join health_vocabulary v on v.id = s.vocabulary_id
		where s.medical_visit_id = ${visitId}::uuid
		  and ${readableScope(sql, viewer, 'v')}
		  and exists (
			select 1 from medical_visits mv
			where mv.id = s.medical_visit_id and ${readableScope(sql, viewer, 'mv')}
		  )
		order by v.name asc
	`;
	return rows.map((row) => ({ vocabularyId: row.vocabulary_id, name: toText(row.name) }));
}

export async function addVisitSymptom(
	sql: Queryable,
	viewer: Viewer,
	visitId: string,
	vocabularyId: string
): Promise<WriteResult<{ medicalVisitId: string; vocabularyId: string }>> {
	if (!isUuid(visitId) || !isUuid(vocabularyId)) return { ok: false, reason: 'not_found' };

	const rows = await sql<{ medical_visit_id: string }[]>`
		insert into medical_visit_symptoms (medical_visit_id, vocabulary_id)
		select mv.id, v.id
		from medical_visits mv, health_vocabulary v
		where mv.id = ${visitId}::uuid and ${writableScope(sql, viewer, 'mv')}
		  and v.id = ${vocabularyId}::uuid and ${readableScope(sql, viewer, 'v')}
		  and v.kind = 'symptom' and v.archived_at is null
		on conflict do nothing
		returning medical_visit_id
	`;
	if (!rows[0]) {
		// Either side unreachable, or already attached -- the second is not a
		// failure (compare `planMeal` in ./food, which draws the same
		// distinction for its own on-conflict-do-nothing insert).
		const [existing] = await sql<{ count: number }[]>`
			select count(*)::int as count from medical_visit_symptoms
			where medical_visit_id = ${visitId}::uuid and vocabulary_id = ${vocabularyId}::uuid
		`;
		if (!existing?.count) return { ok: false, reason: 'not_found' };
	}
	return { ok: true, record: { medicalVisitId: visitId, vocabularyId } };
}

export async function removeVisitSymptom(
	sql: Queryable,
	viewer: Viewer,
	visitId: string,
	vocabularyId: string
): Promise<WriteResult<{ medicalVisitId: string }>> {
	if (!isUuid(visitId) || !isUuid(vocabularyId)) return { ok: false, reason: 'not_found' };

	const rows = await sql<{ medical_visit_id: string }[]>`
		delete from medical_visit_symptoms s
		using medical_visits mv
		where s.medical_visit_id = mv.id
		  and s.medical_visit_id = ${visitId}::uuid
		  and s.vocabulary_id = ${vocabularyId}::uuid
		  and ${writableScope(sql, viewer, 'mv')}
		returning s.medical_visit_id
	`;
	if (!rows[0]) return { ok: false, reason: 'not_found' };
	return { ok: true, record: { medicalVisitId: visitId } };
}
