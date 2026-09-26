import type { Viewer } from '../auth/authz';
import type { Queryable } from './base';
import {
	computeDueStatus,
	listMedications,
	recentDosesFor,
	type Medication,
	type ScheduleKind
} from './medications';
import { listHealthMeasurements, type HealthMeasurement } from './health-measurements';
import {
	listLabMarkers,
	listLabResults,
	listMedicalVisits,
	rangeStatus,
	type LabMarker,
	type LabResult,
	type MedicalVisit,
	type RangeStatus
} from './labs-visits';

/**
 * The Health hub (MODEL-002 follow-up: linking four sibling feature packs).
 *
 * Medications, Health Measurements, Labs & Visits and the original Health
 * vocabulary each got their own module and their own page, built one at a
 * time, and none of them knows the others exist. Both new surfaces that need
 * "a bit of everything" — the `/health` overview and the Today page's health
 * panel — read this one file instead of duplicating four queries' worth of
 * judgement calls twice.
 *
 * Unlike every sibling module in this directory, this one is deliberately a
 * composition of THEIR public functions rather than a table of its own: it
 * owns no scope predicate that is not already `readableScope` inside one of
 * those calls, and it does not reach past them into raw SQL. That is what
 * keeps the privacy guarantee cheap to state — a private
 * {@link HealthMeasurement} row cannot reach this module's output by any
 * route that does not already run it through {@link listHealthMeasurements}.
 *
 * Each section's *reduction* (pick the latest of several rows, split visits
 * into next/most-recent, decide whether a medication belongs on today's list)
 * is exported separately as a pure function, so the judgement calls have their
 * own fast unit tests and the database-backed integration tests are only
 * proving that the right rows were fetched.
 */

// ─── medications: what is due today ────────────────────────────────────────

export interface DueMedication {
	id: string;
	name: string;
	dose: string | null;
	unit: string | null;
	brand: string | null;
	scheduleKind: ScheduleKind;
	takenToday: boolean;
	runningLow: boolean;
}

export interface MedicationsOverview {
	am: DueMedication[];
	pm: DueMedication[];
	/** Due-today items that are neither `daily_am` nor `daily_pm` — a
	 *  `scheduled` medication whose weekday or interval lands on today.
	 *  `as_needed` medications are never "due" (see `computeDueStatus`) and
	 *  never appear here, even on a day one was logged. */
	other: DueMedication[];
	/** Due today and not yet taken — the count worth a badge. */
	dueCount: number;
	/** Due today and already taken. */
	takenCount: number;
	/** Across every live (non-archived) medication, not just today's list —
	 *  matches the meta line the medications page itself shows. */
	runningLowCount: number;
}

/**
 * Whether a medication belongs on today's list at all.
 *
 * A daily routine (`daily_am` / `daily_pm`) is on the list every day,
 * unconditionally — that is what "daily" means, and it must stay on the list
 * once ticked so the tick has something to undo.
 *
 * A `scheduled` medication belongs on the list once `computeDueStatus` says
 * it is due today, OR once it has already been taken today. The second half
 * matters on its own: `computeDueStatus`'s `nextDueOn` for an interval-based
 * schedule is computed from the most recent dose, so logging today's dose
 * immediately recomputes `nextDueOn` to a future date and `isDueToday`
 * true→false in the same request — without the `lastTakenOn === today`
 * clause, ticking a due medication would make it vanish instead of showing
 * as done.
 *
 * `as_needed` never belongs here, even if one was logged today: it was never
 * "due", and the medications page's own model agrees (`isDueToday` is
 * permanently `false` for it).
 */
export function isDueTodayOrJustTaken(
	scheduleKind: ScheduleKind,
	dueStatus: { isDueToday: boolean; lastTakenOn: string | null },
	today: string
): boolean {
	if (scheduleKind === 'as_needed') return false;
	if (scheduleKind === 'daily_am' || scheduleKind === 'daily_pm') return true;
	return dueStatus.isDueToday || dueStatus.lastTakenOn === today;
}

/** Pure grouping step, given each medication paired with its computed status. */
export function groupDueMedications(
	entries: readonly {
		medication: Pick<
			Medication,
			'id' | 'name' | 'dose' | 'unit' | 'brand' | 'scheduleKind' | 'runningLow'
		>;
		dueStatus: { isDueToday: boolean; lastTakenOn: string | null };
	}[],
	today: string
): Pick<MedicationsOverview, 'am' | 'pm' | 'other' | 'dueCount' | 'takenCount'> {
	const am: DueMedication[] = [];
	const pm: DueMedication[] = [];
	const other: DueMedication[] = [];
	let dueCount = 0;
	let takenCount = 0;

	for (const { medication, dueStatus } of entries) {
		if (!isDueTodayOrJustTaken(medication.scheduleKind, dueStatus, today)) continue;

		const takenToday = dueStatus.lastTakenOn === today;
		const item: DueMedication = {
			id: medication.id,
			name: medication.name,
			dose: medication.dose,
			unit: medication.unit,
			brand: medication.brand,
			scheduleKind: medication.scheduleKind,
			takenToday,
			runningLow: medication.runningLow
		};

		if (medication.scheduleKind === 'daily_am') am.push(item);
		else if (medication.scheduleKind === 'daily_pm') pm.push(item);
		else other.push(item);

		if (takenToday) takenCount++;
		else dueCount++;
	}

	return { am, pm, other, dueCount, takenCount };
}

