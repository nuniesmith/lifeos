import type { Sql } from 'postgres';
import { one } from '../db/scalar.ts';
import { notionIdToUuid, parseCsvTable, parseRelationCell } from './csv.ts';
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
	pageIds: number;
	/** Page files present in the export, whether or not a row matched one. */
	pageFiles: number;
	/** Rows with no title; a page file cannot exist for these. */
	untitledRows: number;
	issues: { severity: string; code: string; message: string }[];
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

			// ─── pass one: canonical rows ────────────────────────────────────
			const canonical = inv.files.filter((f) => f.kind === 'csv_all');
			const pageIndex = buildPageIndex(inv.files);
			const recordIdByNotionId = new Map<string, string>();
			let rowCount = 0;
			let rowsWithoutPageId = 0;
			let untitledRows = 0;

			// Cells are kept for pass two so each file is parsed exactly once.
			const pendingRelations: { recordId: string; property: string; value: string }[] = [];

			for (const file of canonical) {
				const table = parseCsvTable(await readText(file));
				const databaseName = databaseNameFromPath(file.relativePath);
				const titleColumn = table.headers[0] ?? '';
				const sourceId = sourceIdByPath.get(file.relativePath)!;
				const pageTitles = pageIndex.get(pageDirectoryFor(file.relativePath));
				// Consumed in order so duplicate titles map one-to-one.
				const consumed = new Map<string, number>();

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
						const used = consumed.get(key) ?? 0;
						if (candidates[used]) {
							pageId = candidates[used]!;
							consumed.set(key, used + 1);
							break;
						}
					}
					// An untitled row cannot have a page file: Notion names those
					// files after the title. Counted separately so it is not
					// mistaken for a matching failure.
					if (!pageId) {
						if (title) rowsWithoutPageId++;
						else untitledRows++;
					}

					const inserted = one(
						await tx<{ id: string }[]>`
							insert into source_records (import_run_id, source_id, notion_page_id,
							                            database_name, title, ordinal, raw)
							values (${run.id}, ${sourceId},
							        ${pageId ? notionIdToUuid(pageId) : null},
							        ${databaseName}, ${title || null}, ${ordinal},
							        ${JSON.stringify(record)}::jsonb)
							returning id
						`,
						'source record'
					);

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

			// ─── pass two: relations ─────────────────────────────────────────
			let linkCount = 0;
			let unresolved = 0;

			for (const pending of pendingRelations) {
				const refs = parseRelationCell(pending.value);
				let position = 0;
				for (const ref of refs) {
					const targetRecordId = recordIdByNotionId.get(ref.notionId) ?? null;
					if (!targetRecordId) unresolved++;

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
				// Expected rather than alarming: relations point at pages that
				// live outside the canonical CSVs, e.g. sub-pages. Recorded so
				// the number is explicit instead of silently absorbed.
				note(
					'info',
					'unresolved_relation_target',
					`${unresolved} relation reference(s) point outside the canonical rows`
				);
			}

			for (const issue of issues) {
				await tx`
					insert into import_issues (import_run_id, severity, code, message)
					values (${run.id}, ${issue.severity}, ${issue.code}, ${issue.message})
				`;
			}

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
				pageIds: recordIdByNotionId.size,
				pageFiles: inv.counts.markdown,
				untitledRows,
				issues
			};

			await tx`
				update import_runs
				set finished_at = now(),
				    status = ${dryRun ? 'dry_run' : 'succeeded'},
				    summary = ${JSON.stringify(result)}::jsonb
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
	return title
		.replace(/[\\/:*?"<>|]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase();
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
