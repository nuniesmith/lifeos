import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: 'tests/e2e',
	// One worker, deliberately. Every test shares a single PostgreSQL database,
	// so parallel workers interleave: one spec's sign-in can land between
	// another's seed and assertion. That showed up as a ~20% chance of the run
	// reporting 22 tests instead of 23 — a failure inside a serial block takes
	// the rest of the block with it, and a count sliding by one is far easier
	// to miss than a red test. The whole suite runs in about 14 seconds, so
	// serialising it costs nothing worth having.
	fullyParallel: false,
	workers: 1,
	forbidOnly: Boolean(process.env.CI),
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [['html'], ['list']] : 'list',
	use: { baseURL: 'http://127.0.0.1:4173', trace: 'on-first-retry' },
	webServer: {
		// Runs the real adapter-node artifact rather than `vite preview`, so
		// these tests exercise what actually ships. It also avoids a
		// CI-only failure where the preview server did not bind 127.0.0.1.
		command:
			'node tests/e2e/reset-db.mjs && node scripts/migrate.mjs && npm run build && node build/index.js',
		url: 'http://127.0.0.1:4173/api/health/live',
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
		env: {
			PORT: '4173',
			HOST: '127.0.0.1',
			// Exercise the production configuration path, so a regression in
			// env validation shows up here rather than on the server.
			NODE_ENV: 'production',
			ORIGIN: 'http://127.0.0.1:4173',
			// A real database: these tests drive sign-in, which cannot be
			// meaningfully exercised without one. The database-unreachable
			// behaviour is covered by scripts/verify-first-run.sh instead.
			DATABASE_URL:
				process.env.E2E_DATABASE_URL ??
				process.env.DATABASE_URL ??
				'postgresql://lifeos_app:devpassword@127.0.0.1:5433/lifeos_e2e',
			LIFEOS_BOOTSTRAP_PASSWORD: 'e2e-bootstrap-password'
		}
	}
});