async function medicationsOverview(
	sql: Queryable,
	viewer: Viewer,
	today: string
): Promise<MedicationsOverview> {
	const medications = await listMedications(sql, viewer, { limit: 300, order: 'name' });
	// `computeDueStatus` only ever reads the first (most recent) dose date, so
	// there is no reason to fetch more than one per medication here.
	const doses = await recentDosesFor(
		sql,
		viewer,
		medications.map((m) => m.id),
		1
	);

	const entries = medications.map((medication) => ({
		medication,
		dueStatus: computeDueStatus(
			medication,
			(doses.get(medication.id) ?? []).map((d) => d.onDate),
			today
		)
	}));

	const grouped = groupDueMedications(entries, today);
	return { ...grouped, runningLowCount: medications.filter((m) => m.runningLow).length };
}

// ─── measurements: the latest of each kind, plus a trend window ───────────

export interface LatestReading {
	value: number;
	measuredAt: Date;
	/** For glucose and weight, the unit that reading was taken in, or null when
	 *  it recorded none (migration 0022). Absent for kinds with only one unit. */
	unit?: string | null;
}

export interface LatestBloodPressure {
	systolic: number | null;
	diastolic: number | null;
	measuredAt: Date;
}

export interface MeasurementsOverview {
	bloodPressure: LatestBloodPressure | null;
	heartRate: LatestReading | null;
	glucose: LatestReading | null;
	weight: LatestReading | null;
	qtInterval: LatestReading | null;
	/** The single most recent reading of any kind — "the latest reading",
	 *  singular, for a compact panel that has room for only one line. */
	latestOverall: HealthMeasurement | null;
	/** Chronological (oldest first), for a small trend chart. A slice of
	 *  {@link MEASUREMENTS_WINDOW}, not the full history. */
	recentChronological: HealthMeasurement[];
}

/**
 * The first row (in whatever order `rows` is given) where `pick` returns a
 * value — i.e. the most recent reading of one kind, given rows already
 * ordered most-recent-first. Pure: no I/O, so it is unit-tested directly with
 * plain arrays rather than through the database.
 */
export function latestReading(
	rows: readonly HealthMeasurement[],
	pick: (row: HealthMeasurement) => number | null,
	pickUnit?: (row: HealthMeasurement) => string | null
): LatestReading | null {
	for (const row of rows) {
		const value = pick(row);
		if (value === null) continue;
		// The unit comes from the SAME row as the value, never from a later one:
		// a 6.2 shown beside another reading's "mg/dL" would be a false reading.
		return pickUnit
			? { value, measuredAt: row.measuredAt, unit: pickUnit(row) }
			: { value, measuredAt: row.measuredAt };
	}
	return null;
}

/** Blood pressure is one reading with two numbers, not two independent
 *  series — the latest BP is the latest row that names either half, showing
 *  whichever of the two that row actually has (never mixing a systolic from
 *  one visit with a diastolic from another). */
export function latestBloodPressure(
	rows: readonly HealthMeasurement[]
): LatestBloodPressure | null {
	const row = rows.find((r) => r.systolic !== null || r.diastolic !== null);
	if (!row) return null;
	return { systolic: row.systolic, diastolic: row.diastolic, measuredAt: row.measuredAt };
}

/** Rows fetched most-recent-first; ample for five sparse series without
 *  paging, matching the window the measurements page itself charts. */
const MEASUREMENTS_WINDOW = 200;

async function measurementsOverview(sql: Queryable, viewer: Viewer): Promise<MeasurementsOverview> {
	// `listHealthMeasurements` already applies `readableScope`, which for this
	// owner-private-by-default table means "this viewer's own readings only" —
	// the one call this whole module leans on for the privacy guarantee.
	const rows = await listHealthMeasurements(sql, viewer, { limit: MEASUREMENTS_WINDOW });

	return {
		bloodPressure: latestBloodPressure(rows),
		heartRate: latestReading(rows, (r) => r.heartRate),
		glucose: latestReading(
			rows,
			(r) => r.glucose,
			(r) => r.glucoseUnit
		),
		weight: latestReading(
			rows,
			(r) => r.weight,
			(r) => r.weightUnit
		),
		qtInterval: latestReading(rows, (r) => r.qtInterval),
		latestOverall: rows[0] ?? null,
		recentChronological: [...rows].reverse()
	};
}

