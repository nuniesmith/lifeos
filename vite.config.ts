import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [sveltekit()],
	test: {
		// Integration test files share one database and truncate the same
		// tables between cases. Run one file at a time: in parallel they
		// deadlock and violate each other's foreign keys, which looks exactly
		// like a product bug and is not one. Unit tests are fast enough that
		// serialising them costs nothing.
		fileParallelism: false,
		// Pinned to a zone that is not UTC, and to the household's own, so the
		// date handling is exercised rather than accidentally satisfied. A
		// timestamp bug that shifts a value by the local offset is invisible on
		// a UTC machine — which every CI runner is — and the "(UTC)" marker in
		// the Notion export is exactly that kind of bug.
		env: { TZ: 'America/Toronto' },
		projects: [
			{
				extends: true,
				test: {
					name: 'unit',
					environment: 'node',
					include: ['src/**/*.test.ts', 'tests/unit/**/*.test.ts']
				}
			},
			{
				extends: true,
				test: {
					name: 'integration',
					environment: 'node',
					include: ['tests/integration/**/*.test.ts'],
					// Integration tests talk to a real PostgreSQL; they are
					// slower and must not run in the default `npm test`.
					testTimeout: 30_000
				}
			}
		]
	}
});
