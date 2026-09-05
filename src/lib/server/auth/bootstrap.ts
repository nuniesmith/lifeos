import type { Sql } from 'postgres';
import { env } from '../env';
import { logger } from '../logger';
import { count as countOf, one } from '../db/scalar';
import { generateBootstrapPassword, hashPassword } from './password';

/**
 * First-run bootstrap (AUTH-002).
 *
 * Creates exactly one admin when `users` is empty. Two protections, because
 * either alone is insufficient:
 *
 *  - a transaction-scoped advisory lock, so two application workers starting
 *    at once serialise rather than both seeing an empty table; and
 *  - the `users_single_bootstrap` unique index, which makes a second bootstrap
 *    account impossible even if the lock were somehow bypassed.
 *
 * The lock alone would not survive a second process on another host; the index
 * alone would let one worker fail with a constraint error at startup.
 */

const BOOTSTRAP_LOCK_KEY = 0x1_1fe_0a;

export type BootstrapResult =
	| { status: 'created'; username: string; password: string | null; generated: boolean }
	| { status: 'already_initialised' };

export async function bootstrapIfEmpty(sql: Sql): Promise<BootstrapResult> {
	return sql.begin(async (tx) => {
		// Transaction-scoped: released on commit or rollback, so a crash mid
		// bootstrap cannot leave the lock held.
		await tx`select pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`;

		const existing = countOf(await tx<{ count: number }[]>`select count(*)::int from users`);
		if (existing > 0) return { status: 'already_initialised' } as const;

		const supplied = env.LIFEOS_BOOTSTRAP_PASSWORD;
		const password = supplied ?? generateBootstrapPassword();
		const passwordHash = await hashPassword(password);

		const household = one(
			await tx<{ id: string }[]>`
			insert into households (name, timezone, currency)
			values ('Household', ${env.LIFEOS_TIMEZONE}, ${env.LIFEOS_CURRENCY})
			returning id
		`,
			'household'
		);

		const user = one(
			await tx<{ id: string }[]>`
			insert into users (
				username, display_name, role, password_hash,
				must_change_credentials, is_bootstrap
			)
			values ('admin', 'Administrator', 'admin', ${passwordHash}, true, true)
			returning id
		`,
			'user'
		);

		await tx`
			insert into household_members (household_id, user_id)
			values (${household.id}, ${user.id})
		`;

		// Serialised explicitly and cast, rather than via the driver's json()
		// helper: the helper returns a marker object that the bundled server
		// build failed to recognise, which sent a raw object to the wire and
		// aborted bootstrap at runtime while every test still passed.
		const detail = JSON.stringify({ generated: !supplied });
		await tx`
			insert into auth_audit (event, user_id, detail)
			values ('bootstrap.created', ${user.id}, ${detail}::text::jsonb)
		`;

		return {
			status: 'created',
			username: 'admin',
			// A supplied password is never echoed back; only a generated one is
			// surfaced, and only once.
			password: supplied ? null : password,
			generated: !supplied
		} as const;
	});
}

/**
 * Runs bootstrap and reports it. The generated password is written to the log
 * exactly once and never stored anywhere else — the plan's stated trade-off,
 * since there is no mail path in the initial release.
 */
export async function runBootstrap(sql: Sql): Promise<void> {
	const result = await bootstrapIfEmpty(sql);
	if (result.status === 'already_initialised') return;

	if (result.generated && result.password) {
		// Deliberately not through the structured logger's normal path: this
		// must be readable in `docker logs` and must not be redacted.
		process.stdout.write(
			[
				'',
				'━'.repeat(64),
				'  LifeOS first-run administrator created.',
				`    username: ${result.username}`,
				`    password: ${result.password}`,
				'  Shown once. Sign in now and change both — doing so revokes',
				'  every other session and retires this credential.',
				'━'.repeat(64),
				'',
				''
			].join('\n')
		);
	} else {
		logger.info(
			{ username: result.username },
			'first-run administrator created from LIFEOS_BOOTSTRAP_PASSWORD'
		);
	}
}
