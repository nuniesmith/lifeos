import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temporaryDirectories: string[] = [];
afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'lifeos-deploy-test-'));
	temporaryDirectories.push(root);
	const checkout = join(root, 'checkout');
	const state = join(root, 'state');
	const bin = join(root, 'bin');
	for (const directory of [join(checkout, 'scripts'), state, bin]) {
		mkdirSync(directory, { recursive: true });
	}
	copyFileSync('scripts/deploy.sh', join(checkout, 'scripts/deploy.sh'));
	writeFileSync(
		join(state, '.env'),
		'POSTGRES_PASSWORD=preserved\nLIFEOS_IMAGE=ghcr.io/nuniesmith/lifeos:old\n'
	);
	chmodSync(join(state, '.env'), 0o600);
	symlinkSync(join(state, '.env'), join(checkout, '.env'));
	function stub(name: string, body: string) {
		writeFileSync(join(bin, name), `#!/usr/bin/env bash\nset -eu\n${body}\n`, { mode: 0o755 });
	}
	stub('df', 'printf "Available\\n10485760\\n"');
	stub('sleep', 'exit 0');
	stub('curl', '[ "${FAIL_HEALTH:-0}" != 1 ]');
	stub(
		'docker',
		`
	printf '%s|image=%s\\n' "$*" "\${LIFEOS_IMAGE:-}" >> "$TEST_LOG"
case "$*" in
  'pull '*) [ "\${FAIL_PULL:-0}" != 1 ] ;;
  *'pg_dump'*) [ "\${FAIL_BACKUP:-0}" != 1 ]; printf 'PGDMP-test-backup' ;;
  *'ps --format json db') printf '{"Networks":"lifeos_default"}\\n' ;;
esac`
	);
	const env = {
		...process.env,
		PATH: `${bin}:${process.env.PATH}`,
		LIFEOS_IMAGE: 'ghcr.io/nuniesmith/lifeos:new',
		LIFEOS_STATE_DIR: state,
		TEST_LOG: join(root, 'commands')
	};
	const run = (overrides: Record<string, string> = {}) =>
		spawnSync('bash', [join(checkout, 'scripts/deploy.sh')], {
			env: { ...env, ...overrides },
			encoding: 'utf8',
			timeout: 10_000
		});
	return {
		root,
		checkout,
		state,
		bin,
		env,
		stub,
		run,
		log: () => readFileSync(env.TEST_LOG, 'utf8')
	};
}

