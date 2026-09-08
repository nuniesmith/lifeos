import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapIfEmpty } from '$lib/server/auth/bootstrap';
import { one } from '$lib/server/db/scalar';
import { coversForPages, imagesForPage } from '$lib/server/repositories';
import { viewerOf } from '$lib/server/auth/authz';
import type { AuthUser } from '$lib/server/auth/service';

/**
 * Serving an uploaded attachment.
 *
 * The route exists because the media pipeline previously ended nowhere: images
 * were imported, stored, linked, exported and restored, and no route served
 * them. These cases are mostly about who is allowed to see one — an attachment
 * id is a bare uuid in a URL, which is exactly the shape of input that finds a
 * missing authorization predicate.
 */

// The route resolves its upload root once, at module load, from the validated
// environment — and ES imports are hoisted, so setting process.env at the top
// of this file happens after `env` has already parsed. LIFEOS_UPLOAD_DIR is set
// in vite.config.ts instead, before any module loads; this must agree with it.
const uploadDir = resolve(process.env.LIFEOS_UPLOAD_DIR ?? 'var/test-uploads');

import { GET } from '../../src/routes/api/media/[id]/+server';

const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });

const PNG = Buffer.from(
	'89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
		'1f15c4890000000a49444154789c6300010000050001',
	'hex'
);

let householdId: string;
let userId: string;
let attachmentId: string;

async function reset() {
	await sql`truncate households, users restart identity cascade`;
	await sql`delete from auth_audit`;
}

/** The pieces of a RequestEvent this handler actually reads. */
function eventFor(id: string, user: AuthUser | null) {
	const headers: Record<string, string> = {};
	return {
		event: {
			params: { id },
			locals: { user },
			setHeaders: (values: Record<string, string>) => Object.assign(headers, values)
		},
		headers
	};
}

const call = async (id: string, user: AuthUser | null) => {
	const { event, headers } = eventFor(id, user);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const response = await (GET as any)(event);
	return { response, headers };
};

async function storedAttachment(household: string, key: string, bytes = PNG) {
	const target = join(uploadDir, key);
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, bytes);
	const row = one(
		await sql<{ id: string }[]>`
			insert into attachments (household_id, sha256, byte_size, content_type, storage_key, created_by)
			values (${household}::uuid, decode(md5(${key}), 'hex'), ${bytes.length}, 'image/png',
			        ${key}, ${userId}::uuid)
			returning id
		`
	);
	return row.id;
}

beforeAll(async () => {
	await reset();
	await rm(uploadDir, { recursive: true, force: true });
	await mkdir(uploadDir, { recursive: true });
});

beforeEach(async () => {
	await reset();
	await bootstrapIfEmpty(sql);
	householdId = one(await sql<{ id: string }[]>`select id from households limit 1`).id;
	userId = one(await sql<{ id: string }[]>`select id from users limit 1`).id;
	attachmentId = await storedAttachment(householdId, 'ab/cd/abcd.png');
});

afterAll(async () => {
	await reset();
	await sql.end({ timeout: 5 });
	await rm(uploadDir, { recursive: true, force: true });
});

const viewerFor = () =>
	viewerOf(
		{
			id: userId,
			username: 'admin',
			displayName: 'Admin',
			role: 'admin',
			mustChangeCredentials: false,
			isBootstrap: true
		},
		householdId
	);

const viewerUser = (): AuthUser => ({
	id: userId,
	username: 'admin',
	displayName: 'Admin',
	role: 'admin',
	mustChangeCredentials: false,
	isBootstrap: true
});

const statusOf = async (promise: Promise<unknown>) => {
	try {
		await promise;
		return 200;
	} catch (thrown) {
		return (thrown as { status?: number }).status ?? 0;
	}
};

