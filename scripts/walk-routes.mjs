#!/usr/bin/env node
/**
 * Signs in and requests every route the application actually has, against a
 * database holding the real imported workspace.
 *
 *   node scripts/walk-routes.mjs --base http://127.0.0.1:4173 --password <pw>
 *
 * Why this exists: the integration suite proves a search result's path matches
 * a route that exists on disk, and the e2e suite drives a handful of pages
 * against an empty database. Neither answers the question that matters after an
 * import — does every page render the workspace's own content without falling
 * over. Real data is the part that breaks pages: a recipe with no ingredients,
 * a person with no birthday, a title carrying a comma, a rating that arrived as
 * five stars rather than a number.
 *
 * Routes are read from the filesystem rather than listed here, for the same
 * reason the search test does it: a hand-written list is a second copy of the
 * route tree and drifts from it silently.
 *
 * Dynamic segments are filled from the database, so `/tasks/[id]` is requested
 * with an id that exists — and then checked for that record's own title, since
 * a 200 proves the route resolved, not that the page found anything.
 *
 * Nothing is counted as proven that was not actually checked: a route with no
 * row to address is reported as skipped, and a page with no single row to probe
 * for is reported as unprobed. An untested page must not look like a working
 * one.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

const argv = process.argv.slice(2);
const valueOf = (name, fallback) => {
	const index = argv.indexOf(name);
	return index === -1 ? fallback : argv[index + 1];
};

const base = valueOf('--base', 'http://127.0.0.1:4173').replace(/\/$/, '');
const username = valueOf('--username', 'admin');
const password = valueOf('--password', process.env.LIFEOS_BOOTSTRAP_PASSWORD);
const url = process.env.DATABASE_URL;

if (!password) throw new Error('--password (or LIFEOS_BOOTSTRAP_PASSWORD) is required');
if (!url) throw new Error('DATABASE_URL is required to fill dynamic route segments');

const sql = postgres(url, { max: 2, onnotice: () => {} });

/** Every route with a page, as a URL path, read from disk. */
function routes() {
	const root = 'src/routes/(app)';
	const out = [];
	// The group directory's own page is the home route. Checked here because
	// the walk below only ever looks at subdirectories, which silently dropped
	// `/` — the one page every session starts on.
	try {
		statSync(join(root, '+page.svelte'));
		out.push('/');
	} catch {
		// No home page in this group.
	}
	const walk = (dir, prefix) => {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			if (!statSync(full).isDirectory()) continue;
			const segment = entry.startsWith('(') && entry.endsWith(')') ? '' : `/${entry}`;
			const path = prefix + segment;
			try {
				statSync(join(full, '+page.svelte'));
				out.push(path === '' ? '/' : path);
			} catch {
				// A directory without a page is a container.
			}
			walk(full, path);
		}
	};
	walk(root, '');
	return out.sort();
}

/**
 * A string each page must contain, taken from the database.
 *
 * A 200 is a weak assertion: a page that renders its empty state while the
 * table behind it holds 40 rows is broken in the way that matters, and it
 * answers 200 all the same. So each page whose content comes from an
 * identifiable table is asked for a real value from that table and checked
 * against the HTML.
 *
 * Pages that aggregate, summarise or need a query (the dashboard, search,
 * calendar) have no single row to probe for, and are reported as unprobed
 * rather than quietly counted as proven.
 */
