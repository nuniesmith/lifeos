import {
	archivedAt,
	date,
	int,
	linkedPageIds,
	mapper,
	text,
	withBody,
	type Queryable,
	type StagedRow
} from './shared.ts';

/**
 * Habit & Routine Databases -> routines, routine_steps and
 * routine_step_completions (migration 0031), first imported from the
 * 2026-10-14 export.
 *
 * A step needs its routine and a log entry its step at insert time (NOT NULL),
 * so both find them here by the Notion id in the relation cell; promote.ts's
 * IMPORT_ORDER runs Routine, then Routine Steps, then Routine Log.
 */

/** The step's three versions, found by the end of the column name. */
function versionColumn(row: StagedRow, suffix: string): string | null {
	const column = Object.keys(row.raw).find((k) => k.trim().endsWith(suffix));
	return column ? text(row, column) : null;
}

/** "Morning Routine" -> morning; the source has no time-of-day column. */
export function timeOfDay(name: string): string {
	const n = name.toLowerCase();
	if (/\bmorning\b|\bam\b|wake/.test(n)) return 'morning';
	if (/\bbed|night|evening|\bpm\b|wind.?down/.test(n)) return 'evening';
	if (/afternoon|lunch|midday/.test(n)) return 'afternoon';
	return 'anytime';
}

/** "☀️ High Energy" / "🌤️ Average" / "🌱 1%" -> the schema's version. */
export function routineVersion(value: string | null): string {
	const v = (value ?? '').toLowerCase();
	if (v.includes('high')) return 'high';
	if (v.includes('1%') || v.includes('minimal')) return 'minimal';
	return 'average';
}

export const mapRoutine = mapper('routines', async (sql, row, o) => {
	const name = row.title?.trim();
	if (!name) return null;
	const [r] = await sql<{ id: string }[]>`
		insert into routines (household_id, owner_user_id, name, notes, time_of_day, sort_order,
		                      notion_page_id, source_record_id, created_by, archived_at)
		values (${o.householdId}, ${o.ownerUserId}, ${name.slice(0, 200)}, ${withBody(row, null)},
		        ${timeOfDay(name)}, ${int(row, 'Sort Order') ?? 0},
		        ${row.notion_page_id}, ${row.id}, ${o.createdBy}, ${archivedAt(row)}::timestamptz)
		on conflict (notion_page_id) do update set
			name = excluded.name, notes = coalesce(excluded.notes, routines.notes),
			sort_order = coalesce(excluded.sort_order, routines.sort_order),
			source_record_id = excluded.source_record_id
		returning id
	`;
	return r?.id ?? null;
});

async function routineByPage(sql: Queryable, pageIds: string[]): Promise<string | null> {
	if (pageIds.length === 0) return null;
	const [r] = await sql<{ id: string }[]>`
		select id from routines where notion_page_id = any(${pageIds}::uuid[]) limit 1
	`;
	return r?.id ?? null;
}

export const mapRoutineStep = mapper('routine_steps', async (sql, row, o) => {
	const title = row.title?.trim();
	if (!title || !row.notion_page_id) return null;
	const routineId = await routineByPage(sql, linkedPageIds(row, 'Routine'));
	if (!routineId) return null;

	const high = versionColumn(row, 'High Energy Version');
	// The average version is the step itself (NOT NULL); a step written with
	// no versions at all is done the one way its title says.
	const average = versionColumn(row, 'Average Version') ?? title;
	const minimal = versionColumn(row, '1% Version');

	// Positions are unique per routine; a missing or repeated "Sort Order"
	// goes to the end rather than failing the import.
	const wanted = int(row, 'Sort Order');
	const [slot] = await sql<{ position: number }[]>`
		select case
		  when ${wanted}::integer is not null and ${wanted}::integer > 0 and not exists (
		    select 1 from routine_steps
		    where routine_id = ${routineId} and position = ${wanted}::integer
		      and archived_at is null and notion_page_id is distinct from ${row.notion_page_id}
		  ) then ${wanted}::integer
		  else coalesce((select max(position) from routine_steps where routine_id = ${routineId}), 0) + 1
		end as position
	`;

	const [r] = await sql<{ id: string }[]>`
		insert into routine_steps (routine_id, position, title, high_version, average_version,
		                           minimal_version, notion_page_id, created_by, archived_at)
		values (${routineId}, ${slot?.position ?? 1}, ${title.slice(0, 200)}, ${high}, ${average},
		        ${minimal}, ${row.notion_page_id}, ${o.createdBy}, ${archivedAt(row)}::timestamptz)
		on conflict (notion_page_id) do update set
			routine_id = excluded.routine_id, position = excluded.position,
			title = excluded.title, high_version = excluded.high_version,
			average_version = excluded.average_version, minimal_version = excluded.minimal_version
		returning id
	`;
	return r?.id ?? null;
});

/**
 * Routine Log Database -> routine_step_completions.
 *
 * An entry logs either one step ("Step") or a whole routine ("Routine Full");
 * a whole routine done is every one of its live steps done that day, which is
 * how the source's own "Implied Completions" counts it. The table's key is
 * (step, person, day), so a re-run updates the version rather than adding a
 * second completion. Whose log it is comes from the import's --log-as user,
 * as for reads (see reading.ts).
 */
export const mapRoutineLog = mapper('routine_step_completions', async (sql, row, o) => {
	const userId = o.logUserId ?? o.ownerUserId;
	const day = date(row, 'Date');
	if (!userId || !day) return null;

	const stepPages = linkedPageIds(row, 'Step');
	let steps: { id: string }[] = [];
	if (stepPages.length) {
		steps = await sql<{ id: string }[]>`
			select id from routine_steps where notion_page_id = any(${stepPages}::uuid[])
		`;
	} else {
		const routineId = await routineByPage(sql, linkedPageIds(row, 'Routine Full'));
		if (routineId) {
			steps = await sql<{ id: string }[]>`
				select id from routine_steps where routine_id = ${routineId} and archived_at is null
				order by position
			`;
		}
	}
	if (steps.length === 0) return null;

	const version = routineVersion(text(row, 'Version'));
	let first: string | null = null;
	for (const step of steps) {
		const [r] = await sql<{ id: string }[]>`
			insert into routine_step_completions (step_id, user_id, completed_on, version)
			values (${step.id}, ${userId}, ${day}, ${version})
			on conflict (step_id, user_id, completed_on) do update set version = excluded.version
			returning id
		`;
		first ??= r?.id ?? null;
	}
	return first;
});
