import type { Viewer } from '../auth/authz';
import {
	InvalidInput,
	getScoped,
	guarded,
	isUuid,
	readableScope,
	toText,
	writableScope,
	type Queryable,
	type WriteResult
} from './base';

/**
 * Related recipes (migration 0039, PACK2-001): the soup that goes with the
 * bread, two dinners that share a sauce.
 *
 * The same shape and rules as library links (./library): one stored row per
 * pair in canonical order, no direction, shown on both recipes' pages alike.
 * Starting or removing a link needs the recipe whose page it happens on to be
 * writable and the other one readable; listing shows only the related recipes
 * the viewer can read, so a link never names a private recipe through the
 * join.
 */

export interface RelatedRecipe {
	/** The *other* recipe's id — never the one the caller already has. */
	recipeId: string;
	name: string;
	archived: boolean;
}

export async function listRelatedRecipes(
	sql: Queryable,
	viewer: Viewer,
	recipeId: string
): Promise<RelatedRecipe[]> {
	if (!isUuid(recipeId)) return [];
	// The anchor is checked as well as the far end: without it, asking about
	// another member's private recipe would list which of the viewer's own
	// recipes it links to.
	const anchorReadable = sql`exists (
		select 1 from recipes a
		where a.id = ${recipeId}::uuid and ${readableScope(sql, viewer, 'a')}
	)`;
	const rows = await sql<{ recipe_id: string; name: string; archived: boolean }[]>`
		select r.id as recipe_id, r.name, (r.archived_at is not null) as archived
		from recipe_links l
		join recipes r on r.id = l.recipe_b_id
		where l.recipe_a_id = ${recipeId}::uuid and ${readableScope(sql, viewer, 'r')}
		  and ${anchorReadable}
		union all
		select r.id as recipe_id, r.name, (r.archived_at is not null) as archived
		from recipe_links l
		join recipes r on r.id = l.recipe_a_id
		where l.recipe_b_id = ${recipeId}::uuid and ${readableScope(sql, viewer, 'r')}
		  and ${anchorReadable}
		order by name asc
	`;
	return rows.map((row) => ({
		recipeId: row.recipe_id,
		name: toText(row.name),
		archived: Boolean(row.archived)
	}));
}

/** Links two recipes. Linking a pair twice leaves one link. */
export function addRelatedRecipe(
	sql: Queryable,
	viewer: Viewer,
	fromId: string,
	toId: string
): Promise<WriteResult<RelatedRecipe>> {
	return guarded<RelatedRecipe>(async () => {
		if (!isUuid(fromId) || !isUuid(toId)) throw new InvalidInput('choose a recipe to link to');
		if (fromId === toId) throw new InvalidInput('a recipe cannot be related to itself');

		const from = await getScoped<{ id: string }>(
			sql,
			'recipes',
			fromId,
			writableScope(sql, viewer, 'recipes'),
			sql`id`
		);
		if (!from) return { ok: false, reason: 'not_found' };
		const to = await getScoped<{ id: string; name: string; archived_at: unknown }>(
			sql,
			'recipes',
			toId,
			readableScope(sql, viewer, 'recipes'),
			sql`id, name, archived_at`
		);
		if (!to) return { ok: false, reason: 'not_found' };

		await sql`
			insert into recipe_links (recipe_a_id, recipe_b_id, created_by)
			values (least(${fromId}::uuid, ${toId}::uuid), greatest(${fromId}::uuid, ${toId}::uuid),
			        ${viewer.userId}::uuid)
			on conflict (recipe_a_id, recipe_b_id) do nothing
		`;
		return {
			ok: true,
			record: { recipeId: to.id, name: toText(to.name), archived: to.archived_at !== null }
		};
	});
}

/** Unlinks two recipes. Not linked already is success, not failure. */
export async function removeRelatedRecipe(
	sql: Queryable,
	viewer: Viewer,
	fromId: string,
	toId: string
): Promise<boolean> {
	if (!isUuid(fromId) || !isUuid(toId)) return false;
	const rows = await sql<{ recipe_a_id: string }[]>`
		delete from recipe_links l
		using recipes r
		where r.id = ${fromId}::uuid and ${writableScope(sql, viewer, 'r')}
		  and l.recipe_a_id = least(${fromId}::uuid, ${toId}::uuid)
		  and l.recipe_b_id = greatest(${fromId}::uuid, ${toId}::uuid)
		returning l.recipe_a_id
	`;
	return rows.length > 0;
}
