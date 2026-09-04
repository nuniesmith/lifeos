import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
export default {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter(),
		// Same-origin only: no cross-site form posts are expected. ORIGIN
		// must still be the exact external HTTPS origin in production or
		// legitimate posts are rejected. See .env.example.
		csrf: { trustedOrigins: [] },
		alias: { $tests: 'tests' }
	}
};
