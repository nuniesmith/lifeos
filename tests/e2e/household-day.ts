import postgres from 'postgres';

/**
 * Today on the household's own clock, as 'YYYY-MM-DD': what every page shows as
 * "today" (base.ts's `householdToday`), and so the only date a test may use
 * for it.
 *
 * `new Date().toISOString()` and Postgres's `current_date` are both UTC. Between
 * midnight UTC and the household's own midnight (00:00 to 04:00 UTC for
 * Toronto, every evening) they are already tomorrow. A test that seeded or
 * typed them then looked for its record on the wrong day and failed: the food
 * log's shared-entry test did on a CI run at 03:02 UTC on 2026-10-05.
 */
export async function householdToday(databaseUrl: string): Promise<string> {
	const sql = postgres(databaseUrl, { max: 1 });
	try {
		const [row] = await sql<{ today: string }[]>`
			select (now() at time zone timezone)::date::text as today
			from households
			order by created_at
			limit 1
		`;
		if (!row) throw new Error('no household to read the clock of');
		return row.today;
	} finally {
		await sql.end();
	}
}
