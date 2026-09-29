import type { Fragment } from 'postgres';
import type { Viewer } from '../auth/authz';
import {
	InvalidInput,
	atomically,
	baseColumns,
	guarded,
	isUuid,
	liveScope,
	mapBase,
	pageOf,
	readableScope,
	resolveOwnership,
	toDay,
	toNumberOrNull,
	toText,
	toTextOrNull,
	writableBy,
	writableScope,
	writeScoped,
	type BaseRow,
	type OwnershipInput,
	type PageOptions,
	type Queryable,
	type RecordBase,
	type WriteResult
} from './base';
import {
	optionalId,
	optionalNumber,
	optionalText,
	patched,
	requiredDay,
	requiredText
} from './validate';

/**
 * Savings (PACK4-002, the Financial Hub).
 *
 * A contribution is a fact about money moved, optionally toward one of the
 * household's existing goals (`goals`, migration 0004). The link is checked
 * readable in the same transaction that writes it (`resolveGoalId`, used
 * inside `atomically`) — the same shape `planMeal` in food.ts checks a recipe
 * before planning it onto a day — so a caller cannot attach a contribution to
 * a goal it cannot see by guessing that goal's id, and a stale or archived
 * goal is refused rather than silently dropped: this is money, and silently
 * mis-attributing it would be worse than a wishlist item losing its "for".
 */

export interface SavingsContribution extends RecordBase {
	title: string;
	amount: number;
	contributedOn: string;
	goalId: string | null;
	/** Denormalised for display, the same shape `WishlistItem.forPersonName`
	 *  uses for its own optional link to `people` — but null when the viewer
	 *  cannot read the goal. A contribution shared with the household may point
	 *  at its author's private goal, and the goal's title is the private part.
	 *  `savingsSummary`'s per-goal join applies the same check. */
	goalTitle: string | null;
	notes: string | null;
}

interface SavingsContributionRow extends BaseRow {
	title: string;
	amount: unknown;
	contributed_on: string;
	goal_id: string | null;
	goal_title: string | null;
	notes: string | null;
}

const SAVINGS_CONTRIBUTIONS = 'savings_contributions';
const GOALS = 'goals';

// `s` is aliased and every base column qualified: joining `goals` for its
// title would otherwise make `id`, `created_at`, `updated_at`, `created_by`
// and `updated_by` all ambiguous — the same reason `listWishlist` qualifies
// every column when it joins `people`.
const savingsColumns = (sql: Queryable): Fragment => sql`
	s.id, s.household_id, s.owner_user_id, s.visibility, s.notion_page_id, s.source_record_id,
	s.created_at, s.updated_at, s.created_by, s.updated_by, s.archived_at,
	s.title, s.amount, s.contributed_on::text as contributed_on, s.goal_id, s.notes,
	g.title as goal_title`;

// An UPDATE or archive's own RETURNING cannot reach across the join that
// gives every other read here `goalTitle`, so a write reads back only this
// table's own columns and re-fetches through `getSavingsContribution` for the
// title — the same two-step shape `updateWishlistItem` uses for its own
// `forPersonName` in collections.ts.
const savingsWriteColumns = (sql: Queryable): Fragment => sql`
	${baseColumns(sql)}, title, amount, contributed_on::text as contributed_on, goal_id, notes`;

function mapSavingsContribution(row: SavingsContributionRow): SavingsContribution {
	return {
		...mapBase(row),
		title: toText(row.title),
		amount: toNumberOrNull(row.amount) ?? 0,
		contributedOn: toDay(row.contributed_on),
		goalId: row.goal_id,
		goalTitle: toTextOrNull(row.goal_title),
		notes: toTextOrNull(row.notes)
	};
}

export interface SavingsContributionFilters extends PageOptions {
	goalId?: string;
	includeArchived?: boolean;
}

/** Most recent first, the same "what happened lately" framing income uses. */
export async function listSavingsContributions(
	sql: Queryable,
	viewer: Viewer,
	filters: SavingsContributionFilters = {}
): Promise<SavingsContribution[]> {
	const { limit, offset } = pageOf(filters);
	const rows = await sql<SavingsContributionRow[]>`
		select ${savingsColumns(sql)}
		from ${sql(SAVINGS_CONTRIBUTIONS)} s
		left join ${sql(GOALS)} g on g.id = s.goal_id and ${readableScope(sql, viewer, 'g')}
		where ${readableScope(sql, viewer, 's')}
		  and ${liveScope(sql, 's', filters.includeArchived)}
		  ${filters.goalId && isUuid(filters.goalId) ? sql`and s.goal_id = ${filters.goalId}::uuid` : sql``}
		order by s.contributed_on desc, s.created_at desc
		limit ${limit} offset ${offset}
	`;
	return rows.map(mapSavingsContribution);
}