async function contentProbes() {
	const pick = async (query) => (await query)[0]?.value ?? null;

	// Two things these queries must get right, both learned the hard way.
	//
	// Ordered by the label, never by created_at. An import runs in one
	// transaction and `now()` is transaction-start time, so all 37 tasks carry
	// the same created_at and `order by created_at limit 1` returns an
	// arbitrary row — a probe that changes between runs is worse than none.
	//
	// Filtered the way the page filters. /tasks and /projects show open work;
	// probing for a `done` row and calling the page empty when it declines to
	// show it reports a working page as broken. Both happened here.
	return {
		'/tasks': await pick(sql`select title as value from tasks
		                          where archived_at is null and status in ('todo', 'in_progress')
		                          order by title limit 1`),
		'/inbox': await pick(sql`select title as value from tasks
		                          where archived_at is null and status = 'inbox'
		                          order by title limit 1`),
		'/areas': await pick(sql`select name as value from areas order by name limit 1`),
		'/goals': await pick(sql`select title as value from goals
		                          where status = 'active' order by title limit 1`),
		'/projects': await pick(sql`select name as value from projects
		                          where status = 'active' order by name limit 1`),
		'/habits': await pick(sql`select name as value from habits order by name limit 1`),
		'/food': await pick(sql`select name as value from recipes order by name limit 1`),
		'/library': await pick(sql`select title as value from library_items order by title limit 1`),
		'/people': await pick(sql`select name as value from people order by name limit 1`),
		'/wishlist': await pick(sql`select name as value from wishlist_items order by name limit 1`),
		'/entertainment': await pick(sql`select name as value from media_items order by name limit 1`),
		'/finance': await pick(sql`select name as value from bills order by name limit 1`),
		'/health': await pick(sql`select name as value from health_vocabulary order by name limit 1`),
		'/topics': await pick(sql`select name as value from tags order by name limit 1`),

		// /library, /reading, /knowledge and /content are four views of one
		// table, split by status. Probing each with its own slice is what
		// distinguishes "the library pack works" from "one of its four pages
		// works and the other three render an empty state".
		'/reading': await pick(sql`select title as value from library_items
		                            where status in ('reading_list', 'archived_read')
		                            order by title limit 1`),
		'/knowledge': await pick(sql`select title as value from library_items
		                              where status = 'live' order by title limit 1`),
		// /content is not a status slice at all: it lists the five most recently
		// touched library items that carry highlights. The `status: 'inbox'`
		// beside it in the loader belongs to a task count, which is what made
		// the first version of this probe report a working page as empty.
		'/content': await pick(sql`select title as value from library_items
		                            where highlight_count > 0
		                            order by last_interaction_at desc nulls last, title asc
		                            limit 1`),

		// The journal lands on the most recent day that was actually written.
		'/journal': await pick(sql`select on_date::text as value from daily_logs
		                            order by on_date desc limit 1`),

		// Due for review, by the same arithmetic the review page uses. This one
		// is worth probing precisely because it can be silently dead: every
		// record can carry a cadence and still nothing ever come due.
		'/review': await pick(sql`select name as value from areas
		                           where review_every_days is not null
		                             and last_reviewed_on + review_every_days <= current_date
		                           order by name limit 1`),

		// /store is an area workspace pinned to whichever area is named for the
		// shop. Probed because the pin is a hardcoded name list: rename the area
		// in Notion and this page goes quietly blank with no error anywhere.
		'/store': await pick(sql`select name as value from areas
		                          where lower(name) similar to '%(etsy|store|shop)%'
		                          order by name limit 1`),

		// Returns null, not undefined, when nothing is archived — so the report
		// says "no rows to probe for" rather than treating the page as one it
		// was never asked to check.
		'/archive': await pick(sql`select title as value from tasks
		                            where archived_at is not null order by title limit 1`)
	};
}

/**
 * Detail pages, probed with the record they were asked for.
 *
 * `/tasks/<id>` returning 200 proves the route resolves; it does not prove the
 * page found the task. Asking for a specific id and requiring that record's own
 * title in the HTML is the difference.
 */
async function detailProbes() {
	const row = async (query) => (await query)[0] ?? null;
	return {
		'/tasks/[id]': await row(
			sql`select id::text, title as label from tasks order by title limit 1`
		),
		'/projects/[id]': await row(
			sql`select id::text, name as label from projects order by name limit 1`
		),
		'/goals/[id]': await row(
			sql`select id::text, title as label from goals order by title limit 1`
		),
		'/areas/[id]': await row(sql`select id::text, name as label from areas order by name limit 1`),
		'/habits/[id]': await row(
			sql`select id::text, name as label from habits order by name limit 1`
		),
		'/library/[id]': await row(
			sql`select id::text, title as label from library_items order by title limit 1`
		),
		'/journal/[date]': await row(sql`select on_date::text as id, on_date::text as label
		                                  from daily_logs order by on_date desc limit 1`)
	};
}

/**
 * HTML-escapes the way Svelte does, so a probe containing an apostrophe or an
 * ampersand — both common in recipe and book titles — is compared against what
 * actually reaches the page rather than failing on the encoding.
 */