describe('serving an attachment', () => {
	it('returns the stored bytes with the recorded content type', async () => {
		const { response, headers } = await call(attachmentId, viewerUser());
		expect(response.status).toBe(200);
		expect(headers['content-type']).toBe('image/png');
		expect(headers['content-length']).toBe(String(PNG.length));

		const body = Buffer.from(await new Response(response.body).arrayBuffer());
		expect(body.equals(PNG)).toBe(true);
	});

	it('marks the response private and never sniffable', async () => {
		const { headers } = await call(attachmentId, viewerUser());
		// Household-scoped bytes must not sit in a shared cache.
		expect(headers['cache-control']).toContain('private');
		expect(headers['x-content-type-options']).toBe('nosniff');
	});

	it('refuses an unauthenticated request', async () => {
		expect(await statusOf(call(attachmentId, null))).toBe(401);
	});

	it('will not serve another household’s attachment', async () => {
		const other = one(
			await sql<{ id: string }[]>`insert into households (name) values ('Elsewhere') returning id`
		);
		const theirs = await storedAttachment(other.id, 'ef/gh/efgh.png');

		// 404 rather than 403: a 403 confirms the id names a real attachment,
		// which is the one fact an id-enumerating caller is after.
		expect(await statusOf(call(theirs, viewerUser()))).toBe(404);
	});

	it('does not serve a file outside the upload directory', async () => {
		// A storage key reaches the handler from the database, and a database is
		// restorable from a file, so it is not trusted to stay inside the root.
		//
		// The escape has to point at a file that REALLY EXISTS, or the case
		// passes for the wrong reason. The first version of this used
		// `../../../../etc/passwd`, which from the upload root resolves to a
		// path that is not there — so the missing-bytes branch returned the 404
		// and the guard was never executed. Deleting the guard left all seven
		// cases green, which is how that was found.
		const outside = join(uploadDir, '..', 'outside-the-root.png');
		await writeFile(outside, PNG);
		try {
			const escaping = one(
				await sql<{ id: string }[]>`
					insert into attachments (household_id, sha256, byte_size, content_type, storage_key, created_by)
					values (${householdId}::uuid, decode(md5('escape'), 'hex'), ${PNG.length}, 'image/png',
					        '../outside-the-root.png', ${userId}::uuid)
					returning id
				`
			);
			expect(await statusOf(call(escaping.id, viewerUser()))).toBe(404);
		} finally {
			await rm(outside, { force: true });
		}
	});

	it('is a 404, not a 500, when the row exists but the bytes do not', async () => {
		// Exactly what an import that wrote its media to the wrong directory
		// leaves behind: a perfect row with nothing under it.
		const orphan = one(
			await sql<{ id: string }[]>`
				insert into attachments (household_id, sha256, byte_size, content_type, storage_key, created_by)
				values (${householdId}::uuid, decode(md5('orphan'), 'hex'), 10, 'image/png',
				        'zz/zz/missing.png', ${userId}::uuid)
				returning id
			`
		);
		expect(await statusOf(call(orphan.id, viewerUser()))).toBe(404);
	});

	it('will not serve an archived attachment', async () => {
		await sql`update attachments set archived_at = now() where id = ${attachmentId}::uuid`;
		expect(await statusOf(call(attachmentId, viewerUser()))).toBe(404);
	});
});

afterAll(() => vi.restoreAllMocks());

/**
 * Cover images, which arrive from a different Notion export than the data.
 *
 * The scoping here is longer than it looks: a cover reaches a page through
 * attachment -> attachment_links -> source_records -> import_runs, and only the
 * first and last of those carry a household. A join that checks neither would
 * work perfectly on a single-household machine and leak on the day there are
 * two.
 *
 * Mutation testing says something worth writing down: removing EITHER scope
 * alone leaves the case green, because the other still holds. Only removing
 * both fails it. That is redundancy on purpose, not a hole in the test — but it
 * does mean a single mutation cannot show you which line is doing the work
 * here, and neither line should be deleted on the evidence of a green run.
 */
describe('covers for a set of records', () => {
	/** A source record belonging to a household, with a cover attached. */
	async function recordWithCover(household: string, pageId: string, key: string) {
		const run = one(
			await sql<{ id: string }[]>`
				insert into import_runs (household_id, status, dry_run, importer_version)
				values (${household}::uuid, 'succeeded', false, 'test')
				returning id
			`
		);
		const source = one(
			await sql<{ id: string }[]>`
				insert into import_sources (import_run_id, relative_path, kind, sha256, byte_size)
				values (${run.id}::uuid, ${key}, 'csv_all', decode(md5(${key}), 'hex'), 1)
				returning id
			`
		);
		const record = one(
			await sql<{ id: string }[]>`
				insert into source_records (import_run_id, source_id, notion_page_id, database_name,
				                            title, ordinal, raw)
				values (${run.id}::uuid, ${source.id}::uuid, ${pageId}::uuid, 'Areas Database',
				        'An area', 0, '{}'::text::jsonb)
				returning id
			`
		);
		const attachment = await storedAttachment(household, key);
		await sql`
			insert into attachment_links (attachment_id, entity_type, entity_id, role, position)
			values (${attachment}::uuid, 'source_record', ${record.id}::uuid, 'cover', 0)
		`;
		return attachment;
	}

	it('returns the cover keyed by the page id it was asked for', async () => {
		const pageId = '11111111-1111-4111-8111-111111111111';
		const attachment = await recordWithCover(householdId, pageId, 'c1/c1/c1.png');

		const covers = await coversForPages(sql, viewerFor(), [pageId]);
		expect(covers.get(pageId)?.id).toBe(attachment);
	});

	it('never returns another household’s cover', async () => {
		const other = one(
			await sql<{ id: string }[]>`insert into households (name) values ('Elsewhere') returning id`
		);
		const pageId = '22222222-2222-4222-8222-222222222222';
		await recordWithCover(other.id, pageId, 'c2/c2/c2.png');

		// The same page id, asked for by the wrong household.
		expect(await coversForPages(sql, viewerFor(), [pageId])).toEqual(new Map());
	});

	it('asks nothing and returns nothing for an empty list', async () => {
		expect(await coversForPages(sql, viewerFor(), [])).toEqual(new Map());
		expect(await coversForPages(sql, viewerFor(), [null, null])).toEqual(new Map());
	});
});

/**
 * Variants — the smaller copies pages actually serve.
 *
 * Two facts make this worth its own block. The covers in a real workspace run
 * to 11 MB and are drawn as 48-pixel rows, so serving the original is the
 * difference between a page and a hang. And a variant is itself an attachment,
 * so the queries that list a record's pictures have to know not to show it as
 * one.
 */
