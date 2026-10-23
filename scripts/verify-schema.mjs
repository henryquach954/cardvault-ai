/**
 * Schema verification harness.
 *
 * Runs the real migrations against an in-process Postgres (PGlite, the same
 * Postgres engine compiled to WASM) and then asserts that the safety
 * constraints actually fire. This exists because "the SQL looked right" is not
 * evidence -- a CHECK constraint that is subtly wrong fails silently by
 * allowing bad data, which is exactly the failure mode we cannot afford in an
 * inventory ledger.
 *
 * Supabase provides the `auth` and `storage` schemas at runtime; they are
 * stubbed here closely enough to exercise our own objects.
 *
 * Run: npm run verify:schema
 */
import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(root, 'supabase', 'migrations');

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

let passed = 0;
const failures = [];

function ok(name) {
  passed++;
  console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
}
function fail(name, detail) {
  failures.push({ name, detail });
  console.log(`  \x1b[31mFAIL\x1b[0m ${name}\n       ${detail}`);
}

/** Assert a statement succeeds. */
async function allows(db, name, sql, params = []) {
  try {
    await db.query(sql, params);
    ok(name);
  } catch (e) {
    fail(name, `expected success, got: ${e.message}`);
  }
}

/** Assert a statement is rejected by the database, optionally matching text. */
async function rejects(db, name, sql, params = [], expect = null) {
  try {
    await db.query(sql, params);
    fail(name, 'expected the database to reject this, but it succeeded');
  } catch (e) {
    if (expect && !new RegExp(expect, 'i').test(e.message)) {
      fail(name, `rejected, but for the wrong reason: ${e.message}`);
    } else {
      ok(name);
    }
  }
}

/** Stand in for the schemas Supabase injects. */
const SUPABASE_STUBS = `
create schema if not exists auth;
create schema if not exists storage;

create table auth.users (
  id uuid primary key,
  email text
);

-- Supabase derives the current user from a JWT claim exposed as a GUC.
create or replace function auth.uid() returns uuid
language sql stable as $fn$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$fn$;

create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text not null,
  owner uuid
);
alter table storage.objects enable row level security;

create or replace function storage.foldername(name text) returns text[]
language sql immutable as $fn$
  select string_to_array(name, '/');
$fn$;
`;

