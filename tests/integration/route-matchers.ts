import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The application's real routes, as matchers.
 *
 * Read from disk rather than listed by hand: a hand-written list is a second
 * copy of the route tree and drifts from it silently, which is the exact
 * failure the link checks in search and the archive guard against.
 */
export function routeMatchers(): RegExp[] {
	const root = 'src/routes/(app)';
	const out: RegExp[] = [];
	const walk = (dir: string, prefix: string) => {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			if (!statSync(full).isDirectory()) continue;
			// Route groups like (app) do not appear in the URL.
			const segment = entry.startsWith('(') && entry.endsWith(')') ? '' : `/${entry}`;
			const path = prefix + segment;
			try {
				statSync(join(full, '+page.svelte'));
				// [id] and [date] match one non-slash segment.
				out.push(new RegExp(`^${path.replace(/\[[^\]]+\]/g, '[^/]+')}$`));
			} catch {
				// A directory without a page is just a container.
			}
			walk(full, path);
		}
	};
	walk(root, '');
	return out;
}
