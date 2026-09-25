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
	weight: number | null;
	qtInterval: number | null;
}

/**
 * "128/76 · 64 bpm · glucose 6.2 · weight 71.4" — whichever readings a row
 * actually has, in a fixed order, for the recent-readings list.
 *
 * Glucose and weight carry no unit: the source records neither (Notion's
 * "Blood Glucose" and "Weight" properties are bare numbers), and a household
 * in Canada is plausibly using mmol/L rather than mg/dL — guessing a unit
 * here would risk stating something false rather than just something plain.
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
	if (reading.glucose !== null) parts.push(`glucose ${reading.glucose}`);
	if (reading.weight !== null) parts.push(`weight ${reading.weight}`);
	if (reading.qtInterval !== null) parts.push(`QT ${reading.qtInterval}ms`);
	return parts.join(' · ') || 'No readings recorded';
}