async function main() {
  console.log('\nBooting in-process Postgres (PGlite)...');
  const db = new PGlite();
  await db.waitReady;
  const { rows: [v] } = await db.query('select version()');
  console.log(`  ${v.version.split(',')[0]}\n`);

  await db.exec(SUPABASE_STUBS);
  await db.exec(
    `insert into auth.users (id, email) values
       ('${USER_A}','a@example.test'), ('${USER_B}','b@example.test')`
  );

  // --- Run the real migrations -------------------------------------------
  console.log('Applying migrations:');
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    let sql = await readFile(join(MIGRATIONS, f), 'utf8');
    // PGlite does not ship pg_trgm; the index is a search optimisation, not a
    // correctness property, so it is skipped here and verified against the
    // real project at deploy time.
    sql = sql
      .replace(/create extension if not exists pg_trgm;/g, '-- pg_trgm skipped under PGlite')
      .replace(/create index card_catalog_name_trgm_idx[^;]+;/g, '-- trgm index skipped');
    try {
      await db.exec(sql);
      console.log(`  \x1b[32mOK\x1b[0m   ${f}`);
    } catch (e) {
      console.log(`  \x1b[31mFAIL\x1b[0m ${f}\n       ${e.message}`);
      process.exit(1);
    }
  }

  // Supabase executes client queries as the non-superuser `authenticated`
  // role. This matters enormously: Postgres superusers bypass RLS outright, so
  // running these checks as the default PGlite superuser would make every
  // isolation test pass vacuously. Everything below runs as `authenticated`.
  await db.exec(`
    create role authenticated nologin;
    grant usage on schema public to authenticated;
    grant select, insert, update, delete on all tables in schema public to authenticated;
  `);

  const act = async (uid) =>
    db.exec(`
      reset role;
      set request.jwt.claim.sub = '${uid}';
      set role authenticated;
    `);
  await act(USER_A);

  // --- Structural guarantees ---------------------------------------------
  console.log('\nRow-level security:');
  const { rows: rls } = await db.query(`
    select c.relname from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
  `);
  if (rls.length === 0) ok('every public table has RLS enabled');
  else fail('every public table has RLS enabled', `missing on: ${rls.map(r => r.relname).join(', ')}`);

  const { rows: [{ count: appendOnly }] } = await db.query(`
    select count(*)::int as count from pg_policies
    where schemaname='public' and tablename in ('price_observations','inventory_movements')
      and cmd in ('UPDATE','DELETE')
  `);
  if (appendOnly === 0) ok('price history and movement ledger are append-only');
  else fail('price history and movement ledger are append-only', `${appendOnly} mutating policies exist`);

  // --- Seed a catalog card and item --------------------------------------
  console.log('\nCatalog and inventory:');
  await db.query(
    `insert into card_catalog (id, user_id, game, name, set_code, collector_number, finish)
     values ('aaaaaaaa-0000-0000-0000-000000000001', $1, 'pokemon', 'Charizard ex', 'sv03.5', '199', 'holo')`,
    [USER_A]
  );
  ok('catalog card inserted');

  await rejects(
    db,
    'duplicate printing is rejected by the identity index',
    `insert into card_catalog (user_id, game, name, set_code, collector_number, finish)
     values ($1, 'pokemon', 'Charizard ex', 'sv03.5', '199', 'holo')`,
    [USER_A],
    'duplicate key|card_catalog_identity_uniq'
  );

  await allows(
    db,
    'the same printing in a different finish is a distinct catalog row',
    `insert into card_catalog (user_id, game, name, set_code, collector_number, finish)
     values ($1, 'pokemon', 'Charizard ex', 'sv03.5', '199', 'reverse')`,
    [USER_A]
  );

  await db.query(
    `insert into inventory_items (id, user_id, catalog_card_id, kind, condition, quantity, purchase_cost_cents)
     values ('bbbbbbbb-0000-0000-0000-000000000001', $1,
             'aaaaaaaa-0000-0000-0000-000000000001', 'raw_single', 'LP', 3, 12000)`,
    [USER_A]
  );
  ok('inventory item inserted');

  const { rows: [qty] } = await db.query(
    `select quantity_available from inventory_items where id='bbbbbbbb-0000-0000-0000-000000000001'`
  );
  if (qty.quantity_available === 3) ok('quantity_available computes to 3');
  else fail('quantity_available computes to 3', `got ${qty.quantity_available}`);

  // --- The constraints that protect the ledger ---------------------------
  console.log('\nInventory safety constraints:');

  await rejects(
    db,
    'cannot sell more copies than are owned',
    `update inventory_items set quantity_sold = 4
       where id='bbbbbbbb-0000-0000-0000-000000000001'`,
    [],
    'inventory_available_nonneg|violates check'
  );

  await allows(
    db,
    'selling 2 of 3 is permitted',
    `update inventory_items set quantity_sold = 2
       where id='bbbbbbbb-0000-0000-0000-000000000001'`
  );

  await rejects(
    db,
    'cannot then allocate 2 more to a lot (only 1 remains)',
    `update inventory_items set quantity_allocated = 2
       where id='bbbbbbbb-0000-0000-0000-000000000001'`,
    [],
    'inventory_available_nonneg|violates check'
  );

  await rejects(
    db,
    'minimum price above asking price is rejected',
    `update inventory_items set asking_price_cents = 5000, minimum_price_cents = 9000
       where id='bbbbbbbb-0000-0000-0000-000000000001'`,
    [],
    'inventory_min_le_ask'
  );

  await rejects(
    db,
    'a graded slab without a grade is rejected',
    `insert into inventory_items (user_id, catalog_card_id, kind, grading_company)
     values ($1, 'aaaaaaaa-0000-0000-0000-000000000001', 'graded_slab', 'PSA')`,
    [USER_A],
    'inventory_grade_consistency'
  );

  await rejects(
    db,
    'a raw single carrying a grade is rejected',
    `insert into inventory_items (user_id, catalog_card_id, kind, grading_company, grade)
     values ($1, 'aaaaaaaa-0000-0000-0000-000000000001', 'raw_single', 'PSA', 10)`,
    [USER_A],
    'inventory_grade_consistency'
  );

  await allows(
    db,
    'a well-formed PSA 10 slab is accepted',
    `insert into inventory_items (id, user_id, catalog_card_id, kind, condition, quantity,
                                  grading_company, grade, cert_number)
     values ('bbbbbbbb-0000-0000-0000-000000000002', $1,
             'aaaaaaaa-0000-0000-0000-000000000001', 'graded_slab', 'NM', 1, 'PSA', 10, '12345678')`,
    [USER_A]
  );

  await rejects(
    db,
    'a slab with quantity 2 is rejected (a unique object is not a stack)',
    `insert into inventory_items (user_id, catalog_card_id, kind, quantity, grading_company, grade)
     values ($1, 'aaaaaaaa-0000-0000-0000-000000000001', 'graded_slab', 2, 'PSA', 9)`,
    [USER_A],
    'inventory_unique_items_single'
  );

  await rejects(
    db,
    'the same PSA certification number cannot be entered twice',
    `insert into inventory_items (user_id, catalog_card_id, kind, quantity,
                                  grading_company, grade, cert_number)
     values ($1, 'aaaaaaaa-0000-0000-0000-000000000001', 'graded_slab', 1, 'PSA', 10, '12345678')`,
    [USER_A],
    'inventory_items_cert_uniq|duplicate key'
  );

  // --- Pricing honesty ----------------------------------------------------
  console.log('\nPricing claim integrity:');

  await rejects(
    db,
    'a sold observation without a sale date is rejected',
    `insert into price_observations (user_id, catalog_card_id, provider, claim_type, price_cents)
     values ($1, 'aaaaaaaa-0000-0000-0000-000000000001', 'ebay', 'sold_observation', 20000)`,
    [USER_A],
    'price_sold_needs_date'
  );

  await allows(
    db,
    'a market estimate without a date is fine (it is a snapshot)',
    `insert into price_observations (user_id, catalog_card_id, provider, claim_type, price_cents)
     values ($1, 'aaaaaaaa-0000-0000-0000-000000000001', 'tcgdex', 'market_estimate', 32463)`,
    [USER_A]
  );

  await allows(
    db,
    'a dated sold observation is accepted',
    `insert into price_observations (user_id, catalog_card_id, provider, claim_type,
                                     external_id, price_cents, observed_at)
     values ($1, 'aaaaaaaa-0000-0000-0000-000000000001', 'manual', 'sold_observation',
             'sale-001', 20000, now() - interval '3 days')`,
    [USER_A]
  );

  await rejects(
    db,
    'the same transaction id cannot be counted twice',
    `insert into price_observations (user_id, catalog_card_id, provider, claim_type,
                                     external_id, price_cents, observed_at)
     values ($1, 'aaaaaaaa-0000-0000-0000-000000000001', 'manual', 'sold_observation',
             'sale-001', 20000, now())`,
    [USER_A],
    'price_obs_sale_dedupe|duplicate key'
  );

  // Note on mechanism: when RLS has no DELETE policy, Postgres does not raise
  // an error -- the statement simply matches zero rows. So the correct
  // assertion is that the history survives, not that the call throws.
  {
    const before = (await db.query('select count(*)::int as n from price_observations')).rows[0].n;
    await db.query('delete from price_observations');
    const after = (await db.query('select count(*)::int as n from price_observations')).rows[0].n;
    if (before > 0 && after === before) {
      ok(`price history survives a delete attempt (${after} rows intact)`);
    } else {
      fail('price history survives a delete attempt', `${before} rows before, ${after} after`);
    }
  }

  {
    const before = (await db.query(
      `select price_cents from price_observations
        where claim_type='market_estimate' limit 1`
    )).rows[0];
    await db.query(
      `update price_observations set price_cents = 1 where claim_type='market_estimate'`
    );
    const after = (await db.query(
      `select price_cents from price_observations
        where claim_type='market_estimate' limit 1`
    )).rows[0];
    if (before && after && before.price_cents === after.price_cents) {
      ok('price history cannot be rewritten by an update either');
    } else {
      fail('price history cannot be rewritten by an update either',
        `value changed from ${before?.price_cents} to ${after?.price_cents}`);
    }
  }

  // --- Listing honesty ----------------------------------------------------
  console.log('\nMarketplace listing integrity:');

  await db.query(
    `insert into marketplace_listings (id, user_id, inventory_item_id, marketplace, title, price_cents)
     values ('cccccccc-0000-0000-0000-000000000001', $1,
             'bbbbbbbb-0000-0000-0000-000000000001', 'ebay', 'Charizard ex 199/165', 35000)`,
    [USER_A]
  );
  ok('draft listing created');

  await rejects(
    db,
    'a listing cannot be marked Published without a real external id',
    `update marketplace_listings set status = 'published'
       where id = 'cccccccc-0000-0000-0000-000000000001'`,
    [],
    'listing_published_needs_proof'
  );

  await allows(
    db,
    'marking Published with platform evidence is permitted',
    `update marketplace_listings
        set status='published', external_listing_id='v1|123456789|0',
            published_url='https://www.ebay.com/itm/123456789', published_at=now()
      where id = 'cccccccc-0000-0000-0000-000000000001'`
  );

  await rejects(
    db,
    'a listing cannot target both an item and a lot',
    `insert into marketplace_listings (user_id, inventory_item_id, lot_id, marketplace)
     values ($1, 'bbbbbbbb-0000-0000-0000-000000000001',
             '00000000-0000-0000-0000-0000000000ff', 'mercari')`,
    [USER_A],
    'listing_targets_one|foreign key'
  );

  // --- Duplicate-sale prevention -----------------------------------------
  console.log('\nDuplicate-sale prevention:');

  await db.query(
    `insert into sales (id, user_id, channel, sale_price_cents)
     values ('dddddddd-0000-0000-0000-000000000001', $1, 'ebay', 35000)`,
    [USER_A]
  );
  await allows(
    db,
    'the PSA 10 slab is sold once',
    `insert into sale_items (user_id, sale_id, inventory_item_id, quantity, unit_price_cents)
     values ($1, 'dddddddd-0000-0000-0000-000000000001',
             'bbbbbbbb-0000-0000-0000-000000000002', 1, 35000)`,
    [USER_A]
  );

  await db.query(
    `insert into sales (id, user_id, channel, sale_price_cents)
     values ('dddddddd-0000-0000-0000-000000000002', $1, 'mercari', 34000)`,
    [USER_A]
  );
  await rejects(
    db,
    'the same slab cannot be sold a second time on another marketplace',
    `insert into sale_items (user_id, sale_id, inventory_item_id, quantity, unit_price_cents)
     values ($1, 'dddddddd-0000-0000-0000-000000000002',
             'bbbbbbbb-0000-0000-0000-000000000002', 1, 34000)`,
    [USER_A],
    'sale_items_unique_item_once|duplicate key'
  );

  // --- Fungible stock can be sold repeatedly ------------------------------
  //
  // Regression guard for migration 0004. The original index keyed duplicate
  // detection on `quantity = 1`, which also blocked selling a second single
  // copy of a card you own several of -- a false positive on an entirely
  // normal transaction. Only genuinely unique objects should be guarded.
  console.log('\nRepeat sales of fungible stock:');
  {
    await db.query(
      `insert into inventory_items (id, user_id, catalog_card_id, kind, condition, quantity)
       values ('bbbbbbbb-0000-0000-0000-000000000003', $1,
               'aaaaaaaa-0000-0000-0000-000000000001', 'raw_single', 'NM', 3)`,
      [USER_A]
    );
    await db.query(
      `insert into sales (id, user_id, channel, sale_price_cents)
       values ('dddddddd-0000-0000-0000-000000000003', $1, 'ebay', 1500)`,
      [USER_A]
    );
    await allows(
      db,
      'selling one copy of a three-copy card is permitted',
      `insert into sale_items (user_id, sale_id, inventory_item_id, quantity, unit_price_cents)
       values ($1, 'dddddddd-0000-0000-0000-000000000003',
               'bbbbbbbb-0000-0000-0000-000000000003', 1, 1500)`,
      [USER_A]
    );

    await db.query(
      `insert into sales (id, user_id, channel, sale_price_cents)
       values ('dddddddd-0000-0000-0000-000000000004', $1, 'mercari', 1400)`,
      [USER_A]
    );
    await allows(
      db,
      'selling a SECOND copy of the same card is also permitted',
      `insert into sale_items (user_id, sale_id, inventory_item_id, quantity, unit_price_cents)
       values ($1, 'dddddddd-0000-0000-0000-000000000004',
               'bbbbbbbb-0000-0000-0000-000000000003', 1, 1400)`,
      [USER_A]
    );

    const { rows: flags } = await db.query(
      `select distinct is_unique_item from sale_items
        where inventory_item_id = 'bbbbbbbb-0000-0000-0000-000000000003'`
    );
    if (flags.length === 1 && flags[0].is_unique_item === false) {
      ok('the trigger marks raw singles as non-unique');
    } else {
      fail('the trigger marks raw singles as non-unique', JSON.stringify(flags));
    }

    const { rows: slabFlag } = await db.query(
      `select distinct is_unique_item from sale_items
        where inventory_item_id = 'bbbbbbbb-0000-0000-0000-000000000002'`
    );
    if (slabFlag.length === 1 && slabFlag[0].is_unique_item === true) {
      ok('the trigger marks graded slabs as unique');
    } else {
      fail('the trigger marks graded slabs as unique', JSON.stringify(slabFlag));
    }

    // And the ledger still stops a genuine oversell.
    await db.query(
      `update inventory_items set quantity_sold = 2
        where id = 'bbbbbbbb-0000-0000-0000-000000000003'`
    );
    await rejects(
      db,
      'but the quantity ledger still prevents overselling the third copy twice',
      `update inventory_items set quantity_sold = 4
        where id = 'bbbbbbbb-0000-0000-0000-000000000003'`,
      [],
      'inventory_available_nonneg|violates check'
    );
  }

  // --- Expenses -----------------------------------------------------------
  console.log('\nExpenses:');
  await allows(
    db,
    'an expense is recorded',
    `insert into expenses (user_id, category, description, amount_cents)
     values ($1, 'supplies', '500 penny sleeves', 1200)`,
    [USER_A]
  );
  await rejects(
    db,
    'a negative expense is rejected',
    `insert into expenses (user_id, category, amount_cents) values ($1, 'supplies', -500)`,
    [USER_A],
    'violates check'
  );

  // --- Lot allocation -----------------------------------------------------
  console.log('\nLot allocation:');
  await db.query(
    `insert into inventory_lots (id, user_id, title) values
       ('eeeeeeee-0000-0000-0000-000000000001', $1, 'Bulk holo lot')`,
    [USER_A]
  );
  await allows(
    db,
    'an item can be allocated to a lot',
    `insert into inventory_lot_items (user_id, lot_id, inventory_item_id)
     values ($1, 'eeeeeeee-0000-0000-0000-000000000001',
             'bbbbbbbb-0000-0000-0000-000000000001')`,
    [USER_A]
  );
  await rejects(
    db,
    'the same item cannot be added to the same lot twice',
    `insert into inventory_lot_items (user_id, lot_id, inventory_item_id)
     values ($1, 'eeeeeeee-0000-0000-0000-000000000001',
             'bbbbbbbb-0000-0000-0000-000000000001')`,
    [USER_A],
    'inventory_lot_items_uniq|duplicate key'
  );

  // --- Signup seeding -----------------------------------------------------
  //
  // Regression guard. An earlier revision used FORCE ROW LEVEL SECURITY,
  // which subjects the table owner to policies and therefore blocked the
  // SECURITY DEFINER signup trigger (auth.uid() is null at that point),
  // breaking account creation entirely. This proves signup still seeds rows.
  console.log('\nSignup seeding:');
  {
    await db.exec('reset role');
    const newUser = '33333333-3333-3333-3333-333333333333';
    let signupError = null;
    try {
      await db.query(`insert into auth.users (id, email) values ($1, 'c@example.test')`, [newUser]);
    } catch (e) {
      signupError = e.message;
    }
    if (signupError) {
      fail('creating an account succeeds', signupError);
    } else {
      ok('creating an account succeeds');
      const { rows: ps } = await db.query(
        'select count(*)::int as n from pricing_settings where user_id = $1', [newUser]
      );
      const { rows: ma } = await db.query(
        'select marketplace, capability from marketplace_accounts where user_id = $1 order by marketplace',
        [newUser]
      );
      if (ps[0].n === 1) ok('default pricing settings are seeded');
      else fail('default pricing settings are seeded', `got ${ps[0].n} rows`);

      const { rows: [adj] } = await db.query(
        `select condition_adjustments as a, apply_condition_adjustments as on
           from pricing_settings where user_id = $1`, [newUser]
      );
      // Compared key-by-key: jsonb does not preserve insertion order, so a
      // JSON.stringify comparison would fail on an identical object.
      const expected = { LP: 85, MP: 70, HP: 50, DMG: 30 };
      const matches =
        adj.a &&
        Object.keys(expected).length === Object.keys(adj.a).length &&
        Object.entries(expected).every(([k, v]) => adj.a[k] === v);
      if (matches && adj.on === true) {
        ok("the operator's condition adjustments are seeded and enabled");
      } else {
        fail("the operator's condition adjustments are seeded and enabled",
          `got ${JSON.stringify(adj.a)}, enabled=${adj.on}`);
      }

      if (ma.length === 3) ok('the three marketplaces are seeded');
      else fail('the three marketplaces are seeded', `got ${ma.length}`);

      const ebay = ma.find((m) => m.marketplace === 'ebay');
      const fb = ma.find((m) => m.marketplace === 'facebook');
      if (ebay?.capability === 'api_publish' && fb?.capability === 'manual_only') {
        ok('marketplace capabilities reflect reality (eBay API, Facebook manual-only)');
      } else {
        fail('marketplace capabilities reflect reality',
          ma.map((m) => `${m.marketplace}=${m.capability}`).join(', '));
      }
    }
  }

  // --- Condition-adjustment guard rails -----------------------------------
  console.log('\nCondition adjustment guard rails:');
  await act(USER_A);
  {
    // USER_A predates the signup trigger (they were inserted before the
    // migrations ran), so they have no settings row. Without this, every
    // UPDATE below would match zero rows and "pass" while testing nothing --
    // the same vacuous-test trap as the superuser RLS bug.
    await db.query(
      `insert into pricing_settings (user_id) values ($1) on conflict (user_id) do nothing`,
      [USER_A]
    );
    const { rows: present } = await db.query(
      'select count(*)::int as n from pricing_settings where user_id = $1', [USER_A]
    );
    if (present[0].n === 1) ok('a settings row exists to constrain');
    else fail('a settings row exists to constrain', `got ${present[0].n} rows`);

    await allows(
      db,
      'valid percentages are accepted',
      `update pricing_settings
          set condition_adjustments = '{"LP": 85, "MP": 70, "HP": 50, "DMG": 30}'::jsonb
        where user_id = $1`,
      [USER_A]
    );
    // The realistic typo: entering 0.85 instead of 85 would price a $300 card
    // at under three cents.
    await rejects(
      db,
      'a fractional typo like 0.85 is rejected',
      `update pricing_settings set condition_adjustments = '{"MP": 0.7}'::jsonb
        where user_id = $1`,
      [USER_A],
      'pricing_condition_adjustments_sane'
    );
    await rejects(
      db,
      'a percentage above 100 is rejected',
      `update pricing_settings set condition_adjustments = '{"MP": 170}'::jsonb
        where user_id = $1`,
      [USER_A],
      'pricing_condition_adjustments_sane'
    );
    await rejects(
      db,
      'adjusting Near Mint is rejected — it is the anchor',
      `update pricing_settings set condition_adjustments = '{"NM": 90}'::jsonb
        where user_id = $1`,
      [USER_A],
      'pricing_condition_adjustments_sane'
    );
    await allows(
      db,
      'clearing all adjustments is allowed',
      `update pricing_settings set condition_adjustments = '{}'::jsonb where user_id = $1`,
      [USER_A]
    );
  }

  // --- Tenant isolation ---------------------------------------------------
  console.log('\nTenant isolation:');
  await act(USER_B);
  const { rows: leaked } = await db.query('select count(*)::int as n from inventory_items');
  if (leaked[0].n === 0) ok("user B cannot see any of user A's inventory");
  else fail("user B cannot see any of user A's inventory", `saw ${leaked[0].n} rows`);

  const { rows: leakedPhotos } = await db.query('select count(*)::int as n from price_observations');
  if (leakedPhotos[0].n === 0) ok("user B cannot see user A's pricing data");
  else fail("user B cannot see user A's pricing data", `saw ${leakedPhotos[0].n} rows`);

  await rejects(
    db,
    "user B cannot write a row owned by user A",
    `insert into expenses (user_id, amount_cents) values ($1, 500)`,
    [USER_A],
    'policy|row-level'
  );

  // --- Report -------------------------------------------------------------
  console.log(`\n${'-'.repeat(58)}`);
  if (failures.length === 0) {
    console.log(`\x1b[32m${passed} checks passed, 0 failed.\x1b[0m\n`);
    process.exit(0);
  }
  console.log(`\x1b[31m${passed} passed, ${failures.length} FAILED:\x1b[0m`);
  for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
  console.log();
  process.exit(1);
}

main().catch((e) => {
  console.error('\nHarness crashed:', e);
  process.exit(1);
});
