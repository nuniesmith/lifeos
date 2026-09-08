-- A smaller copy of an image is a variant of it, not a different attachment.
--
-- Covers arrived at 1.2 MB median and up to 11 MB, drawn as 48-pixel list rows;
-- the fix was a generated thumbnail, linked with a role of its own
-- ('cover_thumb'). Body images have the same shape of problem for a different
-- reason — every one of the 114 is a PNG, 39 of them over 500 kB, because
-- photographs and screenshots were saved in a lossless format — and would have
-- needed a second role beside the first.
--
-- Two ad-hoc conventions for "a smaller copy of an image" is one too many, and
-- the second one is always the one that gets forgotten. A variant is now a
-- property of the attachment: it points at the image it was made from, and says
-- what kind of copy it is.
--
-- The variant carries its own household_id, sha256 and storage_key like any
-- other attachment, so nothing about serving, exporting, restoring or
-- deduplicating changes. What changes is that a reader can ask for the small
-- copy of a known image instead of guessing from a link role.

alter table attachments
    add column variant_of uuid references attachments (id) on delete cascade,
    add column variant_kind text;

-- 'thumb'   — longest side 320px, for list rows and tiles
-- 'display' — full dimensions, re-encoded, for reading at card width
alter table attachments
    add constraint attachments_variant_kind_check
    check (variant_kind is null or variant_kind in ('thumb', 'display'));

-- Both together or neither: a variant without a parent is an orphan nobody can
-- find, and a parent reference without a kind cannot be chosen between.
alter table attachments
    add constraint attachments_variant_complete
    check ((variant_of is null) = (variant_kind is null));

-- One variant of each kind per image. The generator is content-addressed and
-- idempotent, and this is what keeps it so if it is ever changed.
create unique index attachments_variant_idx
    on attachments (variant_of, variant_kind)
    where variant_of is not null;

-- The lookup every page does: given the images on a record, find their variants.
create index attachments_variant_of_idx on attachments (variant_of)
    where variant_of is not null;

-- The cover thumbnails already generated were linked with role 'cover_thumb'
-- against the same source record. Move them to the new model rather than
-- leaving two mechanisms live: match each thumbnail to the cover on its own
-- record, point it at that cover, then drop the link that stood in for this.
update attachments t
set variant_of = c.attachment_id,
    variant_kind = 'thumb'
from attachment_links tl
join attachment_links c
  on c.entity_type = tl.entity_type
 and c.entity_id = tl.entity_id
 and c.role = 'cover'
where tl.attachment_id = t.id
  and tl.role = 'cover_thumb'
  and t.variant_of is null;

delete from attachment_links where role = 'cover_thumb';
