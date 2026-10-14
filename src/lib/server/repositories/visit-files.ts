import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Viewer } from '../auth/authz';
import { imageDimensions, sniffContentType, storageKeyFor } from '../import/media';
import {
	isUuid,
	readableScope,
	toText,
	toTextOrNull,
	writableScope,
	type Queryable,
	type WriteResult
} from './base';

/**
 * Files on a medical visit (PACK3-002): a referral, a receipt, a photo of a
 * prescription.
 *
 * Stored the way the import stores its media — in `attachments`, content
 * addressed and immutable, deduplicated per household by SHA-256, with the
 * type read from the bytes and never from the name — and linked to the visit
 * in `attachment_links` as `medical_visit`. Export and restore already carry
 * both tables.
 *
 * A file is the visit's: listing needs the visit readable, adding or removing
 * needs it writable, and /api/media serves a visit's file only to someone who
 * can read a visit it is on. When no link is left the attachment is archived,
 * so it stops being served at once; `purge_after` marks it for the delayed
 * physical deletion the table was designed for.
 */

export const VISIT_ENTITY = 'medical_visit';

/** Largest file accepted. Phone photos of a page are a few MB. */
export const MAX_VISIT_FILE_BYTES = 20 * 1024 * 1024;

/** What can be attached: documents and photos, nothing a browser would run. */
const ACCEPTED = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export interface VisitFile {
	id: string;
	name: string;
	contentType: string;
	byteSize: number;
	addedAt: Date;
}

export async function listVisitFiles(
	sql: Queryable,
	viewer: Viewer,
	visitId: string
): Promise<VisitFile[]> {
	if (!isUuid(visitId)) return [];
	const rows = await sql<
		{
			id: string;
			original_name: string | null;
			content_type: string;
			byte_size: string;
			created_at: Date;
		}[]
	>`
		select a.id, a.original_name, a.content_type, a.byte_size, l.created_at
		from attachment_links l
		join attachments a on a.id = l.attachment_id and a.archived_at is null
		join medical_visits v on v.id = l.entity_id
		where l.entity_type = ${VISIT_ENTITY} and l.entity_id = ${visitId}::uuid
		  and ${readableScope(sql, viewer, 'v')}
		order by l.position asc, l.created_at asc
	`;
	return rows.map((row) => ({
		id: row.id,
		name: toTextOrNull(row.original_name) ?? 'File',
		contentType: toText(row.content_type),
		byteSize: Number(row.byte_size),
		addedAt: row.created_at
	}));
}

export interface ServableAttachment {
	storageKey: string;
	contentType: string;
	originalName: string | null;
}

/**
 * An attachment the viewer may fetch, or null — the same null for "no such
 * file", "another household's" and "on a visit you cannot read", so an id
 * cannot be probed.
 *
 * Household-scoped, as every attachment is. A file on a medical visit is the
 * visit's and needs a readable visit it is on; the same bytes linked anywhere
 * else too (a household deduplicates by hash) keep that link's reach, so a
 * file is never hidden where it was already visible.
 */
export async function servableAttachment(
	sql: Queryable,
	viewer: Viewer,
	attachmentId: string
): Promise<ServableAttachment | null> {
	if (!isUuid(attachmentId)) return null;
	const [row] = await sql<
		{ storage_key: string; content_type: string; original_name: string | null }[]
	>`
		select a.storage_key, a.content_type, a.original_name
		from attachments a
		where a.id = ${attachmentId}::uuid
		  and a.household_id = ${viewer.householdId}::uuid
		  and a.archived_at is null
		  and (
		    not exists (
		      select 1 from attachment_links l
		      where l.attachment_id = a.id and l.entity_type = ${VISIT_ENTITY}
		    )
		    or exists (
		      select 1 from attachment_links l
		      where l.attachment_id = a.id and l.entity_type <> ${VISIT_ENTITY}
		    )
		    or exists (
		      select 1 from attachment_links l
		      join medical_visits v on v.id = l.entity_id
		      where l.attachment_id = a.id and l.entity_type = ${VISIT_ENTITY}
		        and ${readableScope(sql, viewer, 'v')}
		    )
		  )
	`;
	return row
		? {
				storageKey: row.storage_key,
				contentType: row.content_type,
				originalName: toTextOrNull(row.original_name)
			}
		: null;
}

/** A display name: the browser's file name, without any path, trimmed. */
function cleanName(name: string): string | null {
	const base = name.split(/[\\/]/).pop()?.trim() ?? '';
	return base ? base.slice(0, 200) : null;
}

