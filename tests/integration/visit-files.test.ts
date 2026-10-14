import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { createMember } from '$lib/server/auth/admin';
import { viewerOf, type Viewer } from '$lib/server/auth/authz';
import { one } from '$lib/server/db/scalar';
import {
	MAX_VISIT_FILE_BYTES,
	attachVisitFile,
	detachVisitFile,
	listVisitFiles,
	servableAttachment
} from '$lib/server/repositories';

/**
 * Files on a medical visit (PACK3-002).
 *
 * Stored content-addressed under the upload directory and linked to the
 * visit; refused unless they are a PDF or a photo by their bytes; added and
 * removed only by someone who may edit the visit; and served by /api/media
 * (through servableAttachment) only to someone who can read a visit they are
 * on — while an imported image, linked to no visit, stays servable as before.
 *
 * Every name here is invented.
 */

const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });

const PDF = Buffer.from('%PDF-1.4\n% fictional referral\n1 0 obj << >> endobj\n%%EOF\n');
const PNG = Buffer.concat([
	Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
	Buffer.from([0, 0, 0, 3, 0, 0, 0, 2]),
	Buffer.alloc(16)
]);

let owner: Viewer;
let partner: Viewer;
let householdId: string;
let uploads: string;

async function reset() {
	await sql`truncate households, users restart identity cascade`;
	await sql`delete from auth_audit`;
}

beforeEach(async () => {
	uploads = mkdtempSync(join(tmpdir(), 'lifeos-visit-files-'));
	await reset();
	await bootstrapIfEmpty(sql);
	householdId = one(await sql<{ id: string }[]>`select id from households limit 1`).id;
	const admin = one(await sql<{ id: string }[]>`select id from users limit 1`);
	owner = viewerOf(
		{
			id: admin.id,
			username: 'admin',
			displayName: 'Admin',
			role: 'admin',
			mustChangeCredentials: false,
			isBootstrap: true
		},
		householdId
	);
	const created = await createMember(sql, admin.id, householdId, {
		username: 'partner',
		displayName: 'Partner',
		role: 'member'
	});
	if (!created.ok) throw new Error('could not create the member');
	partner = viewerOf(
		{
			id: created.userId,
			username: 'partner',
			displayName: 'Partner',
			role: 'member',
			mustChangeCredentials: false,
			isBootstrap: false
		},
		householdId
	);
});

afterEach(() => rmSync(uploads, { recursive: true, force: true }));

afterAll(async () => {
	await reset();
	await sql.end({ timeout: 5 });
});

async function visit(reason: string, privateTo?: string) {
	return one(
		await sql<{ id: string }[]>`
			insert into medical_visits (household_id, visibility, owner_user_id, reason, visit_at)
			values (${householdId}::uuid, ${privateTo ? 'private' : 'household'},
			        ${privateTo ?? null}::uuid, ${reason}, '2031-03-12T15:00:00Z')
			returning id
		`
	).id;
}

const attach = (viewer: Viewer, visitId: string, bytes: Buffer, name = 'referral.pdf') =>
	attachVisitFile(sql, viewer, visitId, { bytes, name }, uploads);

