import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { env } from '../env';

/**
 * The pool is sized for a 1 GB Nanode shared with PostgreSQL and Nginx, not
 * for a large server. See OPS-013 — this is tuned against measured memory,
 * so raise it only with a load test behind the change.
 */
export const sql = postgres(env.DATABASE_URL ?? '', {
	max: 8,
	idle_timeout: 30,
	connect_timeout: 10,
	// Times out a statement rather than letting one query pin a connection.
	// postgres.js passes these through as server settings at connection time.
	// PostgreSQL reads a bare statement_timeout as milliseconds.
	connection: { statement_timeout: 15_000 }
});

export const db = drizzle(sql);