/**
 * Stores `bytes` under `uploadRoot` and links them to the visit.
 *
 * The bytes are written before the row, to a temporary name and then renamed
 * into place, so a crash leaves either nothing or a whole file — never a row
 * pointing at half of one. A file already stored (the same bytes uploaded
 * before, here or elsewhere in the household) is not written again.
 */
export async function attachVisitFile(
	sql: Queryable,
	viewer: Viewer,
	visitId: string,
	file: { bytes: Buffer; name: string },
	uploadRoot: string
): Promise<WriteResult<VisitFile>> {
	if (!isUuid(visitId)) return { ok: false, reason: 'not_found' };

	const [visit] = await sql<{ id: string }[]>`
		select v.id from medical_visits v
		where v.id = ${visitId}::uuid and ${writableScope(sql, viewer, 'v')}
	`;
	if (!visit) return { ok: false, reason: 'not_found' };

	if (file.bytes.length === 0)
		return { ok: false, reason: 'invalid', message: 'That file is empty.' };
	if (file.bytes.length > MAX_VISIT_FILE_BYTES) {
		return { ok: false, reason: 'invalid', message: 'That file is over 20 MB.' };
	}
	const { contentType, extension } = sniffContentType(file.bytes);
	if (!ACCEPTED.has(contentType)) {
		return {
			ok: false,
			reason: 'invalid',
			message: 'Attach a PDF or a photo (JPEG, PNG, WebP or GIF).'
		};
	}

	const sha256 = createHash('sha256').update(file.bytes).digest();
	const storageKey = storageKeyFor(sha256, extension);
	const target = join(uploadRoot, storageKey);
	const present = await stat(target).then(
		(info) => info.isFile() && info.size === file.bytes.length,
		() => false
	);
	if (!present) {
		await mkdir(dirname(target), { recursive: true });
		const temporary = `${target}.${randomBytes(6).toString('hex')}.partial`;
		try {
			await writeFile(temporary, file.bytes, { mode: 0o640 });
			await rename(temporary, target);
		} catch (err) {
			await rm(temporary, { force: true });
			throw err;
		}
	}

	const dimensions = imageDimensions(file.bytes, contentType);
	const name = cleanName(file.name);
	const [attachment] = await sql<{ id: string; original_name: string | null }[]>`
		insert into attachments
			(household_id, sha256, byte_size, content_type, width, height, original_name,
			 storage_key, created_by)
		values (${viewer.householdId}::uuid, ${sha256}, ${file.bytes.length}, ${contentType},
		        ${dimensions?.width ?? null}, ${dimensions?.height ?? null}, ${name},
		        ${storageKey}, ${viewer.userId}::uuid)
		on conflict (household_id, sha256) do update
			-- The same bytes again: bring an archived copy back rather than
			-- refuse, and keep the name it was first stored under.
			set archived_at = null, purge_after = null
		returning id, original_name
	`;
	const [link] = await sql<{ created_at: Date }[]>`
		insert into attachment_links (attachment_id, entity_type, entity_id, position)
		values (${attachment!.id}::uuid, ${VISIT_ENTITY}, ${visitId}::uuid,
		        (select coalesce(max(position) + 1, 0) from attachment_links
		         where entity_type = ${VISIT_ENTITY} and entity_id = ${visitId}::uuid))
		on conflict do nothing
		returning created_at
	`;

	return {
		ok: true,
		record: {
			id: attachment!.id,
			name: toTextOrNull(attachment!.original_name) ?? name ?? 'File',
			contentType,
			byteSize: file.bytes.length,
			addedAt: link?.created_at ?? new Date()
		}
	};
}

/** Takes a file off a visit; archives it once nothing links to it. */
export async function detachVisitFile(
	sql: Queryable,
	viewer: Viewer,
	visitId: string,
	attachmentId: string
): Promise<WriteResult<{ attachmentId: string }>> {
	if (!isUuid(visitId) || !isUuid(attachmentId)) return { ok: false, reason: 'not_found' };

	const removed = await sql<{ attachment_id: string }[]>`
		delete from attachment_links l
		using medical_visits v
		where l.entity_type = ${VISIT_ENTITY} and l.entity_id = v.id
		  and v.id = ${visitId}::uuid and ${writableScope(sql, viewer, 'v')}
		  and l.attachment_id = ${attachmentId}::uuid
		returning l.attachment_id
	`;
	if (!removed[0]) return { ok: false, reason: 'not_found' };

	await sql`
		update attachments set archived_at = now(), purge_after = now() + interval '30 days'
		where id = ${attachmentId}::uuid and household_id = ${viewer.householdId}::uuid
		  and not exists (select 1 from attachment_links where attachment_id = ${attachmentId}::uuid)
	`;
	return { ok: true, record: { attachmentId } };
}
