#!/usr/bin/env node
/**
 * Administrator recovery and post-restore session invalidation (AUTH-006).
 *
 * The documented way out of "the last admin is locked out" and the required
 * step after restoring a database. Hand-editing password hashes is explicitly
 * not the recovery path.
 *
 *   node scripts/recover-admin.mjs --list
 *   node scripts/recover-admin.mjs --reset <username>
 *   node scripts/recover-admin.mjs --promote <username>
 *   node scripts/recover-admin.mjs --invalidate-sessions
 *
 * Every action is recorded in auth_audit. Reuses the application's own hashing
 * so a recovery credential is never weaker than a normal one.
 */
import postgres from 'postgres';
import { generateBootstrapPassword, hashPassword } from '../src/lib/server/auth/password.ts';

const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
	console.error('MIGRATION_DATABASE_URL or DATABASE_URL must be set');
	process.exit(1);
}

const argv = process.argv.slice(2);
const flag = (name) => {
	const i = argv.indexOf(name);
	return i === -1 ? undefined : (argv[i + 1] ?? true);
};

const sql = postgres(url, { max: 1, onnotice: () => {} });

async function audit(event, detail, userId = null) {
	await sql`
		insert into auth_audit (event, user_id, detail)
		values (${event}, ${userId}, ${JSON.stringify(detail)}::jsonb)
	`;
}

async function list() {
	const rows = await sql`
		select username, display_name, role, disabled_at, locked_until, last_login_at,
		       must_change_credentials
		from users order by role, username
	`;
	if (!rows.length) {
		console.log('No users exist. Start the application and it will bootstrap one.');
		return;
	}
	for (const r of rows) {
		const flags = [
			r.disabled_at ? 'disabled' : null,
			r.locked_until && new Date(r.locked_until) > new Date() ? 'locked' : null,
			r.must_change_credentials ? 'must-rotate' : null
		].filter(Boolean);
		console.log(
			`  ${(r.username ?? '(no username)').padEnd(20)} ${r.role.padEnd(7)}` +
				` ${r.display_name}${flags.length ? `  [${flags.join(', ')}]` : ''}`
		);
	}
}

async function reset(username) {
	const [user] = await sql`select id, role from users where username = ${username}`;
	if (!user) {
		console.error(`No user named ${username}. Use --list to see accounts.`);
		process.exitCode = 1;
		return;
	}

	const password = generateBootstrapPassword();
	const hash = await hashPassword(password);

	await sql.begin(async (tx) => {
		await tx`
			update users set
				password_hash = ${hash},
				password_updated_at = now(),
				must_change_credentials = true,
				disabled_at = null,
				failed_login_count = 0,
				locked_until = null
			where id = ${user.id}
		`;
		// A recovery credential is worthless if an attacker's existing session
		// survives it.
		await tx`
			update sessions set revoked_at = now(), revoked_reason = 'admin_recovery'
			where user_id = ${user.id} and revoked_at is null
		`;
		await tx`
			insert into auth_audit (event, user_id, detail)
			values ('recovery.credential_issued', ${user.id}, ${JSON.stringify({ username })}::jsonb)
		`;
	});

	console.log('');
	console.log('━'.repeat(64));
	console.log('  One-time credential issued. It must be changed at first sign-in.');
	console.log(`    username: ${username}`);
	console.log(`    password: ${password}`);
	console.log('  Existing sessions for this account have been revoked.');
	console.log('━'.repeat(64));
	console.log('');
}

async function promote(username) {
	const [user] = await sql`select id, role from users where username = ${username}`;
	if (!user) {
		console.error(`No user named ${username}.`);
		process.exitCode = 1;
		return;
	}
	if (user.role === 'admin') {
		console.log(`${username} is already an admin.`);
		return;
	}
	await sql`update users set role = 'admin' where id = ${user.id}`;
	await audit('recovery.role_changed', { username, from: user.role, to: 'admin' }, user.id);
	console.log(`${username} is now an admin.`);
}

/**
 * Post-restore step. A restored database carries sessions that were valid when
 * the backup was taken; they must not be honoured before access is reopened.
 */
async function invalidateSessions() {
	const rows = await sql`
		update sessions set revoked_at = now(), revoked_reason = 'database_restored'
		where revoked_at is null
		returning id
	`;
	await audit('recovery.sessions_invalidated', { count: rows.length });
	console.log(`Revoked ${rows.length} session(s). Users must sign in again.`);
}

try {
	if (argv.includes('--list')) await list();
	else if (flag('--reset')) await reset(String(flag('--reset')));
	else if (flag('--promote')) await promote(String(flag('--promote')));
	else if (argv.includes('--invalidate-sessions')) await invalidateSessions();
	else {
		console.log('Usage:');
		console.log('  --list                     show accounts and their state');
		console.log('  --reset <username>         issue a one-time credential, revoke sessions');
		console.log('  --promote <username>       grant the admin role');
		console.log('  --invalidate-sessions      revoke every session (run after a restore)');
	}
} catch (err) {
	console.error(err.message);
	process.exitCode = 1;
} finally {
	await sql.end({ timeout: 5 }).catch(() => {});
}
