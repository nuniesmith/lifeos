import { json } from '@sveltejs/kit';

/**
 * Liveness. Deliberately touches nothing external: this answers only "is the
 * process able to serve a request". If it checked the database, a transient
 * database fault would be escalated into a container restart loop, which is
 * strictly worse than serving errors while the database recovers.
 */
export const GET = () => json({ status: 'ok' });
