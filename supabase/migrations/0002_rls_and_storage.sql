-- CardVault AI — row-level security and private photo storage.
--
-- Every table in this schema has a user_id column. Rather than hand-writing
-- 60 near-identical policies (where a single omission is a silent data leak),
-- the policies are generated in a loop over an explicit table list. Uniformity
-- is the security property here: if a table is in the list it is locked down
-- identically, and the assertion at the bottom fails the migration if any
-- table was left without RLS.

do $$
declare
  t text;
  tables text[] := array[
    'card_catalog',
    'catalog_identifiers',
    'inventory_items',
    'inventory_images',
    'inventory_lots',
    'inventory_lot_items',
    'price_observations',
    'pricing_settings',
    'marketplace_accounts',
    'marketplace_listings',
    'sales',
    'sale_items',
    'expenses',
    'inventory_movements',
    'publishing_jobs'
  ];
begin
  foreach t in array tables loop
    execute format('alter table public.%I enable row level security', t);

    -- Deliberately NOT "force row level security".
    --
    -- FORCE applies policies to the table owner as well. Supabase's signup
    -- trigger (handle_new_user, below) is SECURITY DEFINER and runs as the
    -- owner at a moment when auth.uid() is still null, so under FORCE its
    -- seeding INSERT is rejected and account creation fails outright.
    -- This was verified empirically, not assumed.
    --
    -- FORCE buys nothing here regardless: client connections authenticate as
    -- `anon` or `authenticated`, never as the owning role.

    execute format($p$
      create policy %I on public.%I
        for select using (auth.uid() = user_id)
    $p$, t || '_select_own', t);

    execute format($p$
      create policy %I on public.%I
        for insert with check (auth.uid() = user_id)
    $p$, t || '_insert_own', t);

    execute format($p$
      create policy %I on public.%I
        for update using (auth.uid() = user_id) with check (auth.uid() = user_id)
    $p$, t || '_update_own', t);

    execute format($p$
      create policy %I on public.%I
        for delete using (auth.uid() = user_id)
    $p$, t || '_delete_own', t);
  end loop;
end
$$;

-- Fail the migration loudly if any public table escaped the list above.
do $$
declare
  unprotected text;
begin
  select string_agg(c.relname, ', ')
    into unprotected
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and not c.relrowsecurity;

  if unprotected is not null then
    raise exception 'Tables without RLS enabled: %', unprotected;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- price_observations is append-only: history must survive an override change.
-- ---------------------------------------------------------------------------

drop policy price_observations_update_own on public.price_observations;
drop policy price_observations_delete_own on public.price_observations;

-- inventory_movements is an audit trail; it is never edited or erased either.
drop policy inventory_movements_update_own on public.inventory_movements;
drop policy inventory_movements_delete_own on public.inventory_movements;

-- ---------------------------------------------------------------------------
-- Private photo storage. Objects are keyed <user_id>/<item_id>/<file>, and the
-- policies below require the leading path segment to match the caller, so one
-- account can never read another's card photos even with a guessed URL.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'card-photos',
  'card-photos',
  false,
  20971520, -- 20 MB; modern phone photos of a single card fit comfortably
  array['image/jpeg','image/png','image/webp','image/heic','image/heif']
)
on conflict (id) do nothing;

create policy "card photos are readable by owner"
  on storage.objects for select
  using (
    bucket_id = 'card-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "card photos are writable by owner"
  on storage.objects for insert
  with check (
    bucket_id = 'card-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "card photos are updatable by owner"
  on storage.objects for update
  using (
    bucket_id = 'card-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "card photos are deletable by owner"
  on storage.objects for delete
  using (
    bucket_id = 'card-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---------------------------------------------------------------------------
-- Seed per-user defaults on signup.
-- ---------------------------------------------------------------------------

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.pricing_settings (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  -- Record the marketplaces and their REAL capability. eBay is the only one of
  -- the three with a usable third-party publishing API; Facebook Marketplace
  -- and Mercari have no public seller API, so they are manual-handoff only.
  insert into public.marketplace_accounts (user_id, marketplace, capability, display_name)
  values
    (new.id, 'ebay',     'api_publish',  'eBay'),
    (new.id, 'facebook', 'manual_only',  'Facebook Marketplace'),
    (new.id, 'mercari',  'manual_only',  'Mercari')
  on conflict (user_id, marketplace) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
