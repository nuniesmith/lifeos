import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { one } from '../db/scalar.ts';
import { notionIdToUuid, parseCsvTable, parseRelationCell } from './csv.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { imageDimensions, isPlausibleImage, sniffContentType, storageKeyFor } from './media.ts';
import { parseMarkdownPage } from './markdown.ts';
import { promote, type PromoteSummary } from './promote.ts';
import { hashFile, inventory, readText, type SourceFile } from './source.ts';

/**
 * Two-pass staged import (IMP-005).
 *
 * Pass one records every canonical row verbatim into `source_records`; pass
 * two resolves relation cells into `source_links` once every target exists.
 * A single pass cannot work: relations routinely point forward to rows in
 * databases that have not been read yet.
 *
 * Nothing here writes to a domain table. Staging first means the whole export
 * can be examined, counted, and diffed before anything is promoted, and a
 * dry run is simply a transaction that is rolled back.
 */

export const IMPORTER_VERSION = '1.0.0';

export interface ImportOptions {
	root: string;
	householdId: string;
	/** When set, staged rows are promoted into domain tables in the same pass. */
	ownerUserId?: string | null;
	promote?: boolean;
	/** Where deduplicated media is written. Nothing is written on a dry run. */
	uploadDir?: string;
	startedBy?: string | null;
	dryRun?: boolean;
	appCommit?: string | null;
}

export interface ImportSummary {
	importRunId: string;
	dryRun: boolean;
	files: number;
	databases: number;
	rows: number;
	links: number;
	unresolvedLinks: number;
	mediaFiles: number;
	uniqueMedia: number;
	/** Media rows created this run, after deduplication. */
	mediaStored: number;
	mediaRejected: number;
	/** Body image references linked to a stored attachment. */
	imageLinks: number;
	pageIds: number;
	/** Rows that carry body content from their page file. */
	rowsWithBody: number;
	/** Page files present in the export, whether or not a row matched one. */
	pageFiles: number;
	/** Rows with no title; a page file cannot exist for these. */
	untitledRows: number;
	issues: { severity: string; code: string; message: string }[];
	/** Present when promotion ran. */
	promoted?: PromoteSummary;
}

/** Derives the database name from an `_all.csv` filename. */
export function databaseNameFromPath(relativePath: string): string {
	const base = relativePath.split('/').pop() ?? relativePath;
	return base
		.replace(/_all\.csv$/i, '')
		.replace(/\s+[0-9a-f]{32}$/i, '')
		.trim();
}

