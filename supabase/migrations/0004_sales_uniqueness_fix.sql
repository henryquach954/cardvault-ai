-- Fix duplicate-sale prevention so it protects unique objects WITHOUT
-- blocking legitimate repeat sales of fungible stock.
--
-- The original index in 0001 was:
--
--   create unique index sale_items_unique_item_once
--     on sale_items (inventory_item_id) where quantity = 1;
--
-- The intent was "a graded slab cannot be sold twice". But `quantity = 1` is
-- the wrong proxy for "unique physical object": selling one copy of a raw
-- card you own three of also writes a row with quantity 1, so the SECOND
-- such sale would be rejected as a duplicate. That is a false positive on a
-- completely normal transaction.
--
-- Overselling fungible stock is already prevented, and prevented better, by
-- inventory_items.quantity_available (a generated column with CHECK >= 0).
-- This index only needs to guard genuinely unique objects.

drop index if exists sale_items_unique_item_once;

-- Denormalised onto sale_items because an index predicate cannot reference
-- another table. The trigger below is what keeps it honest, so the
-- application cannot set it incorrectly, by accident or otherwise.
alter table sale_items
  add column if not exists is_unique_item boolean not null default false;

create or replace function set_sale_item_uniqueness()
returns trigger
language plpgsql
as $$
declare
  item_kind item_kind;
begin
  if new.inventory_item_id is null then
    new.is_unique_item := false;
    return new;
  end if;

  select kind into item_kind
    from inventory_items
   where id = new.inventory_item_id;

  -- A graded slab is one certified physical object and can only ever be sold
  -- once. Everything else is governed by the quantity ledger.
  new.is_unique_item := (item_kind = 'graded_slab');
  return new;
end;
$$;

create trigger sale_items_set_uniqueness
  before insert or update on sale_items
  for each row execute function set_sale_item_uniqueness();

-- Backfill any rows that predate the trigger.
update sale_items si
   set is_unique_item = (
     select ii.kind = 'graded_slab'
       from inventory_items ii
      where ii.id = si.inventory_item_id
   )
 where si.inventory_item_id is not null;

create unique index sale_items_unique_object_once
  on sale_items (inventory_item_id)
  where is_unique_item;