const escapeHtml = (value) =>
	value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');

async function signIn() {
	// A freshly bootstrapped account must change its credentials before it can
	// go anywhere, so every route 303s to /account/credentials and the walk
	// reports 37 failures that are really one working feature. That forced
	// change is covered by the e2e suite; here it only masks the pages under
	// test, so it is cleared first. Safe because this script is pointed at a
	// throwaway walk database, never at production.
	const [cleared] = await sql`
		update users set must_change_credentials = false
		where lower(username::text) = lower(${username}) and must_change_credentials
		returning id
	`;
	if (cleared) console.log('  note  cleared the first-run credential change for this walk\n');

	const response = await fetch(`${base}/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
		body: new URLSearchParams({ username, password }),
		redirect: 'manual'
	});
	const cookie = response.headers
		.getSetCookie()
		.map((line) => line.split(';')[0])
		.join('; ');
	if (!cookie) {
		throw new Error(`sign-in returned ${response.status} and set no cookie`);
	}
	return cookie;
}

const main = async () => {
	const cookie = await signIn();
	const details = await detailProbes();
	const probes = await contentProbes();
	const results = { ok: [], skipped: [], failed: [], unprobed: [], empty: [] };

	// /search needs a term, and the term should be one the workspace contains,
	// so the page is asked to find something that is really there.
	const searchable = (await sql`select title as value from tasks order by title limit 1`)[0]?.value;
	const searchTerm = searchable?.split(/\s+/).find((word) => word.length > 4);

	for (const route of routes()) {
		let path = route;
		let expected = probes[route];

		if (route.includes('[')) {
			const detail = details[route];
			if (!detail) {
				results.skipped.push([route, 'no row exists to address it']);
				continue;
			}
			path = route.replace(/\[[^\]]+\]/, encodeURIComponent(detail.id));
			expected = detail.label;
		} else if (route === '/search' && searchTerm) {
			path = `/search?q=${encodeURIComponent(searchTerm)}`;
			expected = searchTerm;
		}

		let response;
		try {
			response = await fetch(`${base}${path}`, { headers: { cookie }, redirect: 'manual' });
		} catch (error) {
			results.failed.push([path, `request failed: ${error.message}`]);
			continue;
		}

		if (response.status >= 500) {
			// The body carries SvelteKit's error message, which is the useful part.
			const body = await response.text();
			const detail = body
				.match(/<h1[^>]*>([^<]+)|"message":"([^"]+)/)
				?.slice(1)
				.find(Boolean);
			results.failed.push([path, `${response.status}${detail ? `: ${detail}` : ''}`]);
		} else if (response.status >= 400) {
			results.failed.push([path, String(response.status)]);
		} else if (response.status >= 300) {
			results.failed.push([path, `${response.status} -> ${response.headers.get('location')}`]);
		} else {
			results.ok.push(path);
			// Does the page actually show its own content, or just answer 200?
			const probe = expected;
			if (probe === undefined) {
				results.unprobed.push(route);
			} else if (probe === null) {
				results.unprobed.push(`${route} (no rows to probe for)`);
			} else {
				const html = await response.text();
				if (!html.includes(probe) && !html.includes(escapeHtml(probe))) {
					results.empty.push([path, `does not show ${JSON.stringify(probe)}`]);
				}
			}
		}
	}

	for (const [route, why] of results.skipped) console.log(`  skip  ${route.padEnd(24)} ${why}`);
	for (const [path, why] of results.failed) console.log(`  FAIL  ${path.padEnd(24)} ${why}`);
	for (const [path, why] of results.empty) console.log(`  EMPTY ${path.padEnd(24)} ${why}`);
	if (results.unprobed.length > 0) {
		console.log(`\n  not content-checked: ${results.unprobed.join(', ')}`);
	}
	console.log(
		`\n  ${results.ok.length} rendered, ${results.ok.length - results.empty.length - results.unprobed.length} showing their data, ` +
			`${results.empty.length} rendering empty, ${results.skipped.length} skipped, ${results.failed.length} failed`
	);
	await sql.end();
	if (results.failed.length > 0 || results.empty.length > 0) process.exitCode = 1;
};

await main();
