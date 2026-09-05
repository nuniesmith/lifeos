import type { PathnameWithSearchOrHash } from '$app/types';
import type { IconName } from './icons';

/**
 * Asserts an application path that SvelteKit's generated route union does not
 * contain yet.
 *
 * `resolve()` is typed against the routes that exist right now, and the shell
 * links to seven sections of which one is built. Every link in this library
 * therefore goes through `resolve(appPath(...))`: the call is real — it still
 * applies the configured base path, and it satisfies the lint rule that keeps
 * hand-built URLs out of the codebase — while the cast is the single, named
 * place where "this route is coming" is admitted.
 *
 * As each route lands, nothing has to change; the cast simply stops being a
 * widening one. It is the only such cast in the shell, so grep for it before
 * assuming a link is safe.
 */
export function appPath(path: string): PathnameWithSearchOrHash {
	return path as PathnameWithSearchOrHash;
}

/**
 * The shell's destinations, in one place.
 *
 * Both navigations — the desktop sidebar and the mobile bottom bar — read this
 * list, so a destination can never appear in one and be missing from the
 * other. It is plain data with no Svelte dependency, which is also what makes
 * the ordering and the role gating testable without rendering anything.
 *
 * `href` is a plain string rather than `resolve('/tasks')` because these routes
 * are built by later UI tickets: `resolve()` is typed against the routes that
 * exist today and would fail the type check for every destination but Today.
 * Switch each one to `resolve()` as its route lands.
 */
export interface Destination {
	href: string;
	label: string;
	icon: IconName;
	/**
	 * True for the destinations that earn a slot in the mobile bottom bar.
	 * Four is the ceiling: a fifth plus the "More" button makes each target
	 * narrower than a thumb on a small phone.
	 */
	onBar?: boolean;
}

export const APP_DESTINATIONS: readonly Destination[] = [
	{ href: '/', label: 'Today', icon: 'today', onBar: true },
	{ href: '/tasks', label: 'Tasks', icon: 'tasks', onBar: true },
	{ href: '/habits', label: 'Habits', icon: 'habits', onBar: true },
	{ href: '/journal', label: 'Journal', icon: 'journal', onBar: true },
	{ href: '/projects', label: 'Projects', icon: 'projects' },
	{ href: '/areas', label: 'Areas', icon: 'areas' },
	{ href: '/goals', label: 'Goals', icon: 'goals' }
];

export const ADMIN_DESTINATIONS: readonly Destination[] = [
	{ href: '/admin/people', label: 'People', icon: 'people' },
	{ href: '/admin/audit', label: 'Audit', icon: 'audit' }
];

/** The four destinations carried by the mobile bottom bar. */
export const BAR_DESTINATIONS: readonly Destination[] = APP_DESTINATIONS.filter((d) => d.onBar);

/** Everything the bottom bar could not fit, which the "More" sheet carries. */
export const OVERFLOW_DESTINATIONS: readonly Destination[] = APP_DESTINATIONS.filter(
	(d) => !d.onBar
);

/**
 * Admin destinations for a role.
 *
 * Hiding these is presentation only. The routes themselves are refused server
 * side by `requireAdmin`; an empty list here is a tidier surface, never the
 * access control.
 */
export function adminDestinationsFor(role: string | undefined): readonly Destination[] {
	return role === 'admin' ? ADMIN_DESTINATIONS : [];
}

/**
 * Whether a destination is the one currently open.
 *
 * A section owns its subtree — `/tasks/8f2` still lights up Tasks — but the
 * match stops at a path segment boundary so a future `/tasks-archive` would
 * not. Today is exact: as the root path it is a prefix of everything.
 */
export function isCurrent(pathname: string, href: string): boolean {
	const here = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
	if (href === '/') return here === '/';
	return here === href || here.startsWith(href + '/');
}
