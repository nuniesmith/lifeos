import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: 'tests/e2e',
	fullyParallel: true,
	forbidOnly: Boolean(process.env.CI),
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [['html'], ['list']] : 'list',
	use: { baseURL: 'http://127.0.0.1:4173', trace: 'on-first-retry' },
	webServer: {
		// Runs the real adapter-node artifact rather than `vite preview`, so
		// these tests exercise what actually ships. It also avoids a
		// CI-only failure where the preview server did not bind 127.0.0.1.
		command: 'npm run build && node build/index.js',
		url: 'http://127.0.0.1:4173/api/health/live',
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
		env: {
			PORT: '4173',
			HOST: '127.0.0.1',
			// Exercise the production configuration path, so a regression in
			// env validation shows up here rather than on the server.
			NODE_ENV: 'production',
			ORIGIN: 'https://lifeos.test',
			// Intentionally unreachable: the smoke tests assert that liveness
			// still answers 200 and readiness correctly reports 503.
			DATABASE_URL: 'postgresql://nobody:nobody@127.0.0.1:59999/nodb'
		}
	}
});
