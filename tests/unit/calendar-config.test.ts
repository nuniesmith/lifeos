import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// env.ts validates process.env when it is first imported, so the scheduler is
// given a stand-in it can read instead, and a fresh copy of the module per
// test, since it keeps a usable configuration once it has one.
const { env, warn } = vi.hoisted(() => ({
	env: {} as Record<string, string | undefined>,
	warn: vi.fn()
}));
vi.mock('$lib/server/env', () => ({ env }));
vi.mock('$lib/server/logger', () => ({ logger: { warn, info: vi.fn(), error: vi.fn() } }));

const loadSyncDeps = async () => (await import('$lib/server/calendar-sync/scheduler')).syncDeps;

const EMAIL = 'lifeos@test.iam.gserviceaccount.com';
// GoogleClient reads the key only when it signs in, so any string will do here
const serviceAccount = () =>
	JSON.stringify({ client_email: EMAIL, private_key: randomBytes(16).toString('hex') });

let dir: string;
let file: string;

beforeEach(async () => {
	vi.resetModules();
	dir = await mkdtemp(join(tmpdir(), 'lifeos-calendar-config-'));
	file = join(dir, 'google-calendar.json');
	for (const key of Object.keys(env)) delete env[key];
	Object.assign(env, { LIFEOS_TIMEZONE: 'America/Toronto', LIFEOS_CURRENCY: 'CAD' });
	warn.mockClear();
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe('syncDeps: the server settings calendar sync reads', () => {
	it('with nothing set, Google and iCloud are off and nothing is wrong', async () => {
		const config = await (await loadSyncDeps())();
		expect(config).toMatchObject({ google: null, secretKey: null, problems: {} });
		expect(warn).not.toHaveBeenCalled();
	});

	it('reports a key file that is not there yet, then picks it up without a restart', async () => {
		env.LIFEOS_GOOGLE_SA_FILE = file;
		const syncDeps = await loadSyncDeps();

		const before = await syncDeps();
		expect(before.google).toBeNull();
		expect(before.problems).toEqual({ LIFEOS_GOOGLE_SA_FILE: `there is no file at ${file}` });

		await writeFile(file, serviceAccount());
		const after = await syncDeps();
		expect(after.google?.serviceAccountEmail).toBe(EMAIL);
		expect(after.problems).toEqual({});
		// usable now, so it is kept
		expect(await syncDeps()).toBe(after);
	});

	it.each([
		['a directory', () => mkdir(file), () => `${file} is a directory, not the key file`],
		['not JSON', () => writeFile(file, 'not json'), () => `${file} isn't JSON`],
		[
			'not a service account key',
			() => writeFile(file, JSON.stringify({ type: 'authorized_user' })),
			() => `${file} is not a service account key (no client_email / private_key)`
		]
	])('says why a key file that is %s cannot be used', async (_what, make, expected) => {
		await make();
		env.LIFEOS_GOOGLE_SA_FILE = file;
		const config = await (await loadSyncDeps())();
		expect(config.google).toBeNull();
		expect(config.problems.LIFEOS_GOOGLE_SA_FILE).toBe(expected());
	});

	// root reads any file, so there is nothing to refuse
	it.skipIf(process.getuid?.() === 0)(
		'names the uid when the app may not read the key file',
		async () => {
			await writeFile(file, serviceAccount());
			await chmod(file, 0o000);
			env.LIFEOS_GOOGLE_SA_FILE = file;
			const config = await (await loadSyncDeps())();
			expect(config.problems.LIFEOS_GOOGLE_SA_FILE).toBe(
				`the app (uid ${process.getuid?.()}) isn't allowed to read ${file}`
			);
		}
	);

	it('reports a LIFEOS_SECRET_KEY of the wrong length and still sets up Google', async () => {
		await writeFile(file, serviceAccount());
		env.LIFEOS_GOOGLE_SA_FILE = file;
		env.LIFEOS_SECRET_KEY = randomBytes(16).toString('base64');
		const config = await (await loadSyncDeps())();
		expect(config.secretKey).toBeNull();
		expect(config.problems.LIFEOS_SECRET_KEY).toContain('must be 32 bytes');
		expect(config.google?.serviceAccountEmail).toBe(EMAIL);
	});

	it('keeps a usable key', async () => {
		env.LIFEOS_SECRET_KEY = randomBytes(32).toString('base64');
		const syncDeps = await loadSyncDeps();
		const config = await syncDeps();
		expect(config.secretKey).toHaveLength(32);
		expect(config.problems).toEqual({});
		expect(await syncDeps()).toBe(config);
	});

	it('logs a problem once, not on every read', async () => {
		env.LIFEOS_GOOGLE_SA_FILE = file;
		const syncDeps = await loadSyncDeps();
		await syncDeps();
		await syncDeps();
		await syncDeps();
		expect(warn).toHaveBeenCalledTimes(1);
	});
});
