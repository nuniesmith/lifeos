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

/**
 * An origin is acceptable in production when it is HTTPS, or when it is plain
 * HTTP on a loopback address. The loopback case is legitimate rather than a
 * loophole: LifeOS terminates TLS at Tailscale Serve and proxies to Nginx on
 * 127.0.0.1, and the end-to-end suite drives the built server the same way.
 * A non-loopback http:// origin is still refused.
 */
function isSecureOrigin(origin: string): boolean {
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return false;
	}
	if (url.protocol === 'https:') return true;
	if (url.protocol !== 'http:') return false;
	return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
}

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
		// Optional and deliberately without defaults: nothing in the running
		// application reads either path. Imports are a CLI step
		// (scripts/import.mjs, which has its own default root) and backups are
		// written on the host by scripts/backup.sh. The old `./var/...` defaults
		// only made ensureStorage try to create them inside the production
		// image, where /app is root-owned, and log EACCES on every start.
		LIFEOS_IMPORT_DIR: z.string().optional(),
		LIFEOS_BACKUP_DIR: z.string().optional(),

		LIFEOS_TIMEZONE: z.string().default('America/Toronto'),
		LIFEOS_CURRENCY: z.string().length(3).default('CAD'),
		// Weather is opt-in because coordinates are sensitive configuration and
		// cannot be inferred safely from a timezone.
		LIFEOS_WEATHER_LATITUDE: z.preprocess(
			(value) => (value === undefined || value === '' ? undefined : Number(value)),
			z.number().min(-90).max(90).optional()
		),
		LIFEOS_WEATHER_LONGITUDE: z.preprocess(
			(value) => (value === undefined || value === '' ? undefined : Number(value)),
			z.number().min(-180).max(180).optional()
		),
		LIFEOS_WEATHER_LABEL: z.string().min(1).max(120).default('Local forecast'),
		LIFEOS_WEATHER_UNITS: z.enum(['metric', 'imperial']).default('metric'),

		LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info')
	})
	.refine(
		(e) => (e.LIFEOS_WEATHER_LATITUDE === undefined) === (e.LIFEOS_WEATHER_LONGITUDE === undefined),
		{
			message: 'latitude and longitude must be configured together',
			path: ['LIFEOS_WEATHER_LATITUDE']
		}
	)
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
	.refine((e) => !isProd || !e.ORIGIN || isSecureOrigin(e.ORIGIN), {
		message: 'ORIGIN must be https://, or http:// on a loopback address',
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
