/**
 * Wall clocks and instants in a named zone, with no library: `Intl` knows the
 * zone rules, and two small functions turn one into the other.
 *
 * The same offset arithmetic also lives, copied on purpose, in the importer
 * (`promote.ts`, Notion's date text) and in `health-measurements.ts`
 * (`datetime-local` input). Calendar sync is the third reader and the first
 * that needs both directions, so this is the shared home; those two can move
 * here when they are next touched.
 */

const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
	let f = formatters.get(timeZone);
	if (!f) {
		f = new Intl.DateTimeFormat('en-US', {
			timeZone,
			hourCycle: 'h23',
			year: 'numeric',
			month: 'numeric',
			day: 'numeric',
			hour: 'numeric',
			minute: 'numeric',
			second: 'numeric'
		});
		formatters.set(timeZone, f);
	}
	return f;
}

/** True when `Intl` knows the zone; calendars also send names it doesn't. */
export function isKnownZone(timeZone: string | null | undefined): timeZone is string {
	if (!timeZone) return false;
	try {
		formatterFor(timeZone);
		return true;
	} catch {
		return false;
	}
}

function parts(instant: number, timeZone: string): number[] {
	const out = formatterFor(timeZone).formatToParts(new Date(instant));
	const part = (type: Intl.DateTimeFormatPartTypes) =>
		Number(out.find((p) => p.type === type)?.value);
	return [part('year'), part('month'), part('day'), part('hour'), part('minute'), part('second')];
}

/** How far `timeZone` is ahead of UTC at `instant`, in milliseconds. */
export function zoneOffset(instant: number, timeZone: string): number {
	const [y, mo, d, h, mi, s] = parts(instant, timeZone);
	return Date.UTC(y!, mo! - 1, d!, h!, mi!, s!) - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant a wall-clock time ('YYYY-MM-DDTHH:MM[:SS]') names in `timeZone`.
 * The offset is taken at the wall time and again at the result, which settles
 * every time but the hour a DST change skips or repeats.
 */
export function placeInZone(wallClock: string, timeZone: string): Date {
	const m = WALL_CLOCK.exec(wallClock);
	if (!m) throw new Error(`not a wall-clock time: ${wallClock}`);
	const [, year, month, day, hour, minute, second] = m;
	const wall = Date.UTC(
		Number(year),
		Number(month) - 1,
		Number(day),
		Number(hour),
		Number(minute),
		Number(second ?? '0')
	);
	let instant = wall - zoneOffset(wall, timeZone);
	instant = wall - zoneOffset(instant, timeZone);
	return new Date(instant);
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** The wall-clock time ('YYYY-MM-DDTHH:MM:SS') of `instant` in `timeZone`. */
export function wallClockInZone(instant: Date, timeZone: string): string {
	const [y, mo, d, h, mi, s] = parts(instant.getTime(), timeZone);
	return `${pad(y!, 4)}-${pad(mo!)}-${pad(d!)}T${pad(h!)}:${pad(mi!)}:${pad(s!)}`;
}

/** The calendar day ('YYYY-MM-DD') of `instant` in `timeZone`. */
export function dayInZone(instant: Date, timeZone: string): string {
	return wallClockInZone(instant, timeZone).slice(0, 10);
}
