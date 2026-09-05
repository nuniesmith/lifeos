/**
 * Explicit coercion of values read from PostgreSQL.
 *
 * The driver's JS type conversion cannot be relied on. In the bundled server
 * build it does not apply: timestamptz columns arrive as strings rather than
 * Date objects, and JS Dates and helper objects passed as parameters reach the
 * wire unconverted. Both directions failed only in production, while every
 * test against the source modules passed.
 *
 * So nothing here assumes a driver-parsed type. Values are coerced on the way
 * out, and parameters are sent as strings with explicit casts on the way in.
 */

/** Coerces a timestamp column to a Date, whatever representation it arrives in. */
export function toDate(value: unknown): Date {
	const d = toDateOrNull(value);
	if (!d) throw new TypeError(`expected a timestamp, received ${typeof value}`);
	return d;
}

/** As {@link toDate}, but passes null and undefined through. */
export function toDateOrNull(value: unknown): Date | null {
	if (value === null || value === undefined) return null;
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
	if (typeof value === 'string' || typeof value === 'number') {
		const d = new Date(value);
		return Number.isNaN(d.getTime()) ? null : d;
	}
	return null;
}
