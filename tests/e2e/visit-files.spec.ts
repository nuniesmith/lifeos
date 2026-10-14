import { expect, test, type Page } from '@playwright/test';
import postgres, { type Sql } from 'postgres';
import { hashPassword } from '../../src/lib/server/auth/password';

/**
 * Attaching a file to a medical visit (PACK3-002), on a phone: upload a PDF,
 * download it again under its own name, have a text file refused, remove it.
 *
 * Seeds an account and a private visit of its own, made again before each
 * test so a retry starts from a visit with no files.
 */

// Mirrors the resolution order in playwright.config.ts.
const DATABASE_URL =
	process.env.E2E_DATABASE_URL ??
	process.env.DATABASE_URL ??
	'postgresql://lifeos_app:devpassword@127.0.0.1:5433/lifeos_e2e';

const USER = { username: 'e2e-visit-files', displayName: 'Visit Files', role: 'member' };
const PASSWORD = 'visit-files-spec-password-2026';
const PHONE = { width: 375, height: 812 };
const REASON = 'Fictional referral visit';
const PDF = Buffer.from('%PDF-1.4\n% fictional referral\n1 0 obj << >> endobj\n%%EOF\n');

async function query<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
	const sql = postgres(DATABASE_URL, { max: 1 });
	try {
		return await fn(sql);
	} finally {
		await sql.end();
	}
}

let visitId: string;

test.beforeEach(async () => {
	visitId = await query(async (sql) => {
		const passwordHash = await hashPassword(PASSWORD);
		const existing = await sql<
			{ id: string }[]
		>`select id from households order by created_at limit 1`;
		const householdId =
			existing[0]?.id ??
			(
				await sql<{ id: string }[]>`
					insert into households (name) values ('Household') returning id
				`
			)[0]!.id;
		const [user] = await sql<{ id: string }[]>`
			insert into users (username, display_name, role, password_hash, must_change_credentials)
			values (${USER.username}, ${USER.displayName}, ${USER.role}, ${passwordHash}, false)
			on conflict (username) where username is not null do update set
				password_hash = excluded.password_hash,
				must_change_credentials = false,
				disabled_at = null,
				failed_login_count = 0,
				locked_until = null
			returning id
		`;
		await sql`
			insert into household_members (household_id, user_id)
			values (${householdId}, ${user!.id}) on conflict do nothing
		`;
		// A household symptom word, as other specs leave behind: the visit page
		// then has the symptom picker's own "Attach" button as well.
		await sql`
			insert into health_vocabulary (household_id, kind, name)
			select ${householdId}, 'symptom', 'Fictional ache'
			where not exists (
				select 1 from health_vocabulary
				where household_id = ${householdId} and kind = 'symptom' and name = 'Fictional ache'
			)
		`;
		await sql`delete from medical_visits where owner_user_id = ${user!.id}`;
		const [visit] = await sql<{ id: string }[]>`
			insert into medical_visits (household_id, owner_user_id, visibility, reason, visit_at)
			values (${householdId}, ${user!.id}, 'private', ${REASON}, '2025-06-02T14:00:00Z')
			returning id
		`;
		return visit!.id;
	});
});

async function signIn(page: Page) {
	await page.goto('/login');
	await page.getByLabel('Username').fill(USER.username);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');
}

test.use({ viewport: PHONE });

test('attaches a PDF to a visit, downloads it, and removes it', async ({ page }) => {
	await signIn(page);
	await page.goto(`/health/visits/${visitId}`);
	await expect(page.getByText('No files yet.')).toBeVisible();

	// Named like a PDF, but text: refused by its bytes, with the reason.
	await page.getByLabel('Attach a file').setInputFiles({
		name: 'notes.pdf',
		mimeType: 'application/pdf',
		buffer: Buffer.from('not really a pdf')
	});
	await page.getByRole('button', { name: 'Attach file' }).click();
	await expect(page.getByRole('alert')).toHaveText(
		'Attach a PDF or a photo (JPEG, PNG, WebP or GIF).'
	);

	await page.getByLabel('Attach a file').setInputFiles({
		name: 'referral.pdf',
		mimeType: 'application/pdf',
		buffer: PDF
	});
	await page.getByRole('button', { name: 'Attach file' }).click();
	const files = page.getByRole('list', { name: 'Files on this visit' });
	await expect(files.getByRole('link', { name: 'referral.pdf' })).toBeVisible();

	// A PDF downloads under its own name rather than opening inline.
	const download = page.waitForEvent('download');
	await files.getByRole('link', { name: 'referral.pdf' }).click();
	expect((await download).suggestedFilename()).toBe('referral.pdf');

	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		)
	).toBeLessThanOrEqual(0);

	await files.getByRole('button', { name: 'Remove referral.pdf' }).click();
	await expect(page.getByText('No files yet.')).toBeVisible();
});
