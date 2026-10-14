import type { Viewer } from '../auth/authz';
import { readableScope, toNumberOrNull, toText, toTextOrNull, type Queryable } from './base';
import { getDailyLogForDate } from './daily-logs';
import { healthForLog, type LoggedTerm } from './health';

/**
 * One day of health, from every place it is kept (PACK3-001).
 *
 * Readings, doses and visits carry a moment, and are placed on the day and
 * the clock in the household's timezone, not the server's. Lab results carry
 * only a date. The journal's own words and its mood and energy are the
 * viewer's own day, as the journal is: a household-visible day of the other
 * member's is not this person's health.
 *
 * Each source is scoped as its own page scopes it, and archived records are
 * left out as they are there. A dose is the medication's: it has no owner of
 * its own, so it is readable when its medication is.
 */

export interface DayMeasurement {
	id: string;
	/** HH:MM on the household's clock. */
	time: string;
	systolic: number | null;
	diastolic: number | null;
	heartRate: number | null;
	glucose: number | null;
	glucoseUnit: string | null;
	weight: number | null;
	weightUnit: string | null;
	qtInterval: number | null;
	notes: string | null;
}

export interface DayDose {
	medicationId: string;
	medicationName: string;
	dose: string | null;
	slot: 'am' | 'pm' | 'adhoc';
	/** HH:MM, or null when only the day is known (every imported dose). */
	time: string | null;
	note: string | null;
}

export interface DayVisit {
	id: string;
	time: string;
	reason: string;
	visitType: string | null;
	provider: string | null;
}

export interface DayLabResult {
	id: string;
	markerId: string;
	markerName: string;
	value: number;
	units: string | null;
	referenceLow: number | null;
	referenceHigh: number | null;
}

export interface HealthDay {
	measurements: DayMeasurement[];
	doses: DayDose[];
	visits: DayVisit[];
	labResults: DayLabResult[];
	/** Symptoms, activity and exercise tagged on the viewer's journal day. */
	words: LoggedTerm[];
	mood: string | null;
	energyLevel: number | null;
}

export async function healthDay(sql: Queryable, viewer: Viewer, date: string): Promise<HealthDay> {
	// The household's zone, once, for every "which day, what time" below.
	const zone = sql`(select timezone from households where id = ${viewer.householdId}::uuid)`;

	const [measurements, doses, visits, labs, log] = await Promise.all([
		sql<
			{
				id: string;
				time: string;
				systolic: number | null;
				diastolic: number | null;
				heart_rate: number | null;
				glucose: string | null;
				glucose_unit: string | null;
				weight: string | null;
				weight_unit: string | null;
				qt_interval: number | null;
				notes: string | null;
			}[]
		>`
			select m.id, to_char(m.measured_at at time zone ${zone}, 'HH24:MI') as time,
			       m.systolic, m.diastolic, m.heart_rate, m.glucose, m.glucose_unit,
			       m.weight, m.weight_unit, m.qt_interval, m.notes
			from health_measurements m
			where ${readableScope(sql, viewer, 'm')} and m.archived_at is null
			  and (m.measured_at at time zone ${zone})::date = ${date}::date
			order by m.measured_at asc
		`,
		sql<
			{
				medication_id: string;
				name: string;
				dose: string | null;
				unit: string | null;
				slot: string;
				time: string | null;
				note: string | null;
			}[]
		>`
			select d.medication_id, med.name, med.dose::text as dose, med.unit, d.slot,
			       to_char(d.taken_at at time zone ${zone}, 'HH24:MI') as time, d.note
			from medication_doses d
			join medications med on med.id = d.medication_id
			where ${readableScope(sql, viewer, 'med')} and d.on_date = ${date}::date
			order by d.taken_at asc nulls last, d.slot asc, med.name asc
		`,
		sql<
			{
				id: string;
				time: string;
				reason: string;
				visit_type: string | null;
				provider: string | null;
			}[]
		>`
			select v.id, to_char(v.visit_at at time zone ${zone}, 'HH24:MI') as time,
			       v.reason, v.visit_type, v.provider
			from medical_visits v
			where ${readableScope(sql, viewer, 'v')} and v.archived_at is null
			  and (v.visit_at at time zone ${zone})::date = ${date}::date
			order by v.visit_at asc
		`,
		sql<
			{
				id: string;
				marker_id: string;
				name: string;
				value: string;
				units: string | null;
				reference_low: string | null;
				reference_high: string | null;
			}[]
		>`
			select r.id, r.marker_id, k.name, r.value, k.units, k.reference_low, k.reference_high
			from lab_results r
			-- The marker is scoped too: a result under a marker the viewer
			-- cannot read would otherwise name it.
			join lab_markers k on k.id = r.marker_id and ${readableScope(sql, viewer, 'k')}
			where ${readableScope(sql, viewer, 'r')} and r.archived_at is null
			  and k.archived_at is null and r.result_date = ${date}::date
			order by k.name asc
		`,
		getDailyLogForDate(sql, viewer, date)
	]);

	return {
		measurements: measurements.map((row) => ({
			id: row.id,
			time: row.time,
			systolic: row.systolic,
			diastolic: row.diastolic,
			heartRate: row.heart_rate,
			glucose: toNumberOrNull(row.glucose),
			glucoseUnit: row.glucose_unit,
			weight: toNumberOrNull(row.weight),
			weightUnit: row.weight_unit,
			qtInterval: row.qt_interval,
			notes: toTextOrNull(row.notes)
		})),
		doses: doses.map((row) => ({
			medicationId: row.medication_id,
			medicationName: toText(row.name),
			dose: row.dose ? [row.dose, row.unit].filter(Boolean).join(' ') : null,
			slot: row.slot as DayDose['slot'],
			time: row.time,
			note: toTextOrNull(row.note)
		})),
		visits: visits.map((row) => ({
			id: row.id,
			time: row.time,
			reason: toText(row.reason),
			visitType: toTextOrNull(row.visit_type),
			provider: toTextOrNull(row.provider)
		})),
		labResults: labs.map((row) => ({
			id: row.id,
			markerId: row.marker_id,
			markerName: toText(row.name),
			value: toNumberOrNull(row.value) ?? 0,
			units: toTextOrNull(row.units),
			referenceLow: toNumberOrNull(row.reference_low),
			referenceHigh: toNumberOrNull(row.reference_high)
		})),
		words: log ? await healthForLog(sql, viewer, log.id) : [],
		mood: log?.mood ?? null,
		energyLevel: log?.energyLevel ?? null
	};
}
