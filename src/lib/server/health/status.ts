/**
 * Pure readiness types and aggregation.
 *
 * Deliberately free of database, filesystem, and environment imports so the
 * aggregation rule can be tested on its own. The probes that need those live
 * in ./checks.ts.
 */

export type CheckStatus = 'ok' | 'degraded' | 'fail';

export interface Check {
	name: string;
	status: CheckStatus;
	detail?: string;
}

export interface Readiness {
	status: CheckStatus;
	checks: Check[];
}

/** Any failure fails the whole check; any degradation degrades it. */
export function worst(checks: Check[]): CheckStatus {
	if (checks.some((c) => c.status === 'fail')) return 'fail';
	if (checks.some((c) => c.status === 'degraded')) return 'degraded';
	return 'ok';
}
