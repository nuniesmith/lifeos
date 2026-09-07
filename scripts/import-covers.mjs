#!/usr/bin/env node
/**
 * Adds Notion page covers, which the Markdown & CSV export does not carry.
 *
 *   node scripts/import-covers.mjs --html data/html            # dry run
 *   node scripts/import-covers.mjs --html data/html --commit
 *
 * Notion offers several export formats and they do not contain the same
 * things. The Markdown & CSV export is the one the importer reads, because it
 * is the only one with the `_all.csv` tables that make the data structured —
 * but it drops page covers. The HTML export keeps them, as
 * `<img class="page-cover-image">`, and names each page's file with the same
 * 32-hex id the CSV relations use. That id is the join.
 *
 * A separate pass rather than an option on the importer: this reads a DIFFERENT
 * export of the same workspace, and folding a second root into the import's
 * contract would make the main path harder to reason about for something that
 * is enrichment. Run it after an import, as often as you like — it is keyed on
 * content and on the page id, so a second run changes nothing.
 *
 * Covers attach to the `source_records` row, the same place body images go,
 * with role 'cover' to tell them apart.
 *
 * Each cover also gets a THUMBNAIL, stored as its own attachment with role
 * 'cover_thumb'. This is not an optimisation, it is the difference between the
 * feature working and not: the covers in this workspace have a median size of
 * 1.2 MB and run to 11 MB, and the pages that show them draw 48-pixel list rows
 * and a 6rem tile band. Serving the originals made /entertainment ship 21 MB to
 * render seven thumbnails, which over Tailscale to a phone is no feature at all.
 *
 * Resizing happens HERE, once, on whatever machine holds the export — never on
 * the Raspberry Pi, which has 894 MB of RAM and should only ever hand over
 * bytes that already exist.
 */
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import postgres from 'postgres';
import {
	imageDimensions,
	sniffContentType,
	storageKeyFor
} from '../src/lib/server/import/media.ts';
import { notionIdToUuid } from '../src/lib/server/import/csv.ts';

const argv = process.argv.slice(2);
const valueOf = (name, fallback) => {
	const i = argv.indexOf(name);
	return i === -1 ? fallback : argv[i + 1];
};

const htmlRoot = resolve(valueOf('--html', 'data/html'));
const uploadDir = resolve(process.env.LIFEOS_UPLOAD_DIR || 'var/uploads');
const commit = argv.includes('--commit');
const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;

if (!url) {
	console.error('MIGRATION_DATABASE_URL or DATABASE_URL must be set');
	process.exit(1);
}

const sql = postgres(url, { max: 2, onnotice: () => {} });

const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

/** The 32-hex Notion id, unanchored matches excluded. */
const NOTION_ID = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/;
const COVER = /<img class="page-cover-image" src="([^"]+)"/;

/**
 * Longest side of a generated thumbnail.
 *
 * 320 covers every place a cover is currently drawn — a 48-pixel list row and a
 * 6rem tile band — at twice the size, so it still looks right on a high-density
 * phone screen without carrying a megabyte to do it.
 */
const THUMB_PX = 320;

async function* htmlFiles(dir) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) yield* htmlFiles(full);
		else if (entry.name.endsWith('.html')) yield full;
	}
}

