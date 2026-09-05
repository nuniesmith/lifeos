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
