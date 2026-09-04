import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [sveltekit()],
	test: {
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
