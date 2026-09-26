import { withUnit } from '$lib/units';

/**
 * Presentation-only formatting for the measurements page.
 *
 * Kept pure and framework-free — no Svelte, no database — so the two things
 * most likely to be subtly wrong (placing a wall-clock time in the right
 * zone, and deciding what a row with an arbitrary subset of six possible
 * readings should say about itself) are unit-testable without mounting a
 * component or a database.
 */

/**
 * The wall-clock parts of `date` in `timeZone`, as a `datetime-local` input
 * expects them: `YYYY-MM-DDTHH:mm`, with no zone of its own.
 *
 * This is the read direction of the same idea `AT TIME ZONE` handles on the
 * way in (see `toInstant` in the repository): a stored instant is always one
 * fixed point in time — what changes is which wall clock it gets read back
 * onto.
 */
export function toLocalInput(date: Date | string, timeZone: string): string {
	const instant = typeof date === 'string' ? new Date(date) : date;
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit'
	}).formatToParts(instant);
	const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
	return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

export interface MeasurementLike {
	systolic: number | null;
	diastolic: number | null;
	heartRate: number | null;
	glucose: number | null;
	glucoseUnit?: string | null;
	weight: number | null;
	weightUnit?: string | null;
	qtInterval: number | null;
}

/**
 * "128/76 mmHg · 64 bpm · glucose 6.2 mmol/L · weight 71.4 kg" — whichever
 * readings a row actually has, in a fixed order, for the recent-readings list.
 *
 * Glucose and weight show the unit each reading was taken in (migration 0022).
 * A reading that recorded none — everything imported from Notion, whose
 * "Blood Glucose" and "Weight" are bare numbers — shows the number alone:
 * guessing mmol/L or kg would risk stating something false rather than just
 * something plain.
 */
export function summaryOf(reading: MeasurementLike): string {
	const parts: string[] = [];
	if (reading.systolic !== null && reading.diastolic !== null) {
		parts.push(`${reading.systolic}/${reading.diastolic} mmHg`);
	} else if (reading.systolic !== null) {
		parts.push(`${reading.systolic} mmHg (systolic)`);
	} else if (reading.diastolic !== null) {
		parts.push(`${reading.diastolic} mmHg (diastolic)`);
	}
	if (reading.heartRate !== null) parts.push(`${reading.heartRate} bpm`);
	if (reading.glucose !== null)
		parts.push(`glucose ${withUnit(reading.glucose, reading.glucoseUnit)}`);
	if (reading.weight !== null) parts.push(`weight ${withUnit(reading.weight, reading.weightUnit)}`);
	if (reading.qtInterval !== null) parts.push(`QT ${reading.qtInterval}ms`);
	return parts.join(' · ') || 'No readings recorded';
}

/**
 * The line under the charts when some readings could not be drawn: a glucose
 * or weight with no unit recorded cannot go on an axis that has one (see
 * `valueIn` in `$lib/units`), and leaving it off without a word would make
 * the chart look like the whole history. Null when nothing was left off.
 */
export function unitlessNote(glucose: number, weight: number): string | null {
	const kinds = [
		glucose > 0 ? `${glucose} glucose` : null,
		weight > 0 ? `${weight} weight` : null
	].filter((kind): kind is string => kind !== null);
	if (kinds.length === 0) return null;
	const one = glucose + weight === 1;
	return (
		`${kinds.join(' and ')} ${one ? 'reading has' : 'readings have'} no unit recorded, ` +
		`so the ${kinds.length > 1 ? 'charts leave' : 'chart leaves'} ${one ? 'it' : 'them'} out. ` +
		`Edit ${one ? 'it' : 'them'} below to set ${one ? 'its unit' : 'their units'}.`
	);
}
