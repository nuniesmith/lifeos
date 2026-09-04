import { building } from '$app/environment';
import { z } from 'zod';

/**
 * Validated process environment.
 *
 * Throws when production configuration is missing or malformed, so a
 * misconfigured container fails at boot with a readable message instead of
 * serving traffic and failing at the first request.
 *
 * The `building` guard matters: SvelteKit imports server modules during its
 * post-build analysis pass, so without it the *image build* would demand a
 * real ORIGIN and DATABASE_URL. Secrets must not be build inputs — CI builds
 * the image, the server supplies the configuration.
 */

const isProd = process.env.NODE_ENV === 'production' && !building;

const schema = z
	.object({
		NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

		// SvelteKit compares this against the Origin header on form posts. A
		// wrong value in production yields blanket 403s that look like a bug in
		// the app, so it is validated as a real origin with no trailing slash.
		ORIGIN: z
			.string()
			.url()
			.refine((v) => !v.endsWith('/'), { message: 'must not end with "/"' })
			.optional(),

		// Optional in the base shape only so the build-time analysis pass can
		// import server modules without a database URL; required at runtime by
		// the refinement below.
		DATABASE_URL: z.string().url().optional(),

		LIFEOS_BOOTSTRAP_PASSWORD: z.string().min(12).optional(),

		LIFEOS_UPLOAD_DIR: z.string().default('./var/uploads'),
		LIFEOS_IMPORT_DIR: z.string().default('./var/imports'),
		LIFEOS_BACKUP_DIR: z.string().default('./var/backups'),

		LIFEOS_TIMEZONE: z.string().default('America/Toronto'),
		LIFEOS_CURRENCY: z.string().length(3).default('CAD'),

		LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info')
	})
	.refine((e) => building || Boolean(e.DATABASE_URL), {
		message: 'DATABASE_URL is required',
		path: ['DATABASE_URL']
	})
	// ORIGIN is optional in development (Vite supplies it) but required in
	// production, where getting it wrong is silent and confusing.
	.refine((e) => !isProd || Boolean(e.ORIGIN), {
		message: 'ORIGIN is required when NODE_ENV=production',
		path: ['ORIGIN']
	})
	.refine((e) => !isProd || e.ORIGIN?.startsWith('https://'), {
		message: 'ORIGIN must be https:// in production',
		path: ['ORIGIN']
	});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
	const issues = parsed.error.issues
		.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
		.join('\n');
	// Never echo values: this output reaches logs and CI.
	throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === 'production';
