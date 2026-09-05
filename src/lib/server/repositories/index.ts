/**
 * The repository layer (MODEL-003).
 *
 * One module per aggregate, each exporting list / get / create / update /
 * archive plus the derived queries that belong to it. Everything takes a
 * `Queryable` and a `Viewer`: the first so a call composes inside a caller's
 * transaction, the second so authorization travels with the query rather than
 * being reapplied — or forgotten — by whoever renders the result.
 *
 * Route handlers should import from here and nowhere deeper, so that adding a
 * new caller cannot accidentally reach past the scoping helpers.
 */

export type { Viewer, Visibility } from '../auth/authz';

export {
	DEFAULT_LIMIT,
	InvalidInput,
	MAX_LIMIT,
	householdToday,
	isUuid,
	type Queryable,
	type RecordBase,
	type WriteFailure,
	type WriteResult
} from './base';

export {
	addDays,
	daysBetween,
	isDay,
	nextOccurrence,
	periodKey,
	periodsBetween,
	weekWindow,
	type Period,
	type Recurrence,
	type WeekStart
} from './dates';

export * from './areas';
export * from './daily-logs';
export * from './goals';
export * from './habits';
export * from './important-dates';
export * from './projects';
export * from './tags';
export * from './tasks';
