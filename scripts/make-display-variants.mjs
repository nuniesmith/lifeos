#!/usr/bin/env node
/**
 * Re-encodes oversized images so pages do not have to carry them.
 *
 *   node scripts/make-display-variants.mjs             # dry run
 *   node scripts/make-display-variants.mjs --commit
 *
 * Every image in this workspace's export is a PNG, because that is what Notion
 * stores when you paste a screenshot or a photograph. Lossless is the wrong
 * format for a photograph: 39 of the 114 body images are over 500 kB and they
 * total 47 MB, with a single 1024x1536 picture costing 3.1 MB. The dimensions
 * are fine — a journal renders these at card width — so nothing needs resizing.
 * The encoding is the problem.
 *
 * This writes a `display` variant: same dimensions, WebP, quality 82. The
 * original is kept and still travels in the bundle, so nothing is lost; the
 * pages simply stop sending a lossless encoding of a photograph over Tailscale
 * to a phone.
 *
 * Companion to scripts/import-covers.mjs, which makes the small `thumb`
 * variants for list rows. Both write attachments that point at their original
 * through `variant_of`, so there is one way to find a smaller copy.
 *
 * Idempotent: a variant is content-addressed and unique per (original, kind),
 * so running it again does nothing.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import postgres from 'postgres';
import sharp from 'sharp';
import { storageKeyFor } from '../src/lib/server/import/media.ts';

const argv = process.argv.slice(2);
const commit = argv.includes('--commit');
const uploadDir = resolve(process.env.LIFEOS_UPLOAD_DIR || 'var/uploads');
const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;

if (!url) {
	console.error('MIGRATION_DATABASE_URL or DATABASE_URL must be set');
	process.exit(1);
}

const sql = postgres(url, { max: 2, onnotice: () => {} });

const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

/**
 * Below this an image is already small enough that a second copy of it costs
 * more than it saves — in the database, in every backup, and in the bundle.
 */
const MIN_BYTES = 200 * 1024;

const mb = (n) => `${(n / 1_048_576).toFixed(1)} MB`;

const main = async () => {
	// Originals only. A variant of a variant is meaningless, and the thumbnails
	// are already small.
	const candidates = await sql`
		select id, household_id, storage_key, byte_size, content_type, width, height, original_name
		from attachments
		where variant_of is null
		  and archived_at is null
		  and content_type like 'image/%'
		  and content_type <> 'image/webp'
		  and byte_size >= ${MIN_BYTES}
		  and not exists (
		      select 1 from attachments v
		      where v.variant_of = attachments.id and v.variant_kind = 'display'
		  )
		order by byte_size desc
	`;

	console.log(
		`\n  ${candidates.length} image(s) over ${Math.round(MIN_BYTES / 1024)} kB without a display variant`
	);
	if (candidates.length === 0) {
		console.log('  Nothing to do.\n');
		await sql.end();
		return;
	}

	let made = 0;
	let failed = 0;
	let missing = 0;
	let before = 0;
	let after = 0;

	await sql
		.begin(async (tx) => {
			for (const image of candidates) {
				let bytes;
				try {
					bytes = await readFile(join(uploadDir, image.storage_key));
				} catch {
					// The row is real but its file is not here — an import that
					// wrote media elsewhere leaves exactly this. Reported rather
					// than treated as a failure of this script.
					missing++;
					continue;
				}

				let encoded;
				try {
					encoded = await sharp(bytes).webp({ quality: 82 }).toBuffer();
				} catch {
					failed++;
					continue;
				}

				// A variant that is not meaningfully smaller is not worth storing:
				// it doubles the row count and the bundle for nothing.
				if (encoded.length >= bytes.length * 0.8) continue;

				const sha = createHash('sha256').update(encoded).digest();
				const key = storageKeyFor(sha, 'webp');
				const inserted = await tx`
					insert into attachments (household_id, sha256, byte_size, content_type,
					                         width, height, original_name, storage_key,
					                         variant_of, variant_kind)
					values (${image.household_id}, ${sha}, ${encoded.length}, 'image/webp',
					        ${image.width}, ${image.height}, ${image.original_name}, ${key},
					        ${image.id}, 'display')
					on conflict (household_id, sha256) do nothing
					returning id
				`;
				if (inserted.length === 0) continue;

				made++;
				before += Number(image.byte_size);
				after += encoded.length;

				if (commit) {
					const target = join(uploadDir, key);
					await mkdir(dirname(target), { recursive: true });
					await writeFile(target, encoded, { flag: 'wx' }).catch((err) => {
						if (err.code !== 'EEXIST') throw err;
					});
				}
			}

			// The transaction is the dry-run mechanism, as everywhere else here:
			// the work really happens and is then thrown away, so the numbers
			// reported are the numbers you would get.
			if (!commit) throw new DryRun();
		})
		.catch((err) => {
			if (!(err instanceof DryRun)) throw err;
		});

	console.log(
		`  ${GREEN}${made}${OFF} variant(s): ${mb(before)} of originals renders as ${mb(after)}` +
			(before > 0 ? ` (${(before / Math.max(after, 1)).toFixed(1)}x smaller)` : '')
	);
	if (missing)
		console.log(`  ${DIM}${missing} row(s) whose file is not in the upload directory${OFF}`);
	if (failed) console.log(`  ${DIM}${failed} image(s) could not be decoded${OFF}`);
	if (!commit) console.log('  Nothing was written. Re-run with --commit to keep it.\n');
	else console.log('');
	await sql.end();
};

class DryRun extends Error {}

await main();
