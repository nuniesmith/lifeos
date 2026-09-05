import type { Sql, TransactionSql } from 'postgres';

type Queryable = Sql | TransactionSql;

/**
 * Replacements for the source's formula and rollup columns (IMP-008).
 *
 * Those columns were deliberately not imported: a stored "Percent Completed"
 * is a snapshot that silently goes stale, and the whole reason for moving to a
 * real database is that these can be asked rather than remembered.
 *
 * Each replacement is paired with the source column it stands in for, so the
 * import can compare the two and report where they differ.
 *
 * A difference is not automatically a bug. Notion's rollups carry filters that
 * the export does not contain, and three separate readings of "Open Direct
 * Tasks" — all open tasks, top-level only, not-via-a-project — each match some
 * areas and not others. Those definitions have to come from live Notion
 * (DISC-004); guessing at them would bake a wrong rule into the replacement and
 * make it agree by accident. So a mismatch here is reported as "definition not
 * captured", not as a failure, and the count tells the operator how much of the
 * column the straightforward reading already explains.
 */

export interface DerivedComparison {
	database: string;
	column: string;
	compared: number;
	agree: number;
	differ: number;
	/**
	 * `matches` when the replacement reproduces the source everywhere.
	 * `needs_definition` when it does not, meaning the source column's filter
	 * has to be captured from live Notion before this can be trusted.
	 */
	status: 'matches' | 'needs_definition';
	examples: { title: string | null; source: string; computed: string }[];
}

/** Normalises for comparison: the source renders numbers and Yes/No as text. */
function sameValue(source: string, computed: string): boolean {
	const a = source.trim().toLowerCase();
	const b = computed.trim().toLowerCase();
	if (a === b) return true;
	// "3" vs "3.0", and Notion's checkbox spellings.
	const na = Number(a);
	const nb = Number(b);
	if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
	const yes = new Set(['yes', 'true', 'checked']);
	const no = new Set(['no', 'false', 'unchecked', '']);
	if (yes.has(a) && yes.has(b)) return true;
	if (no.has(a) && no.has(b)) return true;
	return false;
}

interface Replacement {
	database: string;
	/** The source column this stands in for. */
	column: string;
	/** Computes the value per staged row, keyed by source_record id. */
	compute: (sql: Queryable, importRunId: string) => Promise<Map<string, string>>;
}

/** Counts child tasks, replacing the source's "Number of Subtasks" rollup. */
const subtaskCount: Replacement = {
	database: 'Tasks Database',
	column: 'Number of Subtasks',
	compute: async (sql, importRunId) => {
		const rows = await sql<{ source_record_id: string; n: number }[]>`
			select parent.source_record_id, count(child.id)::int as n
			from tasks parent
			left join tasks child on child.parent_task_id = parent.id
			join source_records sr on sr.id = parent.source_record_id
			where sr.import_run_id = ${importRunId}
			group by parent.source_record_id
		`;
		return new Map(rows.map((r) => [r.source_record_id, String(r.n)]));
	}
};

/** Total tasks on a project, replacing the source's "Total Tasks" rollup. */
const projectTotalTasks: Replacement = {
	database: 'Projects Database',
	column: 'Total Tasks',
	compute: async (sql, importRunId) => {
		const rows = await sql<{ source_record_id: string; n: number }[]>`
			select p.source_record_id, count(t.id)::int as n
			from projects p
			left join tasks t on t.project_id = p.id
			join source_records sr on sr.id = p.source_record_id
			where sr.import_run_id = ${importRunId}
			group by p.source_record_id
		`;
		return new Map(rows.map((r) => [r.source_record_id, String(r.n)]));
	}
};

/** Completed tasks on a project, replacing "Completed Tasks". */
const projectCompletedTasks: Replacement = {
	database: 'Projects Database',
	column: 'Completed Tasks',
	compute: async (sql, importRunId) => {
		const rows = await sql<{ source_record_id: string; n: number }[]>`
			select p.source_record_id, count(t.id) filter (where t.status = 'done')::int as n
			from projects p
			left join tasks t on t.project_id = p.id
			join source_records sr on sr.id = p.source_record_id
			where sr.import_run_id = ${importRunId}
			group by p.source_record_id
		`;
		return new Map(rows.map((r) => [r.source_record_id, String(r.n)]));
	}
};

/** Open tasks pointing directly at an area, replacing "Open Direct Tasks". */
const areaOpenTasks: Replacement = {
	database: 'Areas Database',
	column: 'Open Direct Tasks',
	compute: async (sql, importRunId) => {
		const rows = await sql<{ source_record_id: string; n: number }[]>`
			select a.source_record_id,
			       count(t.id) filter (where t.status not in ('done', 'dropped'))::int as n
			from areas a
			left join tasks t on t.area_id = a.id
			join source_records sr on sr.id = a.source_record_id
			where sr.import_run_id = ${importRunId}
			group by a.source_record_id
		`;
		return new Map(rows.map((r) => [r.source_record_id, String(r.n)]));
	}
};

const REPLACEMENTS: Replacement[] = [
	subtaskCount,
	projectTotalTasks,
	projectCompletedTasks,
	areaOpenTasks
];

/**
 * Compares every replacement against the value the source rendered.
 *
 * Rows whose source value is blank are skipped: Notion leaves a rollup empty
 * when it is zero, and treating that as a disagreement would bury the real
 * differences in noise.
 */
export async function compareDerived(
	sql: Queryable,
	importRunId: string
): Promise<DerivedComparison[]> {
	const staged = await sql<
		{ id: string; database_name: string; title: string | null; raw: Record<string, string> }[]
	>`
		select id, database_name, title, raw
		from source_records where import_run_id = ${importRunId}
	`;

	const results: DerivedComparison[] = [];

	for (const replacement of REPLACEMENTS) {
		const computed = await replacement.compute(sql, importRunId);
		const result: DerivedComparison = {
			database: replacement.database,
			column: replacement.column,
			compared: 0,
			agree: 0,
			differ: 0,
			status: 'matches',
			examples: []
		};

		for (const row of staged) {
			if (row.database_name !== replacement.database) continue;
			const source = (row.raw[replacement.column] ?? '').trim();
			if (!source) continue;

			const value = computed.get(row.id);
			if (value === undefined) continue;

			result.compared++;
			if (sameValue(source, value)) {
				result.agree++;
			} else {
				result.differ++;
				if (result.examples.length < 3) {
					result.examples.push({ title: row.title, source, computed: value });
				}
			}
		}

		if (result.compared > 0) {
			result.status = result.differ === 0 ? 'matches' : 'needs_definition';
			results.push(result);
		}
	}

	return results;
}
