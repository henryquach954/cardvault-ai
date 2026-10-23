-- CardVault AI — core schema (Stage 1 + forward-compatible scaffolding)
--
-- Money model: every monetary value is stored as an INTEGER number of minor
-- units (cents) alongside an ISO-4217 currency code. Never floats. A value of
-- NULL means "unknown"; a value of 0 means "actually zero".
--
-- Ownership model: this is a private multi-tenant-capable tool. Every table
-- carries user_id and is protected by row-level security keyed to auth.uid().

set check_function_bodies = off;

-- Trigram index support, used for fuzzy card-name search in Card Show Mode.
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- Enumerated types
-- ---------------------------------------------------------------------------

create type tcg_game as enum (
  'pokemon', 'mtg', 'yugioh', 'onepiece', 'lorcana',
  'digimon', 'sports', 'other'
);

create type card_condition as enum (
  'NM', 'LP', 'MP', 'HP', 'DMG', 'NEEDS_REVIEW'
);

create type item_kind as enum (
  'raw_single', 'graded_slab', 'sealed_product', 'bulk_group'
);

create type listing_status as enum (
  'draft', 'ready_to_publish', 'publishing', 'published',
  'failed', 'action_required', 'sold', 'ended'
);

create type inventory_status as enum (
  'in_stock', 'reserved', 'allocated_to_lot', 'listed', 'sold', 'removed'
);

-- The heart of the pricing-honesty model. A valuation may only be called a
-- "comp" if it was computed from rows whose claim_type is 'sold_observation'.
-- These are deliberately distinct so the engine cannot average an asking price
-- into a sold comp -- the distinction is enforced in types, not documentation.
create type price_claim_type as enum (
  'sold_observation',  -- one real completed transaction, with a date
  'sold_aggregate',    -- provider's own average OF real sales (e.g. Cardmarket avg7)
  'market_estimate',   -- provider's derived market price (e.g. TCGplayer marketPrice)
  'asking_price',      -- a current active listing price; NOT evidence of a sale
  'ai_estimate',       -- produced by a model; never authoritative
  'manual'             -- the operator typed this in
);

create type confidence_level as enum ('high', 'medium', 'low', 'unavailable');

create type retrieval_status as enum ('ok', 'not_found', 'error', 'unconfigured', 'stale');

create type movement_reason as enum (
  'acquired', 'sold', 'allocated_to_lot', 'released_from_lot',
  'adjusted', 'removed', 'returned'
);

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- card_catalog — canonical card identity, separate from physical copies owned
-- ---------------------------------------------------------------------------