describe('production deployment shell scripts', () => {
	it('backs up before migration and keeps the persistent env symlink on success', () => {
		const f = fixture();
		const result = f.run();
		expect(result.status, result.stderr + result.stdout).toBe(0);
		expect(lstatSync(join(f.checkout, '.env')).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(f.state, '.env'), 'utf8')).toContain(
			'LIFEOS_IMAGE=ghcr.io/nuniesmith/lifeos:new'
		);
		expect(readFileSync(join(f.state, '.env'), 'utf8')).toContain('POSTGRES_PASSWORD=preserved');
		expect(lstatSync(join(f.state, '.env')).mode & 0o777).toBe(0o600);
		expect(f.log().indexOf('pg_dump')).toBeLessThan(f.log().indexOf('stop app'));
		expect(f.log().indexOf('stop app')).toBeLessThan(f.log().indexOf('run --rm'));
		expect(readdirSync(join(f.state, 'backups'))).toHaveLength(1);
		expect(readFileSync(join(f.state, 'releases/history'), 'utf8')).toContain('lifeos:new');
	});

	it('rolls back both the persistent env and the image exported to Compose', () => {
		const f = fixture();
		const result = f.run({ FAIL_HEALTH: '1' });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('rolled back the application');
		expect(lstatSync(join(f.checkout, '.env')).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(f.state, '.env'), 'utf8')).toContain(
			'LIFEOS_IMAGE=ghcr.io/nuniesmith/lifeos:old'
		);
		const starts = f
			.log()
			.split('\n')
			.filter((line) => line.includes('up -d app nginx'));
		expect(starts).toHaveLength(2);
		expect(starts[0]).toContain('|image=ghcr.io/nuniesmith/lifeos:new');
		expect(starts[1]).toContain('|image=ghcr.io/nuniesmith/lifeos:old');
	});

	it('stops before app shutdown or migration when backup fails', () => {
		const f = fixture();
		const result = f.run({ FAIL_BACKUP: '1' });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('backup failed; not migrating');
		expect(f.log()).not.toContain('stop app');
		expect(f.log()).not.toContain('run --rm');
		expect(readdirSync(join(f.state, 'backups'))).toHaveLength(0);
	});

	it('leaves the running stack alone if the image cannot be pulled', () => {
		const f = fixture();
		const result = f.run({ FAIL_PULL: '1' });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('could not pull');
		expect(f.log()).not.toContain('compose');
		expect(existsSync(join(f.state, 'backups'))).toBe(false);
	});

	it('repairs deploy-user permissions without replacing existing server credentials', () => {
		const f = fixture();
		// Administrative commands are fakes and all paths are in the fixture.
		// Remove only the EUID guard so the sandbox can run as an ordinary user.
		const setup = readFileSync('scripts/setup-server.sh', 'utf8').replace(
			'[[ $EUID -eq 0 ]] || die "run with sudo"',
			':'
		);
		writeFileSync(join(f.checkout, 'scripts/setup-server.sh'), setup);
		f.stub('id', 'if [ "$1" = -gn ]; then printf actions; fi');
		f.stub('usermod', 'printf "usermod %s\\n" "$*" >> "$TEST_LOG"');
		f.stub('chown', 'printf "chown %s\\n" "$*" >> "$TEST_LOG"');
		f.stub('tailscale', 'printf \'{"DNSName":"lifeos.example.ts.net"}\\n\'');
		const before = readFileSync(join(f.state, '.env'), 'utf8');
		const result = spawnSync('bash', [join(f.checkout, 'scripts/setup-server.sh')], {
			env: { ...f.env, LIFEOS_DEPLOY_USER: 'actions' },
			encoding: 'utf8'
		});
		expect(result.status, result.stderr + result.stdout).toBe(0);
		expect(readFileSync(join(f.state, '.env'), 'utf8')).toBe(before);
		expect(f.log()).toContain(`chown actions:actions ${f.state}/.env`);
		expect(f.log()).toContain(
			`chown actions:actions ${f.state} ${f.state}/releases ${f.state}/backups`
		);
		expect(f.log()).toContain('usermod -aG docker actions');
	});
});

describe('deployment secret names', () => {
	const workflow = readFileSync('.github/workflows/deploy.yml', 'utf8');

	// The repository's secrets use the unprefixed names. generate-secrets.sh
	// emits PROD_-prefixed ones. Both must resolve, or a deploy fails at the
	// SSH step with an empty key and no useful message.
	it.each([
		['tailscale address', 'LIFEOS_TAILSCALE_IP', 'PROD_TAILSCALE_IP'],
		['ssh key', 'SSH_KEY', 'PROD_SSH_KEY'],
		['ssh user', 'SSH_USER', 'PROD_SSH_USER'],
		['ssh port', 'SSH_PORT', 'PROD_SSH_PORT']
	])('accepts either spelling for the %s', (_label, plain, prefixed) => {
		expect(workflow).toContain(`secrets.${plain}`);
		expect(workflow).toContain(`secrets.${prefixed}`);
	});

	it('prefers the unprefixed name this repository actually has', () => {
		for (const [plain, prefixed] of [
			['LIFEOS_TAILSCALE_IP', 'PROD_TAILSCALE_IP'],
			['SSH_KEY', 'PROD_SSH_KEY'],
			['SSH_USER', 'PROD_SSH_USER'],
			['SSH_PORT', 'PROD_SSH_PORT']
		]) {
			const line = workflow
				.split('\n')
				.find((l) => l.includes(`secrets.${plain}`) && l.includes(`secrets.${prefixed}`));
			expect(line, `${plain} and ${prefixed} should share a fallback expression`).toBeDefined();
			expect(line!.indexOf(`secrets.${plain}`)).toBeLessThan(line!.indexOf(`secrets.${prefixed}`));
		}
	});

	it('asks for packages: read so GITHUB_TOKEN can pull the private image', () => {
		// Without this the deploy reaches `docker pull` and fails unauthorized.
		expect(workflow).toMatch(/permissions:[\s\S]*?packages: read/);
	});

	it('falls back to the job token when no registry PAT is configured', () => {
		expect(workflow).toContain('secrets.GHCR_READ_TOKEN || github.token');
	});
});
