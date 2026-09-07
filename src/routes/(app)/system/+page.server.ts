import { sql } from '$lib/server/db';
import { readiness } from '$lib/server/health/checks';
import { requireAdmin } from '$lib/server/auth/authz';
import { toDate, toDateOrNull } from '$lib/server/db/coerce';
import type { PageServerLoad } from './$types';

/**
 * System.
 *
 * The operator's view of the install: is it healthy, when was it last backed
 * up, what has been imported, and which migrations are applied. All of it is
 * already reachable — `/api/health/ready`, the container log, psql — but only
 * from a terminal, which means in practice nobody looks. This is the same
 * information in the place the workspace navigation already points at.
 *
 * Admin only. None of it is household data, and a member cannot act on any of
 * it; `requireAdmin` refuses with a 404 rather than a 403, so the page does
 * not confirm its own existence to someone who may not see it.
 */

/** Kept short: this is a status page, not an audit log. */
const RECENT = 8;

export const load: PageServerLoad = async ({ locals }) => {
	requireAdmin(locals.user);

	const [health, backups, imports, migrations, counts] = await Promise.all([
		readiness(),
		sql<{ status: string; kind: string; started_at: unknown; finished_at: unknown }[]>`
			select status, kind, started_at, finished_at
			from backup_runs order by started_at desc limit ${RECENT}
		`,
		sql<
			{ id: string; started_at: unknown; finished_at: unknown; status: string; summary: unknown }[]
		>`
			select id, started_at, finished_at, status, summary
			from import_runs order by started_at desc limit ${RECENT}
		`,
		sql<{ name: string; applied_at: unknown; duration_ms: number }[]>`
			select name, applied_at, duration_ms
			from schema_migrations order by name desc limit ${RECENT}
		`,
		sql<{ table_name: string; total: number }[]>`
			select 'tasks' as table_name, count(*)::int as total from tasks
			union all select 'projects', count(*)::int from projects
			union all select 'areas', count(*)::int from areas
			union all select 'goals', count(*)::int from goals
			union all select 'habits', count(*)::int from habits
			union all select 'daily_logs', count(*)::int from daily_logs
			union all select 'tags', count(*)::int from tags
			union all select 'attachments', count(*)::int from attachments
			order by table_name
		`
	]);

	return {
		health,
		backups: backups.map((row) => ({
			status: row.status,
			kind: row.kind,
			startedAt: toDate(row.started_at),
			finishedAt: toDateOrNull(row.finished_at)
		})),
		imports: imports.map((row) => ({
			id: row.id,
			status: row.status,
			startedAt: toDate(row.started_at),
			finishedAt: toDateOrNull(row.finished_at),
			summary: row.summary as Record<string, unknown> | null
		})),
		migrations: migrations.map((row) => ({
			name: row.name,
			appliedAt: toDate(row.applied_at),
			durationMs: Number(row.duration_ms)
		})),
		counts: counts.map((row) => ({ table: row.table_name, total: Number(row.total) }))
	};
};
