import {
	daysBetween,
	type HealthMeasurement,
	type LabGlance,
	type MedicalVisit,
	type MedicationGlance
} from '$lib/server/repositories';
import { summaryOf, toLocalInput } from './measurements/format';

/**
 * The four pages under Health, each with the one line `/health` says about it.
 *
 * Built on the server into plain strings: the page ships four short sentences
 * rather than the records they were read from, and the wording — plurals, the
 * empty cases, "today" against a date — is unit-tested here without a
 * database or a rendered component. The numbers themselves come from the
 * repository (`medicationGlance`, `labGlance`), which owns the rules; nothing
 * here decides what counts as due or out of range.
 *
 * Server-only: it reads `daysBetween` from the repository layer, which is
 * fine for a load function and would fail the build in a component.
 */

export interface GlanceEntry {
	/** A raw application path; `ListRow` resolves it. */
	href: string;
	title: string;
	status: string;
}

const counted = (n: number, one: string, many = `${one}s`): string =>
	`${n} ${n === 1 ? one : many}`;

/**
 * A day as a person reads it: relative within a week either side, a plain
 * date beyond that — "41 days ago" is arithmetic the reader should not have
 * to undo, and the rest of `/health` already writes days as dates.
 */
export function dayLabel(day: string, today: string): string {
	const delta = daysBetween(today, day);
	if (delta === 0) return 'today';
	if (delta === 1) return 'tomorrow';
	if (delta === -1) return 'yesterday';
	if (delta > 1 && delta < 7) return `in ${delta} days`;
	if (delta < -1 && delta > -7) return `${-delta} days ago`;
	return day;
}

/**
 * An instant read on the household's wall clock, not the server's.
 *
 * `today` is the household's own (`householdToday`), so the instant has to be
 * placed in the same zone before the two are compared — otherwise an evening
 * reading in Toronto is "tomorrow" by UTC.
 */
export function whenLabel(at: Date, timeZone: string, today: string): string {
	const local = toLocalInput(at, timeZone);
	return `${dayLabel(local.slice(0, 10), today)} at ${local.slice(11, 16)}`;
}

export function medicationsStatus(glance: MedicationGlance): string {
	if (glance.tracked === 0) return 'Nothing tracked yet';
	const parts = [glance.dueToday > 0 ? `${glance.dueToday} due today` : 'Nothing due today'];
	if (glance.runningLow > 0) parts.push(`${glance.runningLow} running low`);
	return parts.join(' · ');
}

export function measurementsStatus(
	latest: HealthMeasurement | null,
	timeZone: string,
	today: string
): string {
	if (!latest) return 'No readings yet';
	return `Latest: ${summaryOf(latest)} · ${whenLabel(latest.measuredAt, timeZone, today)}`;
}

export function labsStatus(glance: LabGlance): string {
	if (glance.markers === 0) return 'No markers yet';
	if (glance.withResults === 0) return 'No results yet';
	if (glance.outOfRange === 0) {
		return `Nothing out of range · ${counted(glance.withResults, 'marker')} tested`;
	}
	return `${glance.outOfRange} of ${counted(glance.withResults, 'marker')} out of range`;
}

export function visitsStatus(next: MedicalVisit | null, timeZone: string, today: string): string {
	if (!next) return 'Nothing upcoming';
	return `Next: ${next.reason} · ${whenLabel(next.visitAt, timeZone, today)}`;
}

export function healthGlance(input: {
	medications: MedicationGlance;
	latestReading: HealthMeasurement | null;
	labs: LabGlance;
	nextVisit: MedicalVisit | null;
	timeZone: string;
	today: string;
}): GlanceEntry[] {
	const { timeZone, today } = input;
	return [
		{
			href: '/health/medications',
			title: 'Medications & supplements',
			status: medicationsStatus(input.medications)
		},
		{
			href: '/health/measurements',
			title: 'Measurements',
			status: measurementsStatus(input.latestReading, timeZone, today)
		},
		{ href: '/health/labs', title: 'Lab results', status: labsStatus(input.labs) },
		{
			href: '/health/visits',
			title: 'Medical visits',
			status: visitsStatus(input.nextVisit, timeZone, today)
		}
	];
}