export async function runImport(sql: Sql, options: ImportOptions): Promise<ImportSummary> {
	const dryRun = options.dryRun ?? true;
	const inv = await inventory(options.root);

	const issues: ImportSummary['issues'] = [];
	const note = (severity: 'info' | 'warning' | 'error', code: string, message: string) =>
		issues.push({ severity, code, message });

	if (inv.duplicatePaths.length) {
		note(
			'warning',
			'duplicate_source_path',
			`${inv.duplicatePaths.length} path(s) appear more than once`
		);
	}

	// The transaction is the dry-run mechanism: on a dry run it is rolled back
	// after all the same work has happened, so the report reflects a real
	// import rather than a simulation of one.
	const summary = await sql
		.begin(async (tx) => {
			const run = one(
				await tx<{ id: string }[]>`
					insert into import_runs (household_id, dry_run, status, importer_version,
					                         app_commit, started_by)
					values (${options.householdId}, ${dryRun}, ${dryRun ? 'dry_run' : 'running'},
					        ${IMPORTER_VERSION}, ${options.appCommit ?? null},
					        ${options.startedBy ?? null})
					returning id
				`,
				'import run'
			);

			// ─── record every source file with its hash ──────────────────────
			const sourceIdByPath = new Map<string, string>();
			const mediaHashes = new Set<string>();

			for (const file of inv.files) {
				const hashed = await hashFile(file);
				if (file.kind === 'media') mediaHashes.add(hashed.sha256.toString('hex'));

				const row = one(
					await tx<{ id: string }[]>`
						insert into import_sources (import_run_id, relative_path, kind, sha256,
						                            byte_size, notion_id)
						values (${run.id}, ${file.relativePath}, ${file.kind}, ${hashed.sha256},
						        ${file.byteSize},
						        ${file.notionId ? notionIdToUuid(file.notionId) : null})
						returning id
					`,
					'import source'
				);
				sourceIdByPath.set(file.relativePath, row.id);
			}

			// ─── media: content-addressed and deduplicated ───────────────────
			// Keyed on the hash, so the 525 files collapse to the distinct ones
			// with no comparison beyond SHA-256. `on conflict do nothing` makes
			// a re-import a no-op rather than a duplicate.
			let mediaStored = 0;
			let mediaRejected = 0;
			// Relative path -> attachment id, so a body's image reference can be
			// resolved to the row that was actually stored for it.
			const attachmentByPath = new Map<string, string>();
			const attachmentBySha = new Map<string, string>();
			const uploadDir = options.uploadDir ?? 'var/uploads';

			for (const file of inv.files) {
				if (file.kind !== 'media') continue;

				const bytes = await readFile(file.absolutePath);
				const { contentType, extension } = sniffContentType(bytes);
				const dimensions = imageDimensions(bytes, contentType);

				if (!isPlausibleImage(dimensions)) {
					mediaRejected++;
					note(
						'warning',
						'implausible_image',
						`${file.relativePath} reports impossible dimensions and was not stored`
					);
					continue;
				}

				const sha256 = createHash('sha256').update(bytes).digest();
				const storageKey = storageKeyFor(sha256, extension);

				const inserted = await tx<{ id: string }[]>`
					insert into attachments (household_id, sha256, byte_size, content_type,
					                         width, height, original_name, storage_key,
					                         created_by)
					values (${options.householdId}, ${sha256}, ${file.byteSize}, ${contentType},
					        ${dimensions?.width ?? null}, ${dimensions?.height ?? null},
					        ${file.relativePath.split('/').pop() ?? null}, ${storageKey},
					        ${options.startedBy ?? null})
					on conflict (household_id, sha256) do nothing
					returning id
				`;

				const shaHex = sha256.toString('hex');
				if (inserted.length > 0) {
					mediaStored++;
					attachmentBySha.set(shaHex, inserted[0]!.id);
				}

				// A deduplicated file still needs its path mapped, otherwise the
				// second reference to identical bytes would resolve to nothing.
				const attachmentId =
					attachmentBySha.get(shaHex) ??
					(
						await tx<{ id: string }[]>`
							select id from attachments
							where household_id = ${options.householdId} and sha256 = ${sha256}
						`
					)[0]?.id;
				if (attachmentId) {
					attachmentBySha.set(shaHex, attachmentId);
					attachmentByPath.set(file.relativePath, attachmentId);
				}

				if (inserted.length > 0) {
					// Written only for a real import: a dry run must leave the
					// filesystem untouched, since a rollback cannot undo a write.
					if (!dryRun) {
						const destination = join(uploadDir, storageKey);
						await mkdir(dirname(destination), { recursive: true });
						await writeFile(destination, bytes, { flag: 'wx' }).catch((err: unknown) => {
							// EEXIST means the identical content is already there,
							// which is the expected outcome of content addressing.
							if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
						});
					}
				}
			}

			// ─── pass one: canonical rows ────────────────────────────────────
			const canonical = inv.files.filter((f) => f.kind === 'csv_all');
			const pageIndex = buildPageIndex(inv.files);
			const markdownById = new Map(
				inv.files.filter((f) => f.kind === 'markdown' && f.notionId).map((f) => [f.notionId!, f])
			);
			let disambiguated = 0;
			const recordIdByNotionId = new Map<string, string>();
			let rowCount = 0;
			let rowsWithoutPageId = 0;
			let untitledRows = 0;
			let rowsWithBody = 0;

			// Cells are kept for pass two so each file is parsed exactly once.
			const pendingRelations: { recordId: string; property: string; value: string }[] = [];
			const pendingImages: { recordId: string; pageDir: string; images: string[] }[] = [];

			for (const file of canonical) {
				const table = parseCsvTable(await readText(file));
				const databaseName = databaseNameFromPath(file.relativePath);
				const titleColumn = table.headers[0] ?? '';
				const sourceId = sourceIdByPath.get(file.relativePath)!;
				const pageTitles = pageIndex.get(pageDirectoryFor(file.relativePath));
				// Which page files this database's rows have already claimed.
				const claimed = new Map<string, Set<string>>();

				if (!table.headers.length) {
					note('error', 'empty_database', `${file.relativePath} has no header row`);
					continue;
				}

				let ordinal = 0;
				for (const record of table.rows) {
					const title = (record[titleColumn] ?? '').trim();

					let pageId: string | null = null;
					for (const key of titleKeys(title)) {
						const candidates = pageTitles?.get(key) ?? [];
						const taken = claimed.get(key) ?? new Set<string>();
						const free = candidates.filter((id) => !taken.has(id));
						if (free.length === 0) continue;

						if (free.length === 1) {
							pageId = free[0]!;
						} else {
							// Duplicate title: pick the page whose properties agree
							// best with this row rather than trusting listing order.
							let best = free[0]!;
							let bestScore = -1;
							for (const candidate of free) {
								const md = markdownById.get(candidate);
								if (!md) continue;
								const page = parseMarkdownPage(await readText(md), table.headers);
								const score = propertyAgreement(record, page.properties);
								if (score > bestScore) {
									bestScore = score;
									best = candidate;
								}
							}
							pageId = best;
							disambiguated++;
						}

						taken.add(pageId);
						claimed.set(key, taken);
						break;
					}
					// An untitled row cannot have a page file: Notion names those
					// files after the title. Counted separately so it is not
					// mistaken for a matching failure.
					if (!pageId) {
						if (title) rowsWithoutPageId++;
						else untitledRows++;
					}

					// The page file is the only source of body content. Parsed
					// here so promotion reads one staged row rather than going
					// back to the filesystem.
					let body: string | null = null;
					let pageProperties: Record<string, string> = {};
					let bodyImages: string[] = [];
					if (pageId) {
						const pageFile = markdownById.get(pageId);
						if (pageFile) {
							const page = parseMarkdownPage(await readText(pageFile), table.headers);
							body = page.body || null;
							pageProperties = page.properties;
							bodyImages = page.images;
						}
					}

					const inserted = one(
						await tx<{ id: string }[]>`
							insert into source_records (import_run_id, source_id, notion_page_id,
							                            database_name, title, ordinal, raw,
							                            body, page_properties, body_images)
							values (${run.id}, ${sourceId},
							        ${pageId ? notionIdToUuid(pageId) : null},
							        ${databaseName}, ${title || null}, ${ordinal},
							        ${JSON.stringify(record)}::text::jsonb,
							        ${body}, ${JSON.stringify(pageProperties)}::text::jsonb,
							        ${bodyImages})
							returning id
						`,
						'source record'
					);

					if (body) rowsWithBody++;
					if (bodyImages.length && pageId) {
						const pageFile = markdownById.get(pageId);
						if (pageFile) {
							// Image paths in a page body are relative to the page's
							// own directory, not to the export root.
							const pageDir = pageFile.relativePath.split('/').slice(0, -1).join('/');
							pendingImages.push({ recordId: inserted.id, pageDir, images: bodyImages });
						}
					}
					if (pageId) recordIdByNotionId.set(pageId, inserted.id);

					for (const [property, value] of Object.entries(record)) {
						if (value.includes('(')) {
							pendingRelations.push({ recordId: inserted.id, property, value });
						}
					}

					ordinal++;
					rowCount++;
				}
			}

			// ─── body images become attachment links ─────────────────────────
			let imageLinks = 0;
			let unresolvedImages = 0;

			for (const pending of pendingImages) {
				let position = 0;
				for (const image of pending.images) {
					// Try the page-relative path first, then the export-root path:
					// Notion writes both forms depending on where the asset lives.
					const candidates = [
						`${pending.pageDir}/${image}`,
						image,
						`${pending.pageDir}/${image}`.replace(/\/\.\//g, '/')
					];
					const attachmentId = candidates
						.map((c) => attachmentByPath.get(c))
						.find((id): id is string => Boolean(id));

					if (!attachmentId) {
						unresolvedImages++;
						position++;
						continue;
					}

					// Counted from what was inserted, not from what was attempted:
					// a page that shows the same image twice conflicts on the
					// primary key, and reporting the attempt would overstate it.
					const link = await tx<{ attachment_id: string }[]>`
						insert into attachment_links (attachment_id, entity_type, entity_id,
						                              role, position)
						values (${attachmentId}, 'source_record', ${pending.recordId},
						        'body_image', ${position})
						on conflict do nothing
						returning attachment_id
					`;
					if (link.length > 0) imageLinks++;
					position++;
				}
			}

			if (unresolvedImages > 0) {
				note(
					'warning',
					'unresolved_body_image',
					`${unresolvedImages} image reference(s) in page bodies did not resolve to a stored file`
				);
			}

			// ─── pass two: relations ─────────────────────────────────────────
			let linkCount = 0;
			let unresolved = 0;
			const unresolvedTargets = new Set<string>();
			// Page ids present anywhere in the export, used to distinguish
			// "points at a page we have" from "points at something missing".
			const pageFileIds = new Set(
				inv.files.filter((f) => f.notionId).map((f) => notionIdToUuid(f.notionId!))
			);

			for (const pending of pendingRelations) {
				const refs = parseRelationCell(pending.value);
				let position = 0;
				for (const ref of refs) {
					const targetRecordId = recordIdByNotionId.get(ref.notionId) ?? null;
					if (!targetRecordId) {
						unresolved++;
						unresolvedTargets.add(notionIdToUuid(ref.notionId));
					}

					await tx`
						insert into source_links (import_run_id, from_record_id, property,
						                          to_notion_page_id, to_record_id, position,
						                          display_text)
						values (${run.id}, ${pending.recordId}, ${pending.property},
						        ${notionIdToUuid(ref.notionId)}, ${targetRecordId}, ${position},
						        ${ref.title || null})
					`;
					position++;
					linkCount++;
				}
			}

			if (disambiguated > 0) {
				note(
					'info',
					'duplicate_title_disambiguated',
					`${disambiguated} row(s) with a duplicate title were matched to a page by ` +
						`property agreement rather than listing order`
				);
			}

			if (untitledRows > 0) {
				note(
					'info',
					'untitled_row',
					`${untitledRows} row(s) have no title, so no page file exists for them`
				);
			}

			if (rowsWithoutPageId > 0) {
				// A titled row with no page file cannot be a relation target.
				// This is the number that should be zero.
				note(
					'warning',
					'row_without_page_id',
					`${rowsWithoutPageId} titled row(s) have no matching page file`
				);
			}

			if (unresolved > 0) {
				// Explained rather than merely counted. Every unresolved target in
				// this export is a real page file; it simply was not claimed by a
				// canonical row, because that row was untitled or shared its title
				// with another and the page could not be assigned deterministically.
				const knownPages = [...unresolvedTargets].filter((id) => pageFileIds.has(id)).length;
				note(
					'info',
					'unresolved_relation_target',
					`${unresolved} relation reference(s) across ${unresolvedTargets.size} ` +
						`distinct target(s) did not resolve to a canonical row; ` +
						`${knownPages} of those targets exist as page files, so they are ` +
						`pages no row could claim (untitled or duplicate titles)`
				);
			}

			for (const issue of issues) {
				await tx`
					insert into import_issues (import_run_id, severity, code, message)
					values (${run.id}, ${issue.severity}, ${issue.code}, ${issue.message})
				`;
			}

			const promoted =
				options.promote === false
					? undefined
					: await promote(tx, {
							importRunId: run.id,
							householdId: options.householdId,
							ownerUserId: options.ownerUserId ?? null,
							createdBy: options.startedBy ?? null
						});

			const result: ImportSummary = {
				importRunId: run.id,
				dryRun,
				files: inv.files.length,
				databases: canonical.length,
				rows: rowCount,
				links: linkCount,
				unresolvedLinks: unresolved,
				mediaFiles: inv.counts.media,
				uniqueMedia: mediaHashes.size,
				mediaStored,
				mediaRejected,
				imageLinks,
				pageIds: recordIdByNotionId.size,
				rowsWithBody,
				pageFiles: inv.counts.markdown,
				untitledRows,
				issues,
				promoted
			};

			await tx`
				update import_runs
				set finished_at = now(),
				    status = ${dryRun ? 'dry_run' : 'succeeded'},
				    summary = ${JSON.stringify(result)}::text::jsonb
				where id = ${run.id}
			`;

			if (dryRun) {
				// Roll back by throwing a sentinel, carrying the result out with it.
				throw new DryRunComplete(result);
			}
			return result;
		})
		.catch((err: unknown) => {
			if (err instanceof DryRunComplete) return err.summary;
			throw err;
		});

	return summary;
}

/** Carries a dry run's result out through the rollback. */
class DryRunComplete extends Error {
	// Written out rather than a parameter property: Node's strip-only
	// TypeScript mode does not support those, and this file is executed
	// directly by the import CLI.
	readonly summary: ImportSummary;

	constructor(summary: ImportSummary) {
		super('dry run complete');
		this.name = 'DryRunComplete';
		this.summary = summary;
	}
}

/**
 * Index of per-row page files, keyed by the database directory they sit in.
 *
 * Canonical CSVs carry no id column for the row itself, but Notion writes one
 * file per row alongside them, named `<Title> <32-hex id>.md`. The directory
 * is the CSV path with `_all.csv` removed, so the mapping is positional rather
 * than guessed.
 *
 * Titles are not unique (10 duplicate groups in this export), so each title
 * maps to a list and rows consume them in order.
 */
/** Notion truncates the title portion of an exported filename to this length. */
export const MAX_FILENAME_TITLE = 50;

/**
 * Lookup keys for a row title, most specific first.
 *
 * Long titles cannot match exactly: Notion caps the filename's title at 50
 * characters, so 13 Library rows here are stored under a prefix of their real
 * title. Trying the truncated form as a fallback recovers them without
 * loosening the exact match that everything else relies on.
 */
export function titleKeys(title: string): string[] {
	const full = titleKey(title);
	const keys = [full];
	if (full.length > MAX_FILENAME_TITLE) {
		keys.push(full.slice(0, MAX_FILENAME_TITLE).trim());
	}
	return keys;
}

export function titleKey(title: string): string {
	// Notion cannot put filesystem-illegal characters in a filename, so it
	// replaces them and collapses the result. Comparing raw titles therefore
	// fails for every title containing one: "Environment: House & Home" is
	// stored as "Environment House & Home", "Achey/Sore" as "Achey Sore".
	// Normalising both sides is what makes those rows resolvable.
	return (
		title
			// The period is here on evidence, not guesswork: no page filename in
			// this export contains one, while three titles do. Notion replaces it
			// along with the characters a filesystem actually forbids.
			.replace(/[\\/:*?"<>|.]/g, ' ')
			.replace(/\s+/g, ' ')
			.trim()
			.toLowerCase()
	);
}

export function buildPageIndex(files: SourceFile[]): Map<string, Map<string, string[]>> {
	const index = new Map<string, Map<string, string[]>>();

	for (const file of files) {
		if (file.kind !== 'markdown' || !file.notionId) continue;

		const parts = file.relativePath.split('/');
		const base = parts.pop() ?? '';
		const directory = parts.join('/');

		// `Some Title 3ad879a5….md` -> `Some Title`
		const title = base
			.replace(/\.md$/i, '')
			.replace(new RegExp(`\\s*${file.notionId}$`), '')
			.trim();

		let byTitle = index.get(directory);
		if (!byTitle) {
			byTitle = new Map();
			index.set(directory, byTitle);
		}
		const key = titleKey(title);
		const ids = byTitle.get(key) ?? [];
		ids.push(file.notionId);
		byTitle.set(key, ids);
	}

	return index;
}

/**
 * How well a page's properties agree with a CSV row, counted over scalar values.
 *
 * Only needed when a title is duplicated. Consuming candidates in listing order
 * assumes the CSV's row order matches the directory's, which is not guaranteed:
 * cross-checking the two sources found same-titled rows whose Status values were
 * swapped, which would have attached every relation to the wrong record.
 */
export function propertyAgreement(
	row: Record<string, string>,
	properties: Record<string, string>
): number {
	let score = 0;
	for (const [key, value] of Object.entries(properties)) {
		const cell = (row[key] ?? '').trim();
		if (!cell || !value) continue;
		// Relation cells encode their paths differently in the two sources.
		if (value.includes('(') || cell.includes('(')) continue;
		// A multi-line CSV value appears truncated to its first line here.
		if (cell === value || cell.split('\n')[0]!.trim() === value) score++;
	}
	return score;
}

/**
 * The directory holding a database's per-row page files.
 *
 * The CSV keeps the database id in its filename but the sibling directory does
 * not: `Tasks Database <id>_all.csv` pairs with `Tasks Database/`. Stripping
 * only `_all.csv` yields a directory that does not exist, and every page id
 * then fails to resolve — silently, since a missing directory is empty.
 */
export function pageDirectoryFor(csvRelativePath: string): string {
	return csvRelativePath.replace(/\s*[0-9a-f]{32}_all\.csv$/i, '').replace(/_all\.csv$/i, '');
}