describe('image variants', () => {
	/** A smaller copy of an attachment, stored the way the scripts store one. */
	async function variantOf(original: string, kind: 'thumb' | 'display', key: string) {
		const bytes = Buffer.concat([PNG, Buffer.from(key)]);
		const target = join(uploadDir, key);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, bytes);
		return one(
			await sql<{ id: string }[]>`
				insert into attachments (household_id, sha256, byte_size, content_type, storage_key,
				                         created_by, variant_of, variant_kind)
				values (${householdId}::uuid, decode(md5(${key}), 'hex'), ${bytes.length}, 'image/webp',
				        ${key}, ${userId}::uuid, ${original}::uuid, ${kind})
				returning id
			`
		).id;
	}

	async function recordWithImage(pageId: string, key: string, role: string) {
		const run = one(
			await sql<{ id: string }[]>`
				insert into import_runs (household_id, status, dry_run, importer_version)
				values (${householdId}::uuid, 'succeeded', false, 'test') returning id
			`
		);
		const source = one(
			await sql<{ id: string }[]>`
				insert into import_sources (import_run_id, relative_path, kind, sha256, byte_size)
				values (${run.id}::uuid, ${key}, 'csv_all', decode(md5(${key}), 'hex'), 1) returning id
			`
		);
		const record = one(
			await sql<{ id: string }[]>`
				insert into source_records (import_run_id, source_id, notion_page_id, database_name,
				                            title, ordinal, raw)
				values (${run.id}::uuid, ${source.id}::uuid, ${pageId}::uuid, 'Daily Log Database',
				        'A day', 0, '{}'::text::jsonb)
				returning id
			`
		);
		const attachment = await storedAttachment(householdId, key);
		await sql`
			insert into attachment_links (attachment_id, entity_type, entity_id, role, position)
			values (${attachment}::uuid, 'source_record', ${record.id}::uuid, ${role}, 0)
		`;
		return { record: record.id, attachment };
	}

	it('serves the thumbnail instead of the cover when one exists', async () => {
		const pageId = '33333333-3333-4333-8333-333333333333';
		const { attachment } = await recordWithImage(pageId, 'v1/v1/v1.png', 'cover');
		const thumb = await variantOf(attachment, 'thumb', 'v1/v1/v1-t.webp');

		const covers = await coversForPages(sql, viewerFor(), [pageId]);
		expect(covers.get(pageId)?.id).toBe(thumb);
	});

	it('falls back to the cover when no thumbnail was made', async () => {
		const pageId = '44444444-4444-4444-8444-444444444444';
		const { attachment } = await recordWithImage(pageId, 'v2/v2/v2.png', 'cover');

		const covers = await coversForPages(sql, viewerFor(), [pageId]);
		expect(covers.get(pageId)?.id).toBe(attachment);
	});

	it('serves the display variant of a body image', async () => {
		const pageId = '55555555-5555-4555-8555-555555555555';
		const { attachment } = await recordWithImage(pageId, 'v3/v3/v3.png', 'body_image');
		const display = await variantOf(attachment, 'display', 'v3/v3/v3-d.webp');

		const images = await imagesForPage(sql, viewerFor(), pageId);
		expect(images.map((i) => i.id)).toEqual([display]);
	});

	it('never lists a variant as a picture of its own', async () => {
		const pageId = '66666666-6666-4666-8666-666666666666';
		const { record, attachment } = await recordWithImage(pageId, 'v4/v4/v4.png', 'body_image');
		const display = await variantOf(attachment, 'display', 'v4/v4/v4-d.webp');

		// The variant is linked as though it were a picture in its own right, and
		// its ORIGINAL is unlinked from this record. That combination is what the
		// guard uniquely catches.
		//
		// Two weaker versions of this case could not fail. With no link at all a
		// variant never reaches the join. With both linked, DISTINCT ON collapses
		// them because the original resolves to the same variant id. Only when
		// the variant stands alone does dropping the guard list it as a picture.
		await sql`
			insert into attachment_links (attachment_id, entity_type, entity_id, role, position)
			values (${display}::uuid, 'source_record', ${record}::uuid, 'body_image', 1)
		`;
		await sql`
			delete from attachment_links
			where attachment_id = ${attachment}::uuid and entity_id = ${record}::uuid
		`;

		expect(await imagesForPage(sql, viewerFor(), pageId)).toEqual([]);
	});

	it('shows an image once even when a record links it twice', async () => {
		// Six records in the real workspace use their page cover again inside the
		// body; without deduplication the journal draws it twice.
		const pageId = '77777777-7777-4777-8777-777777777777';
		const { record, attachment } = await recordWithImage(pageId, 'v5/v5/v5.png', 'cover');
		await sql`
			insert into attachment_links (attachment_id, entity_type, entity_id, role, position)
			values (${attachment}::uuid, 'source_record', ${record}::uuid, 'body_image', 1)
		`;

		expect(await imagesForPage(sql, viewerFor(), pageId)).toHaveLength(1);
	});
});