describe('files on a visit', () => {
	it('stores a PDF by its hash, lists it, and stores the same bytes only once', async () => {
		const physio = await visit('Fictional physio');
		const dentist = await visit('Fictional dentist');

		const first = await attach(owner, physio, PDF, 'C:\\scans\\referral.pdf');
		expect(first).toMatchObject({
			ok: true,
			record: { name: 'referral.pdf', contentType: 'application/pdf', byteSize: PDF.length }
		});
		const again = await attach(owner, dentist, PDF, 'copy.pdf');
		expect(again.ok && first.ok && again.record.id).toBe(first.ok && first.record.id);

		const [row] = await sql<{ storage_key: string; count: number }[]>`
			select storage_key, (select count(*)::int from attachments) as count from attachments
		`;
		expect(row!.count).toBe(1);
		expect(readFileSync(join(uploads, row!.storage_key)).equals(PDF)).toBe(true);
		expect(row!.storage_key).toMatch(/^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.pdf$/);

		expect((await listVisitFiles(sql, owner, physio)).map((f) => f.name)).toEqual(['referral.pdf']);
		expect(await listVisitFiles(sql, owner, dentist)).toHaveLength(1);
	});

	it('reads the type from the bytes, and refuses anything but a PDF or a photo', async () => {
		const physio = await visit('Fictional physio');

		const png = await attach(owner, physio, PNG, 'photo.pdf');
		expect(png).toMatchObject({ ok: true, record: { contentType: 'image/png' } });
		const [dims] = await sql<{ width: number; height: number }[]>`
			select width, height from attachments where content_type = 'image/png'
		`;
		expect(dims).toEqual({ width: 3, height: 2 });

		for (const bytes of [
			Buffer.from('<svg onload="alert(1)"/>'),
			Buffer.from('just some text'),
			Buffer.alloc(0)
		]) {
			expect(await attach(owner, physio, bytes, 'note.pdf')).toMatchObject({
				ok: false,
				reason: 'invalid'
			});
		}
		const tooBig = Buffer.concat([PDF, Buffer.alloc(MAX_VISIT_FILE_BYTES)]);
		expect(await attach(owner, physio, tooBig)).toMatchObject({ ok: false, reason: 'invalid' });
		expect(await listVisitFiles(sql, owner, physio)).toHaveLength(1);
	});

	it('keeps a private visit’s files to its owner, in every direction', async () => {
		const secret = await visit('Fictional private visit', owner.userId);

		expect(await attach(partner, secret, PDF)).toMatchObject({ ok: false, reason: 'not_found' });
		const added = await attach(owner, secret, PDF);
		if (!added.ok) throw new Error('could not attach');

		expect(await listVisitFiles(sql, partner, secret)).toEqual([]);
		expect(await servableAttachment(sql, partner, added.record.id)).toBeNull();
		expect(await servableAttachment(sql, owner, added.record.id)).toMatchObject({
			contentType: 'application/pdf',
			originalName: 'referral.pdf'
		});
		expect(await detachVisitFile(sql, partner, secret, added.record.id)).toMatchObject({
			ok: false,
			reason: 'not_found'
		});

		// The same bytes on a shared visit too: that link's reach applies.
		await attach(owner, await visit('Fictional shared visit'), PDF);
		expect(await servableAttachment(sql, partner, added.record.id)).not.toBeNull();
	});

	it('stops serving a file once it is on no visit, and brings it back if added again', async () => {
		const physio = await visit('Fictional physio');
		const added = await attach(owner, physio, PDF);
		if (!added.ok) throw new Error('could not attach');

		expect(await detachVisitFile(sql, owner, physio, added.record.id)).toMatchObject({ ok: true });
		expect(await listVisitFiles(sql, owner, physio)).toEqual([]);
		expect(await servableAttachment(sql, owner, added.record.id)).toBeNull();
		const [archived] = await sql<{ purge: boolean }[]>`
			select purge_after > now() as purge from attachments where id = ${added.record.id}::uuid
		`;
		expect(archived!.purge).toBe(true);

		const back = await attach(owner, physio, PDF);
		expect(back.ok && back.record.id).toBe(added.record.id);
		expect(await servableAttachment(sql, owner, added.record.id)).not.toBeNull();
	});

	it('leaves an imported image, on no visit, servable as before', async () => {
		const [image] = await sql<{ id: string }[]>`
			insert into attachments (household_id, sha256, byte_size, content_type, storage_key)
			values (${householdId}::uuid, ${Buffer.alloc(32, 7)}, 10, 'image/png', 'aa/bb/fictional.png')
			returning id
		`;
		expect(await servableAttachment(sql, partner, image!.id)).toMatchObject({
			contentType: 'image/png'
		});
		expect(await servableAttachment(sql, partner, 'not-a-uuid')).toBeNull();
		expect(existsSync(join(uploads, 'aa'))).toBe(false);
	});
});
