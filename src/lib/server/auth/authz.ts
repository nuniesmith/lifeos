import { error } from '@sveltejs/kit';
import type { AuthUser } from './service';

/**
 * Authorization rules (AUTH-005).
 *
 * Pure and independently testable. The repository layer must call these; route
 * guards and hidden navigation are presentation, not access control.
 */

export type Visibility = 'household' | 'private';

export interface OwnedRecord {
	householdId: string;
	ownerUserId: string | null;
	visibility: Visibility;
}

export interface Viewer {
	userId: string;
	householdId: string;
	role: 'admin' | 'member';
}

export function viewerOf(user: AuthUser, householdId: string): Viewer {
	return { userId: user.id, householdId, role: user.role };
}

/**
 * Whether a viewer may read a record.
 *
 * Two rules, in order:
 *
 *  1. Household isolation is absolute. Nothing crosses households, for any
 *     role. This is the boundary that matters most, because the import assigns
 *     every record to one household.
 *  2. `private` means private *from the other household member*, including an
 *     admin. Administration covers accounts and system operations, not reading
 *     someone's journal or medical log. The server operator can still read the
 *     database directly and is treated as trusted; that is a separate concern
 *     from what the application grants.
 */
export function canRead(record: OwnedRecord, viewer: Viewer): boolean {
	if (record.householdId !== viewer.householdId) return false;
	if (record.visibility === 'household') return true;
	return record.ownerUserId === viewer.userId;
}

/**
 * Whether a viewer may modify a record. Stricter than reading: a shared
 * household record is readable by both members but only its owner may change
 * it. Records with no owner are household-wide and either member may edit.
 */
export function canWrite(record: OwnedRecord, viewer: Viewer): boolean {
	if (!canRead(record, viewer)) return false;
	if (record.ownerUserId === null) return true;
	return record.ownerUserId === viewer.userId;
}

/** System administration: accounts, imports, exports, settings, operations. */
export function isSystemAdmin(user: AuthUser): boolean {
	return user.role === 'admin';
}

/**
 * SQL predicate for scoping a query to what a viewer may read.
 *
 * Returned as fragments rather than a string so callers interpolate it as
 * parameters. Filtering in the database rather than in JS means a forgotten
 * check cannot leak rows that were already fetched.
 */
export function readableWhere(viewer: Viewer, alias = 't') {
	return {
		text:
			`${alias}.household_id = $household ` +
			`and (${alias}.visibility = 'household' or ${alias}.owner_user_id = $viewer)`,
		household: viewer.householdId,
		viewer: viewer.userId
	};
}

// ─── route guards ──────────────────────────────────────────────────────────

/** Throws 401 unless signed in. */
export function requireUser(user: AuthUser | null): AuthUser {
	if (!user) error(401, 'Sign in to continue.');
	return user;
}

/**
 * Throws unless signed in as an admin. Deliberately 404, not 403: confirming
 * that an admin-only page exists tells a member what to go looking for.
 */
export function requireAdmin(user: AuthUser | null): AuthUser {
	const u = requireUser(user);
	if (!isSystemAdmin(u)) error(404, 'Not found');
	return u;
}

/**
 * Throws unless the account has completed its forced credential rotation.
 * Guards anything a half-provisioned bootstrap account must not reach.
 */
export function requireRotated(user: AuthUser | null): AuthUser {
	const u = requireUser(user);
	if (u.mustChangeCredentials) error(403, 'Finish setting up your account first.');
	return u;
}