// ─── labs: the latest result per marker, flagged against its range ────────

export interface LabOverviewItem {
	markerId: string;
	markerName: string;
	units: string | null;
	value: number;
	resultDate: string;
	status: RangeStatus;
}

/**
 * One row per marker that has at least one live result: its most recent
 * value, flagged with {@link rangeStatus} against that SAME marker's current
 * reference range. A marker with no result yet contributes nothing — there
 * is nothing to flag.
 *
 * Pure given the two lists already fetched, so the "latest per marker"
 * reduction is unit-tested without a database; `labsOverview` below is only
 * responsible for fetching `markers` and `results` correctly.
 */
export function latestLabResults(
	markers: readonly LabMarker[],
	results: readonly LabResult[]
): LabOverviewItem[] {
	const latestByMarker = new Map<string, LabResult>();
	for (const result of results) {
		if (!result.markerId) continue;
		// `results` must already be most-recent-first; the first time a marker
		// is seen IS its latest live result.
		if (!latestByMarker.has(result.markerId)) latestByMarker.set(result.markerId, result);
	}

	const items: LabOverviewItem[] = [];
	for (const marker of markers) {
		const result = latestByMarker.get(marker.id);
		if (!result) continue;
		items.push({
			markerId: marker.id,
			markerName: marker.name,
			units: marker.units,
			value: result.value,
			resultDate: result.resultDate,
			status: rangeStatus(result.value, marker.referenceLow, marker.referenceHigh)
		});
	}
	return items;
}

/** Results fetched most-recent-first; generous enough that a marker with
 *  infrequent draws still has its latest one inside the window even when
 *  other markers are tested far more often. */
const LAB_RESULTS_WINDOW = 500;

async function labsOverview(sql: Queryable, viewer: Viewer): Promise<LabOverviewItem[]> {
	const [markers, results] = await Promise.all([
		listLabMarkers(sql, viewer, { limit: 300 }),
		listLabResults(sql, viewer, { order: 'desc', limit: LAB_RESULTS_WINDOW })
	]);
	return latestLabResults(markers, results);
}

// ─── visits: the next one and the most recent one ──────────────────────────

export interface VisitsOverview {
	mostRecent: MedicalVisit | null;
	next: MedicalVisit | null;
}

/**
 * Splits a visit list into "the most recent past visit" and "the next
 * upcoming one", given `visits` ascending by `visitAt` (as
 * {@link listMedicalVisits} returns with `order: 'asc'`) and the instant to
 * compare against. Pure, so the boundary — a visit exactly at `nowMs` counts
 * as upcoming, matching the visits page's own `>=` — is unit-tested without a
 * clock or a database.
 */
export function splitVisits(
	visits: readonly Pick<MedicalVisit, 'visitAt'>[],
	nowMs: number
): { mostRecent: number | null; next: number | null } {
	let mostRecentIndex: number | null = null;
	let nextIndex: number | null = null;
	for (let i = 0; i < visits.length; i++) {
		if (visits[i]!.visitAt.getTime() >= nowMs) {
			if (nextIndex === null) nextIndex = i;
		} else {
			mostRecentIndex = i; // ascending order: the last one seen wins
		}
	}
	return { mostRecent: mostRecentIndex, next: nextIndex };
}

async function visitsOverview(sql: Queryable, viewer: Viewer): Promise<VisitsOverview> {
	const visits = await listMedicalVisits(sql, viewer, { order: 'asc', limit: 500 });
	const { mostRecent, next } = splitVisits(visits, Date.now());
	return {
		mostRecent: mostRecent === null ? null : visits[mostRecent]!,
		next: next === null ? null : visits[next]!
	};
}

// ─── everything together ───────────────────────────────────────────────────

export interface HealthOverview {
	medications: MedicationsOverview;
	measurements: MeasurementsOverview;
	labs: LabOverviewItem[];
	visits: VisitsOverview;
}

/**
 * Feeds both the `/health` overview hub and the Today page's health panel —
 * one fetch, shaped once, so the two surfaces cannot quietly disagree about
 * what "due today" or "the latest reading" means.
 *
 * `today` is the caller's own {@link import('./base').householdToday} result,
 * not read again here: every existing page that needs "today" already reads
 * it once per request, and a second read inside this helper could disagree
 * with the caller's if the request happened to straddle midnight.
 */
export async function healthOverview(
	sql: Queryable,
	viewer: Viewer,
	today: string
): Promise<HealthOverview> {
	const [medications, measurements, labs, visits] = await Promise.all([
		medicationsOverview(sql, viewer, today),
		measurementsOverview(sql, viewer),
		labsOverview(sql, viewer),
		visitsOverview(sql, viewer)
	]);
	return { medications, measurements, labs, visits };
}