const main = async () => {
	const [household] = await sql`select id, name from households order by created_at limit 1`;
	if (!household) {
		console.error('No household exists yet. Import first.');
		process.exit(1);
	}

	// Only pages that became something the application can SHOW.
	//
	// Every row in the export becomes a source record, including the dashboards
	// and month buckets the importer deliberately does not promote. Their covers
	// are real images and would store and link perfectly — 20 of them — and no
	// page would ever display one. Storing an image nothing can show is weight
	// in the database, in every backup, and in the portable bundle that gets
	// copied to the server.
	//
	// "Promoted" is asked of the schema rather than listed here: any table
	// carrying `source_record_id` is a domain table, so this stays right as
	// tables are added.
	const promotedTables = (
		await sql`
			select table_name from information_schema.columns
			where table_schema = 'public' and column_name = 'source_record_id'
			order by table_name
		`
	).map((row) => row.table_name);

	const promoted = new Set();
	for (const table of promotedTables) {
		for (const row of await sql`
			select distinct source_record_id::text as id from ${sql(table)}
			where source_record_id is not null and household_id = ${household.id}
		`) {
			promoted.add(row.id);
		}
	}

	const records = new Map(
		(
			await sql`
				select r.id, r.notion_page_id::text as page_id, r.database_name
				from source_records r
				join import_runs ir on ir.id = r.import_run_id
				where ir.household_id = ${household.id}
			`
		)
			.filter((row) => promoted.has(row.id))
			.map((row) => [row.page_id, row])
	);

	let pages = 0;
	let skippedNoRecord = 0;
	let missingFile = 0;
	const byDatabase = new Map();
	const work = [];

	for await (const file of htmlFiles(htmlRoot)) {
		const id = NOTION_ID.exec(file.split('/').pop() ?? '');
		if (!id) continue;
		const text = await readFile(file, 'utf8');
		const cover = COVER.exec(text);
		if (!cover) continue;
		pages++;

		const src = decodeURIComponent(cover[1]);
		// An external cover is a Notion stock image on their CDN; there is no
		// file to store and fetching one is not this script's business.
		if (/^https?:/i.test(src)) continue;

		const record = records.get(notionIdToUuid(id[0]));
		if (!record) {
			// Either no row claimed the page, or the row was never promoted to
			// a table any page reads.
			skippedNoRecord++;
			continue;
		}

		let bytes;
		try {
			bytes = await readFile(join(dirname(file), src));
		} catch {
			missingFile++;
			continue;
		}

		work.push({ record, bytes, name: src.split('/').pop() ?? 'cover' });
		byDatabase.set(record.database_name, (byDatabase.get(record.database_name) ?? 0) + 1);
	}

	console.log(`\n  ${pages} page(s) in the HTML export carry a cover image`);
	console.log(`  ${work.length} of them belong to a record this workspace imported`);
	if (skippedNoRecord) {
		console.log(
			`  ${DIM}${skippedNoRecord} on pages nothing displays (dashboards, month buckets, unclaimed)${OFF}`
		);
	}
	if (missingFile)
		console.log(`  ${DIM}${missingFile} whose image file is not in the export${OFF}`);
	for (const [db, n] of [...byDatabase].sort((a, b) => b[1] - a[1])) {
		console.log(`     ${String(n).padStart(4)}  ${db}`);
	}

	let stored = 0;
	let linked = 0;
	let already = 0;
	let thumbsMade = 0;
	let thumbFailed = 0;
	let thumbBytesTotal = 0;
	let originalBytesTotal = 0;

	await sql
		.begin(async (tx) => {
			for (const item of work) {
				const { contentType, extension } = sniffContentType(item.bytes);
				if (!contentType.startsWith('image/')) continue;
				const dimensions = imageDimensions(item.bytes, contentType);
				const sha256 = createHash('sha256').update(item.bytes).digest();
				const storageKey = storageKeyFor(sha256, extension);

				const inserted = await tx`
				insert into attachments (household_id, sha256, byte_size, content_type,
				                         width, height, original_name, storage_key)
				values (${household.id}, ${sha256}, ${item.bytes.length}, ${contentType},
				        ${dimensions?.width ?? null}, ${dimensions?.height ?? null},
				        ${item.name}, ${storageKey})
				on conflict (household_id, sha256) do nothing
				returning id
			`;
				if (inserted.length > 0) stored++;

				const attachmentId =
					inserted[0]?.id ??
					(
						await tx`
						select id from attachments
						where household_id = ${household.id} and sha256 = ${sha256}
					`
					)[0]?.id;
				if (!attachmentId) continue;

				// A cover is one per page, so position is 0 and a re-run is a no-op.
				const link = await tx`
				insert into attachment_links (attachment_id, entity_type, entity_id, role, position)
				values (${attachmentId}, 'source_record', ${item.record.id}, 'cover', 0)
				on conflict do nothing
				returning attachment_id
			`;
				if (link.length > 0) linked++;
				else already++;

				// ─── the thumbnail the pages actually show ────────────────────
				let thumbBytes;
				try {
					thumbBytes = await sharp(item.bytes)
						.rotate() // honour EXIF orientation before resizing
						.resize(THUMB_PX, THUMB_PX, { fit: 'inside', withoutEnlargement: true })
						.webp({ quality: 72 })
						.toBuffer();
				} catch {
					// A cover that cannot be decoded is still stored and linked;
					// it simply goes without a thumbnail, and coversForPages
					// falls back to the original.
					thumbFailed++;
					continue;
				}

				const thumbSha = createHash('sha256').update(thumbBytes).digest();
				const thumbKey = storageKeyFor(thumbSha, 'webp');
				const thumbInserted = await tx`
				insert into attachments (household_id, sha256, byte_size, content_type,
				                         width, height, original_name, storage_key)
				values (${household.id}, ${thumbSha}, ${thumbBytes.length}, 'image/webp',
				        ${Math.min(dimensions?.width ?? THUMB_PX, THUMB_PX)},
				        ${Math.min(dimensions?.height ?? THUMB_PX, THUMB_PX)},
				        ${item.name}, ${thumbKey})
				on conflict (household_id, sha256) do nothing
				returning id
			`;
				if (thumbInserted.length > 0) thumbsMade++;

				const thumbId =
					thumbInserted[0]?.id ??
					(
						await tx`
					select id from attachments
					where household_id = ${household.id} and sha256 = ${thumbSha}
				`
					)[0]?.id;
				if (thumbId) {
					await tx`
					insert into attachment_links (attachment_id, entity_type, entity_id, role, position)
					values (${thumbId}, 'source_record', ${item.record.id}, 'cover_thumb', 0)
					on conflict do nothing
				`;
					thumbBytesTotal += thumbBytes.length;
					originalBytesTotal += item.bytes.length;
				}

				if (commit && thumbInserted.length > 0) {
					const target = join(uploadDir, thumbKey);
					await mkdir(dirname(target), { recursive: true });
					await writeFile(target, thumbBytes, { flag: 'wx' }).catch((err) => {
						if (err.code !== 'EEXIST') throw err;
					});
				}

				if (commit && inserted.length > 0) {
					const destination = join(uploadDir, storageKey);
					await mkdir(dirname(destination), { recursive: true });
					await writeFile(destination, item.bytes, { flag: 'wx' }).catch((err) => {
						// Content addressing means an identical file may already be
						// there, which is the expected outcome, not a failure.
						if (err.code !== 'EEXIST') throw err;
					});
				}
			}

			if (!commit) {
				// The transaction is the dry-run mechanism: everything above really
				// happened, and is then thrown away, so the numbers are real.
				throw new DryRun();
			}
		})
		.catch((err) => {
			if (!(err instanceof DryRun)) throw err;
		});

	console.log(
		`\n  ${GREEN}${stored}${OFF} new image(s), ${GREEN}${linked}${OFF} cover link(s)` +
			(already ? `, ${already} already linked` : '')
	);
	if (thumbsMade || thumbBytesTotal) {
		const mb = (n) => `${(n / 1_048_576).toFixed(1)} MB`;
		console.log(
			`  ${GREEN}${thumbsMade}${OFF} thumbnail(s): ${mb(originalBytesTotal)} of covers ` +
				`renders as ${mb(thumbBytesTotal)}` +
				(thumbFailed ? `; ${thumbFailed} could not be resized` : '')
		);
	}
	if (!commit) console.log('  Nothing was written. Re-run with --commit to keep it.\n');
	else console.log('');
	await sql.end();
};

class DryRun extends Error {}

await main();