export async function getSavingsContribution(
	sql: Queryable,
	viewer: Viewer,
	id: string
): Promise<SavingsContribution | null> {
	if (!isUuid(id)) return null;
	const rows = await sql<SavingsContributionRow[]>`
		select ${savingsColumns(sql)}
		from ${sql(SAVINGS_CONTRIBUTIONS)} s
		left join ${sql(GOALS)} g on g.id = s.goal_id and ${readableScope(sql, viewer, 'g')}
		where s.id = ${id}::uuid and ${readableScope(sql, viewer, 's')}
		limit 1
	`;
	return rows[0] ? mapSavingsContribution(rows[0]) : null;
}

export interface SavingsContributionInput extends OwnershipInput {
	title?: unknown;
	amount?: unknown;
	contributedOn?: unknown;
	goalId?: unknown;
	notes?: unknown;
}

/** The CHECK is `> 0`, not `>= 0` — `optionalNumber`'s bounds are inclusive,
 *  so this is checked by hand the same way health-measurements.ts's own
 *  `positive` helper checks a reading. */
function positiveAmount(value: unknown, field: string): number {
	const n = optionalNumber(value, field);
	if (n === null || n <= 0) throw new InvalidInput(`${field} must be greater than 0`);
	return n;
}

/**
 * Resolves an optional goal, checked against the household and the viewer's
 * own read access — a caller cannot attach a contribution to a goal it
 * cannot see by guessing that goal's id.
 *
 * Returns `undefined` for "named but not reachable" (refused), distinct from
 * `null` for "no goal at all" — the same contract `resolveDailyLogId` in
 * health-measurements.ts uses for its own optional link. Always called inside
 * `atomically`, so the check and the write that follows it share one
 * transaction.
 */
async function resolveGoalId(
	sql: Queryable,
	viewer: Viewer,
	goalId: string | null
): Promise<string | null | undefined> {
	if (goalId === null) return null;
	if (!isUuid(goalId)) return undefined;
	const rows = await sql<{ id: string }[]>`
		select id from ${sql(GOALS)} where id = ${goalId}::uuid and ${readableScope(sql, viewer, GOALS)}
	`;
	return rows[0]?.id;
}

export function createSavingsContribution(
	sql: Queryable,
	viewer: Viewer,
	input: SavingsContributionInput
): Promise<WriteResult<SavingsContribution>> {
	return guarded<SavingsContribution>(() =>
		atomically(sql, async (tx): Promise<WriteResult<SavingsContribution>> => {
			const title = requiredText(input.title, 'title', 200);
			const amount = positiveAmount(input.amount, 'amount');
			const contributedOn = requiredDay(input.contributedOn, 'date');
			const notes = optionalText(input.notes, 'notes');

			const rawGoalId = optionalId(input.goalId, 'goal');
			const goalId = await resolveGoalId(tx, viewer, rawGoalId);
			if (goalId === undefined) {
				return { ok: false, reason: 'not_found', message: 'could not find that goal' };
			}

			const { ownerUserId, visibility } = resolveOwnership(viewer, input, {
				ownerUserId: null,
				visibility: 'household'
			});

			const rows = await tx<{ id: string }[]>`
				insert into ${tx(SAVINGS_CONTRIBUTIONS)} (
					household_id, owner_user_id, visibility, title, amount, contributed_on,
					goal_id, notes, created_by, updated_by
				) values (
					${viewer.householdId}::uuid, ${ownerUserId}::uuid, ${visibility}, ${title},
					${amount}::numeric, ${contributedOn}::date, ${goalId}::uuid, ${notes},
					${viewer.userId}::uuid, ${viewer.userId}::uuid
				)
				returning id
			`;
			const id = rows[0]?.id;
			if (!id) throw new Error('insert returned no row');

			// Re-read through the same join the list uses, so the record carries
			// the goal's title rather than only its id.
			const found = await getSavingsContribution(tx, viewer, id);
			if (!found) throw new Error('insert returned no readable row');
			return { ok: true, record: found };
		})
	);
}