create table card_catalog (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,

  game              tcg_game not null,
  name              text not null,
  set_name          text,
  set_code          text,
  collector_number  text,
  language          text not null default 'en',
  rarity            text,
  finish            text,              -- holo, reverse holo, normal, etc.
  variant           text,              -- parallel / promo / alternate art
  edition           text,              -- 1st Edition, Unlimited, Shadowless
  is_promo          boolean not null default false,
  release_year      integer,

  -- Sports-card specific fields, null for TCG singles. Kept as real columns
  -- because they are queried and filtered; game-specific extras that are NOT
  -- queried belong in `attributes`.
  sport             text,
  player            text,
  team              text,
  manufacturer      text,
  parallel          text,
  has_autograph     boolean,
  has_memorabilia   boolean,

  -- Escape hatch so a new TCG can be supported without a migration.
  attributes        jsonb not null default '{}'::jsonb,

  catalog_source    text,              -- 'tcgdex' | 'scryfall' | 'ygoprodeck' | 'manual'
  catalog_image_url text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- One catalog row per distinct printing per user. COALESCE because NULLs do
-- not compare equal in a unique index, which would let duplicates through.
create unique index card_catalog_identity_uniq on card_catalog (
  user_id, game,
  lower(name),
  coalesce(lower(set_code), ''),
  coalesce(lower(collector_number), ''),
  lower(language),
  coalesce(lower(finish), ''),
  coalesce(lower(variant), ''),
  coalesce(lower(edition), '')
);

create index card_catalog_user_game_idx on card_catalog (user_id, game);
create index card_catalog_name_trgm_idx on card_catalog using gin (name gin_trgm_ops);

create trigger card_catalog_updated before update on card_catalog
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- catalog_identifiers — external IDs for a catalog card (one row per provider)
-- ---------------------------------------------------------------------------

create table catalog_identifiers (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  catalog_card_id  uuid not null references card_catalog(id) on delete cascade,

  provider         text not null,     -- 'tcgdex' | 'scryfall' | 'tcgplayer' | 'cardmarket'
  external_id      text not null,
  external_url     text,

  created_at       timestamptz not null default now()
);

create unique index catalog_identifiers_uniq
  on catalog_identifiers (catalog_card_id, provider, external_id);
create index catalog_identifiers_lookup_idx
  on catalog_identifiers (user_id, provider, external_id);

-- ---------------------------------------------------------------------------
-- inventory_items — a PHYSICAL copy (or stack of identical copies) that I own
-- ---------------------------------------------------------------------------

create table inventory_items (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  catalog_card_id    uuid references card_catalog(id) on delete restrict,

  kind               item_kind not null default 'raw_single',
  sku                text,
  status             inventory_status not null default 'in_stock',

  -- Quantity ledger. quantity_available is GENERATED, so the database itself
  -- makes overselling and double-allocation structurally impossible: any write
  -- that would drive it below zero violates the CHECK and aborts.
  quantity           integer not null default 1 check (quantity >= 0),
  quantity_sold      integer not null default 0 check (quantity_sold >= 0),
  quantity_allocated integer not null default 0 check (quantity_allocated >= 0),
  quantity_available integer generated always as
                       (quantity - quantity_sold - quantity_allocated) stored,

  condition          card_condition not null default 'NEEDS_REVIEW',
  condition_notes    text,
  -- Structured defect flags: whitening, scratches, creases, edge_wear, etc.
  defects            jsonb not null default '{}'::jsonb,

  -- Graded slab fields. Enforced mutually consistent by a CHECK below.
  grading_company    text,
  grade              numeric(4,1),
  cert_number        text,
  grade_verified     boolean not null default false,

  currency           char(3) not null default 'USD',
  purchase_cost_cents       integer check (purchase_cost_cents >= 0),
  acquisition_date          date,
  acquisition_source        text,

  -- Seller-controlled prices. Deliberately separate columns from any
  -- provider-sourced value, so refreshing market data can never overwrite them.
  asking_price_cents        integer check (asking_price_cents >= 0),
  minimum_price_cents       integer check (minimum_price_cents >= 0),
  market_value_cents        integer check (market_value_cents >= 0), -- computed comp
  market_value_override_cents integer check (market_value_override_cents >= 0),
  market_value_confidence   confidence_level,
  market_value_method       text,
  last_price_refresh_at     timestamptz,

  storage_location   text,
  notes              text,

  listed_at          timestamptz,
  sold_at            timestamptz,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint inventory_available_nonneg check (quantity - quantity_sold - quantity_allocated >= 0),
  constraint inventory_min_le_ask check (
    minimum_price_cents is null
    or asking_price_cents is null
    or minimum_price_cents <= asking_price_cents
  ),
  -- A graded slab must name its grading company and grade; a raw single must not.
  constraint inventory_grade_consistency check (
    (kind = 'graded_slab' and grading_company is not null and grade is not null)
    or (kind <> 'graded_slab' and grading_company is null and grade is null and cert_number is null)
  ),
  -- A unique physical object cannot be a stack.
  constraint inventory_unique_items_single check (
    kind <> 'graded_slab' or quantity = 1
  )
);

create unique index inventory_items_sku_uniq
  on inventory_items (user_id, sku) where sku is not null;
create unique index inventory_items_cert_uniq
  on inventory_items (user_id, grading_company, cert_number)
  where cert_number is not null;
create index inventory_items_user_status_idx on inventory_items (user_id, status);
create index inventory_items_catalog_idx on inventory_items (catalog_card_id);
create index inventory_items_stale_price_idx
  on inventory_items (user_id, last_price_refresh_at nulls first);

create trigger inventory_items_updated before update on inventory_items
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- inventory_images — MY photographs. Never overwritten with catalog stock art.
-- ---------------------------------------------------------------------------

create table inventory_images (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  inventory_item_id uuid not null references inventory_items(id) on delete cascade,

  storage_path      text not null,      -- path within the private storage bucket
  face              text not null default 'front' check (face in ('front','back','detail','slab','other')),
  sort_order        integer not null default 0,
  width             integer,
  height            integer,
  bytes             integer,

  created_at        timestamptz not null default now()
);

create index inventory_images_item_idx on inventory_images (inventory_item_id, sort_order);
create unique index inventory_images_path_uniq on inventory_images (storage_path);

-- ---------------------------------------------------------------------------
-- Lots — a bundle of specific physical cards sold as one unit
-- ---------------------------------------------------------------------------

create table inventory_lots (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,

  title          text not null,
  description    text,
  game           tcg_game,
  status         inventory_status not null default 'in_stock',

  currency       char(3) not null default 'USD',
  asking_price_cents  integer check (asking_price_cents >= 0),
  minimum_price_cents integer check (minimum_price_cents >= 0),

  card_count     integer check (card_count >= 0),
  storage_location text,
  notes          text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index inventory_lots_user_idx on inventory_lots (user_id, status);

create trigger inventory_lots_updated before update on inventory_lots
  for each row execute function set_updated_at();

create table inventory_lot_items (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  lot_id            uuid not null references inventory_lots(id) on delete cascade,
  inventory_item_id uuid not null references inventory_items(id) on delete restrict,

  quantity          integer not null default 1 check (quantity > 0),
  created_at        timestamptz not null default now()
);

-- A given physical item appears at most once per lot.
create unique index inventory_lot_items_uniq
  on inventory_lot_items (lot_id, inventory_item_id);
create index inventory_lot_items_item_idx on inventory_lot_items (inventory_item_id);

-- ---------------------------------------------------------------------------
-- price_observations — append-only record of every price we were ever told.
-- Nothing in this table is ever updated; a refresh inserts new rows. This is
-- what makes "changing my override must not erase pricing history" true by
-- construction rather than by convention.
-- ---------------------------------------------------------------------------

create table price_observations (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  catalog_card_id  uuid references card_catalog(id) on delete cascade,
  inventory_item_id uuid references inventory_items(id) on delete cascade,

  provider         text not null,          -- 'tcgdex' | 'scryfall' | 'manual' | ...
  claim_type       price_claim_type not null,
  external_id      text,
  source_url       text,

  price_cents      integer check (price_cents >= 0),
  currency         char(3) not null default 'USD',

  -- What exactly was this price FOR? Used to reject mismatched comps.
  condition        card_condition,
  grading_company  text,
  grade            numeric(4,1),
  finish           text,
  variant          text,

  -- For 'sold_observation' this is the date the transaction completed.
  observed_at      timestamptz,
  -- When we fetched it.
  retrieved_at     timestamptz not null default now(),
  status           retrieval_status not null default 'ok',
  notes            text,
  raw              jsonb,

  created_at       timestamptz not null default now(),

  -- An individual sold observation is meaningless without a date. Aggregates
  -- and estimates are snapshots and legitimately have none.
  constraint price_sold_needs_date check (
    claim_type <> 'sold_observation' or observed_at is not null
  ),
  constraint price_ok_needs_amount check (
    status <> 'ok' or price_cents is not null
  )
);

create index price_obs_card_idx on price_observations (catalog_card_id, claim_type, observed_at desc);
create index price_obs_item_idx on price_observations (inventory_item_id, retrieved_at desc);
create index price_obs_user_idx on price_observations (user_id, retrieved_at desc);

-- Deduplicate the same real transaction arriving from two providers.
create unique index price_obs_sale_dedupe
  on price_observations (user_id, provider, external_id)
  where external_id is not null and claim_type = 'sold_observation';

-- ---------------------------------------------------------------------------
-- pricing_settings — how asking prices are derived, per user
-- ---------------------------------------------------------------------------

create table pricing_settings (
  user_id                uuid primary key references auth.users(id) on delete cascade,

  default_currency       char(3) not null default 'USD',
  -- 'manual' | 'market' | 'market_plus_percent' | 'market_plus_fixed'
  asking_price_strategy  text not null default 'manual',
  markup_percent         numeric(6,2) not null default 0,
  markup_fixed_cents     integer not null default 0,
  target_profit_percent  numeric(6,2),

  -- Days after which a price is shown as stale.
  stale_after_days       integer not null default 14 check (stale_after_days > 0),
  -- Minimum number of sold observations required before a comp is labelled
  -- anything better than 'low' confidence.
  min_sales_for_comp     integer not null default 3 check (min_sales_for_comp > 0),
  max_sales_for_comp     integer not null default 4 check (max_sales_for_comp > 0),

  -- Operator-defined condition adjustments applied ONLY when condition-specific
  -- provider data is unavailable. Always surfaced as a derived estimate.
  condition_adjustments  jsonb not null default '{}'::jsonb,
  apply_condition_adjustments boolean not null default false,

  updated_at             timestamptz not null default now(),
  constraint pricing_comp_window check (max_sales_for_comp >= min_sales_for_comp)
);

create trigger pricing_settings_updated before update on pricing_settings
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Marketplaces
-- ---------------------------------------------------------------------------

create table marketplace_accounts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,

  marketplace   text not null check (marketplace in ('ebay','facebook','mercari')),
  display_name  text,
  -- Connection state only. No tokens are ever stored in this table; OAuth
  -- material lives server-side in Supabase Vault / edge function secrets.
  is_connected  boolean not null default false,
  connected_at  timestamptz,
  -- Why a marketplace is unavailable, e.g. 'no_public_api'.
  capability    text not null default 'manual_only'
                check (capability in ('manual_only','api_publish')),
  last_error    text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index marketplace_accounts_uniq on marketplace_accounts (user_id, marketplace);

create trigger marketplace_accounts_updated before update on marketplace_accounts
  for each row execute function set_updated_at();

create table marketplace_listings (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  inventory_item_id uuid references inventory_items(id) on delete cascade,
  lot_id            uuid references inventory_lots(id) on delete cascade,

  marketplace       text not null check (marketplace in ('ebay','facebook','mercari')),
  status            listing_status not null default 'draft',

  title             text,
  description       text,
  category          text,
  item_specifics    jsonb not null default '{}'::jsonb,
  condition_text    text,
  keywords          text[],
  photo_order       uuid[],
  shipping_notes    text,

  currency          char(3) not null default 'USD',
  price_cents       integer check (price_cents >= 0),

  -- Only ever populated by a real, confirmed response from the platform.
  external_listing_id text,
  published_url     text,
  published_at      timestamptz,
  last_synced_at    timestamptz,
  last_error        text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- Exactly one of item / lot.
  constraint listing_targets_one check (
    (inventory_item_id is not null) <> (lot_id is not null)
  ),
  -- A listing may not claim to be published without evidence from the platform.
  constraint listing_published_needs_proof check (
    status <> 'published' or (external_listing_id is not null and published_at is not null)
  )
);

create unique index marketplace_listings_item_uniq
  on marketplace_listings (inventory_item_id, marketplace)
  where inventory_item_id is not null;
create unique index marketplace_listings_lot_uniq
  on marketplace_listings (lot_id, marketplace)
  where lot_id is not null;
create index marketplace_listings_user_status_idx on marketplace_listings (user_id, status);

create trigger marketplace_listings_updated before update on marketplace_listings
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Sales, expenses, ledger
-- ---------------------------------------------------------------------------

create table sales (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,

  channel         text not null default 'manual'
                  check (channel in ('ebay','facebook','mercari','card_show','manual','other')),
  sold_at         timestamptz not null default now(),
  buyer_note      text,

  currency        char(3) not null default 'USD',
  sale_price_cents      integer not null check (sale_price_cents >= 0),
  shipping_charged_cents integer not null default 0 check (shipping_charged_cents >= 0),
  marketplace_fee_cents  integer not null default 0 check (marketplace_fee_cents >= 0),
  shipping_cost_cents    integer not null default 0 check (shipping_cost_cents >= 0),
  packaging_cost_cents   integer not null default 0 check (packaging_cost_cents >= 0),
  other_fee_cents        integer not null default 0 check (other_fee_cents >= 0),
  refund_cents           integer not null default 0 check (refund_cents >= 0),

  -- Flagged when two sales land against the same item close together.
  needs_review    boolean not null default false,
  review_reason   text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index sales_user_date_idx on sales (user_id, sold_at desc);

create trigger sales_updated before update on sales
  for each row execute function set_updated_at();

create table sale_items (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  sale_id           uuid not null references sales(id) on delete cascade,
  inventory_item_id uuid references inventory_items(id) on delete restrict,
  lot_id            uuid references inventory_lots(id) on delete restrict,

  quantity          integer not null default 1 check (quantity > 0),
  -- Snapshot of cost at time of sale, so later edits to the item do not
  -- retroactively rewrite historical profit.
  unit_cost_cents   integer check (unit_cost_cents >= 0),
  unit_price_cents  integer check (unit_price_cents >= 0),

  created_at        timestamptz not null default now(),

  constraint sale_item_targets_one check (
    (inventory_item_id is not null) <> (lot_id is not null)
  )
);

create index sale_items_sale_idx on sale_items (sale_id);
create index sale_items_item_idx on sale_items (inventory_item_id);

-- A unique physical object can only be sold once. Enforced for graded slabs,
-- whose quantity is constrained to 1 above.
create unique index sale_items_unique_item_once
  on sale_items (inventory_item_id)
  where inventory_item_id is not null and quantity = 1;

create table expenses (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,

  incurred_on   date not null default current_date,
  category      text not null default 'other',
  description   text,
  currency      char(3) not null default 'USD',
  amount_cents  integer not null check (amount_cents >= 0),

  created_at    timestamptz not null default now()
);

create index expenses_user_date_idx on expenses (user_id, incurred_on desc);

-- Append-only audit trail of every quantity change.
create table inventory_movements (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  inventory_item_id uuid not null references inventory_items(id) on delete cascade,

  reason            movement_reason not null,
  quantity_delta    integer not null,
  sale_id           uuid references sales(id) on delete set null,
  lot_id            uuid references inventory_lots(id) on delete set null,
  note              text,

  created_at        timestamptz not null default now()
);

create index inventory_movements_item_idx on inventory_movements (inventory_item_id, created_at desc);

-- Idempotency ledger for outbound publishing, so a retry cannot double-post.
create table publishing_jobs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  listing_id      uuid not null references marketplace_listings(id) on delete cascade,

  idempotency_key text not null,
  operation       text not null check (operation in ('create','update','end')),
  status          text not null default 'pending'
                  check (status in ('pending','running','succeeded','failed')),
  attempts        integer not null default 0,
  last_error      text,
  request         jsonb,
  response        jsonb,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index publishing_jobs_idem_uniq on publishing_jobs (user_id, idempotency_key);
create index publishing_jobs_listing_idx on publishing_jobs (listing_id, created_at desc);

create trigger publishing_jobs_updated before update on publishing_jobs
  for each row execute function set_updated_at();
