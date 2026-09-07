import { fail } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import { createTask, listTasks } from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * Brain Dump.
 *
 * In the Notion workspace this is a framing of the inbox rather than a
 * database of its own — "Fragments count. Questions count. Half-formed ideas
 * count. Get it down first." So it writes the same `inbox` tasks the Quick
 * Drop page reads, and adds the one thing that page cannot do: empty a whole
 * head of fragments in a single submission, one per line.
 */

/** A ceiling on one submission, so a pasted document cannot become 4,000 rows. */
const MAX_LINES = 100;

/** Recent captures, shown so the page proves it did something. */
const RECENT = 12;

export const load: PageServerLoad = async ({ locals }) => {
	const viewer = await requireViewer(locals.user);
	const recent = await listTasks(sql, viewer, {
		status: 'inbox',
		order: 'created',
		limit: RECENT
	});
	return { recent };
};

export const actions: Actions = {
	dump: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const lines = String(form.get('thoughts') ?? '')
			.split('\n')
			// A leading bullet is what a person pasting a list will have, and
			// keeping it would put "- " at the front of every task title.
			.map((line) =>
				line
					.trim()
					.replace(/^[-*••]\s*/, '')
					.trim()
			)
			.filter((line) => line.length > 0);

		if (lines.length === 0) {
			return fail(400, { error: 'Nothing to save — write a line or two first.' });
		}
		if (lines.length > MAX_LINES) {
			return fail(400, {
				error: `That is ${lines.length} lines. ${MAX_LINES} at a time is the limit; split it up.`
			});
		}

		// One transaction: a dump either lands whole or not at all, so a failure
		// halfway through cannot leave someone wondering which half saved.
		// The throw is how postgres.js is told to roll back, so it is caught
		// here and turned into a message rather than escaping as a 500.
		const Rollback = class extends Error {
			constructor(readonly why: string) {
				super(why);
			}
		};

		try {
			await sql.begin(async (tx) => {
				for (const title of lines) {
					const result = await createTask(tx, viewer, { title, status: 'inbox' });
					if (!result.ok) {
						throw new Rollback(
							result.reason === 'invalid'
								? (result.message ?? `“${title}” was refused`)
								: 'Not allowed.'
						);
					}
				}
			});
		} catch (err) {
			if (err instanceof Rollback) return fail(400, { error: `Nothing was saved. ${err.why}` });
			throw err;
		}

		return { captured: lines.length };
	}
};