export function updateSavingsContribution(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	patch: SavingsContributionInput,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<SavingsContribution>> {
	return guarded<SavingsContribution>(() =>
		atomically(sql, async (tx): Promise<WriteResult<SavingsContribution>> => {
			const current = await getSavingsContribution(tx, viewer, id);
			if (!current) return { ok: false, reason: 'not_found' };

			const next = {
				title: patched(patch, 'title', current.title, (v) => requiredText(v, 'title', 200)),
				amount: patched(patch, 'amount', current.amount, (v) => positiveAmount(v, 'amount')),
				contributedOn: patched(patch, 'contributedOn', current.contributedOn, (v) =>
					requiredDay(v, 'date')
				),
				notes: patched(patch, 'notes', current.notes, (v) => optionalText(v, 'notes'))
			};

			// Left alone unless the patch actually mentions it, so an edit to an
			// unrelated field never detaches an existing goal.
			let goalId = current.goalId;
			if (patch.goalId !== undefined) {
				const raw = optionalId(patch.goalId, 'goal');
				const resolved = await resolveGoalId(tx, viewer, raw);
				if (resolved === undefined) {
					return { ok: false, reason: 'not_found', message: 'could not find that goal' };
				}
				goalId = resolved;
			}

			const ownership = resolveOwnership(viewer, patch, {
				ownerUserId: current.ownerUserId,
				visibility: current.visibility
			});

			const result = await writeScoped<SavingsContributionRow, SavingsContribution>({
				sql: tx,
				table: SAVINGS_CONTRIBUTIONS,
				id,
				readScope: readableScope(tx, viewer, SAVINGS_CONTRIBUTIONS),
				writeScope: writableScope(tx, viewer, SAVINGS_CONTRIBUTIONS),
				...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
				assignments: tx`
					title = ${next.title}, amount = ${next.amount}::numeric,
					contributed_on = ${next.contributedOn}::date, goal_id = ${goalId}::uuid,
					notes = ${next.notes},
					owner_user_id = ${ownership.ownerUserId}::uuid, visibility = ${ownership.visibility},
					updated_at = now(), updated_by = ${viewer.userId}::uuid`,
				columns: savingsWriteColumns(tx),
				map: mapSavingsContribution,
				mayWrite: writableBy(viewer)
			});
			if (!result.ok) return result;

			const found = await getSavingsContribution(tx, viewer, result.record.id);
			if (!found) throw new Error('update returned no readable row');
			return { ok: true, record: found };
		})
	);
}

/** "Delete": archived contributions leave /finance's totals but stay
 *  recoverable from the Archive, like everything else in LifeOS (base.ts's
 *  header). Hand-rolled rather than built on base.ts's `archiveScoped` for
 *  the same reason `setBillArchived` is: this table has no `updated_at`
 *  trigger. */
export function setSavingsContributionArchived(
	sql: Queryable,
	viewer: Viewer,
	id: string,
	archived: boolean,
	expectedUpdatedAt?: Date | string
): Promise<WriteResult<SavingsContribution>> {
	return guarded<SavingsContribution>(async () => {
		const result = await writeScoped<SavingsContributionRow, SavingsContribution>({
			sql,
			table: SAVINGS_CONTRIBUTIONS,
			id,
			readScope: readableScope(sql, viewer, SAVINGS_CONTRIBUTIONS),
			writeScope: writableScope(sql, viewer, SAVINGS_CONTRIBUTIONS),
			...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
			assignments: sql`
				archived_at = case when ${archived}::boolean then now() else null end,
				updated_at = now(), updated_by = ${viewer.userId}::uuid`,
			columns: savingsWriteColumns(sql),
			map: mapSavingsContribution,
			mayWrite: writableBy(viewer)
		});
		if (!result.ok) return result;
		const found = await getSavingsContribution(sql, viewer, result.record.id);
		if (!found) throw new Error('archive returned no readable row');
		return { ok: true, record: found };
	});
}

export interface SavingsSummary {
	/** All-time, across every goal and every contribution with no goal. */
	total: number;
	/** This calendar month, same scope. */
	thisMonth: number;
	perGoal: { goalId: string; goalTitle: string; total: number }[];
}

/**
 * Saved this month and saved in total, plus the total behind each goal —
 * everything /finance's Money at a Glance and the savings section need,
 * summed in SQL so the totals are exact (base.ts rule 1).
 */
export async function savingsSummary(
	sql: Queryable,
	viewer: Viewer,
	monthStart: string,
	monthEnd: string
): Promise<SavingsSummary> {
	const [totals] = await sql<{ total: string | null; this_month: string | null }[]>`
		select sum(amount) as total,
		       sum(amount) filter (
		         where contributed_on between ${monthStart}::date and ${monthEnd}::date
		       ) as this_month
		from ${sql(SAVINGS_CONTRIBUTIONS)}
		where ${readableScope(sql, viewer, SAVINGS_CONTRIBUTIONS)} and archived_at is null
	`;

	const perGoal = await sql<{ goal_id: string; goal_title: string; total: string }[]>`
		select s.goal_id, g.title as goal_title, sum(s.amount) as total
		from ${sql(SAVINGS_CONTRIBUTIONS)} s
		-- A contribution toward a goal the viewer cannot read still counts in the
		-- totals above, but is left out of this breakdown rather than naming it.
		join ${sql(GOALS)} g on g.id = s.goal_id and ${readableScope(sql, viewer, 'g')}
		where ${readableScope(sql, viewer, 's')} and s.archived_at is null and s.goal_id is not null
		group by s.goal_id, g.title
		order by g.title asc
	`;

	return {
		total: toNumberOrNull(totals?.total ?? null) ?? 0,
		thisMonth: toNumberOrNull(totals?.this_month ?? null) ?? 0,
		perGoal: perGoal.map((row) => ({
			goalId: row.goal_id,
			goalTitle: toText(row.goal_title),
			total: toNumberOrNull(row.total) ?? 0
		}))
	};
}
