import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// Deployment itself lives in the freddy repo. What it relies on from this
// one is the image: it runs these scripts inside it, so they must be there.
describe('the runtime image ships what the deploy runs inside it', () => {
	const dockerfile = readFileSync('Dockerfile', 'utf8');

	// freddy runs `node scripts/migrate.mjs` in the image before the app
	// restarts, and the data-mobility docs run export and restore there. If
	// the image does not contain them the deploy fails after the database is
	// already up, which is the worst point to discover a packaging mistake.
	it.each(['scripts/migrate.mjs', 'scripts/export-data.mjs', 'scripts/restore-data.mjs'])(
		'includes %s',
		(path) => {
			expect(dockerfile, `Dockerfile must COPY ${path}`).toContain(`/app/${path} ./${path}`);
		}
	);

	it('includes the migrations directory the runner reads', () => {
		// migrate.mjs resolves ../migrations relative to itself.
		expect(dockerfile).toMatch(/COPY[^\n]*\/app\/migrations \.\/migrations/);
	});

	it('still omits the application source and the private export', () => {
		expect(dockerfile).not.toMatch(/COPY[^\n]*\/app\/src /);
		expect(dockerfile).not.toMatch(/COPY[^\n]*\/app\/data /);
	});
});
