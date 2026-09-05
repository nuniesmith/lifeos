import { InvalidInput } from './base';
import { isDay } from './dates';

/**
 * Input validation for the repository boundary (MODEL-003).
 *
 * These mirror the CHECK constraints in `migrations/0004_domain_mvp.sql`
 * rather than replacing them. The database stays the last word — a constraint
 * violation is a 500 and that is correct, because it means something reached
 * the table that no code path should have produced. Checking here first turns
 * the ordinary cases (an empty title, a status the UI does not offer) into a
 * result the caller can show next to the field, and keeps a transaction from
 * aborting halfway through a multi-record action.
 */

/** Trims, rejects blank, and enforces the column's length bound. */
export function requiredText(value: unknown, field: string, max: number): string {
	if (typeof value !== 'string') throw new InvalidInput(`${field} is required`);
	const trimmed = value.trim();
	if (!trimmed) throw new InvalidInput(`${field} is required`);
	if (trimmed.length > max) throw new InvalidInput(`${field} must be ${max} characters or fewer`);
	return trimmed;
}

/** Trims, and turns a blank string into null so "cleared" means null. */
export function optionalText(value: unknown, field: string, max = 20_000): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== 'string') throw new InvalidInput(`${field} must be text`);
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (trimmed.length > max) throw new InvalidInput(`${field} must be ${max} characters or fewer`);
	return trimmed;
}

export function requiredDay(value: unknown, field: string): string {
	const day = optionalDay(value, field);
	if (day === null) throw new InvalidInput(`${field} is required`);
	return day;
}

/**
 * Accepts a `YYYY-MM-DD` string only.
 *
 * A Date is refused rather than converted: converting one means choosing a
 * timezone to read it in, and the caller is the only party that knows which.
 */
export function optionalDay(value: unknown, field: string): string | null {
	if (value === null || value === undefined || value === '') return null;
	if (!isDay(value)) throw new InvalidInput(`${field} must be a date in YYYY-MM-DD form`);
	return value;
}

export function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
	if (typeof value === 'string' && (allowed as readonly string[]).includes(value))
		return value as T;
	throw new InvalidInput(`${field} must be one of ${allowed.join(', ')}`);
}

export function optionalOneOf<T extends string>(
	value: unknown,
	field: string,
	allowed: readonly T[]
): T | null {
	if (value === null || value === undefined || value === '') return null;
	return oneOf(value, field, allowed);
}

export function optionalInt(
	value: unknown,
	field: string,
	bounds: { min?: number; max?: number } = {}
): number | null {
	if (value === null || value === undefined || value === '') return null;
	const n = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(n)) throw new InvalidInput(`${field} must be a number`);
	const int = Math.trunc(n);
	if (bounds.min !== undefined && int < bounds.min) {
		throw new InvalidInput(`${field} must be at least ${bounds.min}`);
	}
	if (bounds.max !== undefined && int > bounds.max) {
		throw new InvalidInput(`${field} must be at most ${bounds.max}`);
	}
	return int;
}

export function requiredInt(
	value: unknown,
	field: string,
	bounds: { min?: number; max?: number } = {}
): number {
	const n = optionalInt(value, field, bounds);
	if (n === null) throw new InvalidInput(`${field} is required`);
	return n;
}

/** A fraction between 0 and 1, for the manual progress override on goals. */
export function optionalFraction(value: unknown, field: string): number | null {
	if (value === null || value === undefined || value === '') return null;
	const n = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(n)) throw new InvalidInput(`${field} must be a number`);
	if (n < 0 || n > 1) throw new InvalidInput(`${field} must be between 0 and 1`);
	return n;
}

export function optionalBool(value: unknown, field: string): boolean | null {
	if (value === null || value === undefined) return null;
	if (typeof value === 'boolean') return value;
	throw new InvalidInput(`${field} must be true or false`);
}

/**
 * A foreign key the caller supplied. Only the shape is checked here; whether
 * the target is in the same household and visible to the viewer is checked in
 * SQL, where it cannot be skipped.
 */
export function optionalId(value: unknown, field: string): string | null {
	if (value === null || value === undefined || value === '') return null;
	if (typeof value !== 'string') throw new InvalidInput(`${field} must be an id`);
	return value;
}

/** Reads a key from a patch only when the caller actually supplied it. */
export function patched<T>(patch: object, key: string, current: T, read: (value: unknown) => T): T {
	if (!(key in patch)) return current;
	return read((patch as Record<string, unknown>)[key]);
}
