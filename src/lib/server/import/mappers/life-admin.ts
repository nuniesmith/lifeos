import { archivedAt, date, mapper, numeric, text, withBody } from './shared.ts';

/**
 * Records & Renewals -> documents (migration 0036) and Food Library -> foods
 * (migration 0032), first imported from the 2026-10-14 export.
 */

/**
 * A record's kind, from its name and failing that its Category.
 *
 * The name goes first: a birth certificate filed under "ID & License" is a
 * certificate, which the category alone would call a licence.
 */
export function documentKind(category: string | null, title: string): string {
	return kindOf(title) ?? kindOf(category ?? '') ?? 'other';
}

function kindOf(value: string): string | null {
	const c = value.toLowerCase();
	if (!c.trim()) return null;
	if (/birth|marriage|divorce|decree|certificate|diploma|degree/.test(c)) return 'certificate';
	if (/driver|licen[cs]e|permit/.test(c) && !/vehicle/.test(c)) return 'licence';
	if (/vehicle|ownership|registration|title\b/.test(c)) return 'registration';
	if (/passport|social security|\bsin\b|health card|\bid\b|identity/.test(c)) return 'id';
	if (/insur/.test(c)) return 'insurance';
	if (/warrant/.test(c)) return 'warranty';
	if (/member/.test(c)) return 'membership';
	return null;
}

/**
 * Records & Renewals Database -> documents.
 *
 * "Owner" is a plain name ("Kayla"), matched to a person the import already
 * brought in from People & Places; with no match the name is kept in the
 * notes rather than dropped. "Next Date" is when the record next expires or
 * renews. Attached files ("Files & media") are not imported here: the
 * Markdown & CSV export carries them as bare paths, and attaching them is a
 * job for the attachments importer, not a column.
 */
export const mapRecord = mapper('documents', async (sql, row, o) => {
	const title = row.title?.trim();
	if (!title) return null;

	const owner = text(row, 'Owner');
	const [person] = owner
		? await sql<{ id: string }[]>`
				select id from people
				where household_id = ${o.householdId} and lower(trim(name)) = lower(trim(${owner}))
				  and archived_at is null
				limit 1
			`
		: [];
	const notesParts = [withBody(row, 'Notes')];
	if (owner && !person) notesParts.push(`Owner: ${owner}`);
	const notes = notesParts.filter(Boolean).join('\n\n') || null;

	const [r] = await sql<{ id: string }[]>`
		insert into documents (household_id, owner_user_id, title, kind, holder_person_id, issuer,
		                       reference, issued_on, expires_on, location, url, notes,
		                       notion_page_id, source_record_id, created_by, archived_at)
		values (${o.householdId}, ${o.ownerUserId}, ${title.slice(0, 200)},
		        ${documentKind(text(row, 'Category'), title)}, ${person?.id ?? null},
		        ${text(row, 'Issuer/Provider')}, ${text(row, 'Reference #')},
		        ${date(row, 'Issued/Started')}, ${date(row, 'Next Date')}, ${text(row, 'Location')},
		        ${text(row, 'URL')}, ${notes},
		        ${row.notion_page_id}, ${row.id}, ${o.createdBy}, ${archivedAt(row)}::timestamptz)
		on conflict (notion_page_id) do update set
			title = excluded.title, kind = excluded.kind,
			holder_person_id = coalesce(excluded.holder_person_id, documents.holder_person_id),
			issuer = excluded.issuer, reference = excluded.reference,
			issued_on = excluded.issued_on, expires_on = excluded.expires_on,
			location = excluded.location, url = excluded.url, notes = excluded.notes,
			source_record_id = excluded.source_record_id
		returning id
	`;
	return r?.id ?? null;
});

const nonNegative = (n: number | null): number | null => (n !== null && n >= 0 ? n : null);

/**
 * Food Library Database -> foods.
 *
 * Nutrients are per serving, as the source enters them. Calcium has no
 * column in `foods`, so it is kept in the notes rather than lost.
 */
export const mapFood = mapper('foods', async (sql, row, o) => {
	const name = row.title?.trim();
	if (!name) return null;
	const size = text(row, 'Serving Size');
	const unit = text(row, 'Serving Unit');
	const serving = [size, unit].filter(Boolean).join(' ') || null;
	const calcium = numeric(row, 'Calcium');
	const notes =
		[withBody(row, null), calcium !== null ? `Calcium: ${calcium} mg` : null]
			.filter(Boolean)
			.join('\n\n') || null;

	const [r] = await sql<{ id: string }[]>`
		insert into foods (household_id, owner_user_id, name, brand, serving, kcal_per_serving,
		                   protein_g, carbs_g, fibre_g, sugar_g, total_fat_g, sodium_mg, notes,
		                   notion_page_id, source_record_id, created_by, archived_at)
		values (${o.householdId}, ${o.ownerUserId}, ${name.slice(0, 200)}, ${text(row, 'Brand')},
		        ${serving}, ${nonNegative(numeric(row, 'Calories'))},
		        ${nonNegative(numeric(row, 'Protein'))}, ${nonNegative(numeric(row, 'Carbs'))},
		        ${nonNegative(numeric(row, 'Fibre'))}, ${nonNegative(numeric(row, 'Sugar'))},
		        ${nonNegative(numeric(row, 'Fat'))}, ${nonNegative(numeric(row, 'Sodium'))}, ${notes},
		        ${row.notion_page_id}, ${row.id}, ${o.createdBy}, ${archivedAt(row)}::timestamptz)
		on conflict (notion_page_id) do update set
			name = excluded.name, brand = excluded.brand, serving = excluded.serving,
			kcal_per_serving = excluded.kcal_per_serving, protein_g = excluded.protein_g,
			carbs_g = excluded.carbs_g, fibre_g = excluded.fibre_g, sugar_g = excluded.sugar_g,
			total_fat_g = excluded.total_fat_g, sodium_mg = excluded.sodium_mg,
			notes = coalesce(excluded.notes, foods.notes),
			source_record_id = excluded.source_record_id
		returning id
	`;
	return r?.id ?? null;
});
