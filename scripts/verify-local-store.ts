/**
 * Local (IndexedDB) backend tests.
 *
 * The point of this harness is parity. The Postgres schema enforces a set of
 * invariants with CHECK constraints and unique indexes; the browser backend
 * has none of that machinery and must reproduce every one of them in
 * JavaScript. Each assertion below mirrors a check in verify-schema.mjs, so
 * the two backends are held to the same standard rather than one being a
 * quietly weaker version of the other.
 *
 * Run: npm run verify:local
 */

// fake-indexeddb must be installed before the store module is imported,
// because opening the database happens lazily but the globals are read then.
import 'fake-indexeddb/auto';

// Minimal browser globals the store touches in Node.
const memory = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => void memory.set(k, v),
    removeItem: (k: string) => void memory.delete(k),
  },
  configurable: true,
});
Object.defineProperty(globalThis, 'navigator', {
  value: { storage: undefined },
  configurable: true,
});
(globalThis as { URL: typeof URL }).URL.createObjectURL = () => 'blob:stub';
(globalThis as { URL: typeof URL }).URL.revokeObjectURL = () => {};

const { LocalStore } = await import('../src/lib/store/local');
const { RuleViolation } = await import('../src/lib/store/rules');
const { formatMoney } = await import('../src/lib/money');
const { saleTotals } = await import('../src/lib/profit');
type CardCandidate = import('../src/providers/types').CardCandidate;

let passed = 0;
const failures: string[] = [];

function ok(name: string) {
  passed++;
  console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
}
function fail(name: string, detail = '') {
  failures.push(name);
  console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? `\n       ${detail}` : ''}`);
}

async function allows(name: string, fn: () => Promise<unknown>) {
  try { await fn(); ok(name); }
  catch (e) { fail(name, `expected success, got: ${(e as Error).message}`); }
}

async function rejects(name: string, fn: () => Promise<unknown>, expect?: RegExp) {
  try {
    await fn();
    fail(name, 'expected this to be rejected, but it succeeded');
  } catch (e) {
    // Defensive: a thrown null would otherwise crash the harness rather than
    // reporting a failure, which is how the IndexedDB error-propagation bug
    // first surfaced.
    const msg = e instanceof Error ? e.message : String(e);
    if (e == null) fail(name, 'rejected with null — the real error was lost in transit');
    else if (expect && !expect.test(msg)) fail(name, `rejected for the wrong reason: ${msg}`);
    else ok(name);
  }
}

const store = new LocalStore();

const candidate = (over: Partial<CardCandidate> = {}): CardCandidate => ({
  providerId: 'tcgdex',
  externalId: 'sv03.5-199',
  game: 'pokemon',
  name: 'Charizard ex',
  setName: '151',
  setCode: 'sv03.5',
  collectorNumber: '199',
  language: 'en',
  finish: 'Holofoil',
  ...over,
});

async function main() {
  const userId = await store.currentUserId();
  console.log(`\nLocal store ready (implicit user ${userId.slice(0, 8)}…)\n`);

  // --- Catalog identity --------------------------------------------------
  console.log('Catalog identity:');
  const cardA = await store.ensureCatalogCard(candidate(), userId);
  ok('catalog card created');

  const cardAgain = await store.ensureCatalogCard(candidate(), userId);
  if (cardAgain.id === cardA.id) ok('the same printing resolves to the same catalog row');
  else fail('the same printing resolves to the same catalog row', 'a duplicate was created');

  const reverse = await store.ensureCatalogCard(
    candidate({ finish: 'Reverse Holofoil' }), userId
  );
  if (reverse.id !== cardA.id) ok('a different finish is a distinct catalog row');
  else fail('a different finish is a distinct catalog row', 'they collapsed into one');

  const ext = await store.externalIdFor(cardA.id, 'tcgdex');
  if (ext === 'sv03.5-199') ok('the provider external id is recorded');
  else fail('the provider external id is recorded', `got ${ext}`);

  // --- Inventory invariants ----------------------------------------------
  console.log('\nInventory safety constraints:');
  const raw = await store.createInventoryItem({
    catalogCardId: cardA.id, kind: 'raw_single', condition: 'LP',
    quantity: 3, currency: 'USD', purchaseCostCents: 12000,
  }, userId);
  ok('raw single created');

  if (raw.quantity_available === 3) ok('quantity_available computes to 3');
  else fail('quantity_available computes to 3', `got ${raw.quantity_available}`);

  await rejects(
    'cannot sell more copies than are owned',
    () => store.updateInventoryItem(raw.id, { quantity_sold: 4 }),
    /more than you own|available/i
  );

  await allows('selling 2 of 3 is permitted',
    () => store.updateInventoryItem(raw.id, { quantity_sold: 2 }));

  const after = await store.getInventoryItem(raw.id);
  if (after?.quantity_available === 1) ok('quantity_available recomputes to 1');
  else fail('quantity_available recomputes to 1', `got ${after?.quantity_available}`);

  await rejects(
    'cannot then allocate 2 more to a lot',
    () => store.updateInventoryItem(raw.id, { quantity_allocated: 2 }),
    /more than you own|available/i
  );

  await rejects(
    'minimum price above asking price is rejected',
    () => store.updateInventoryItem(raw.id, {
      asking_price_cents: 5000, minimum_price_cents: 9000,
    }),
    /minimum/i
  );

  await rejects(
    'a graded slab without a grade is rejected',
    () => store.createInventoryItem({
      catalogCardId: cardA.id, kind: 'graded_slab', condition: 'NM',
      quantity: 1, currency: 'USD', purchaseCostCents: null, gradingCompany: 'PSA',
    }, userId),
    /grading company and a numeric grade/i
  );

  await rejects(
    'a raw single carrying a grade is rejected',
    () => store.createInventoryItem({
      catalogCardId: cardA.id, kind: 'raw_single', condition: 'NM',
      quantity: 1, currency: 'USD', purchaseCostCents: null,
      gradingCompany: 'PSA', grade: 10,
    }, userId),
    /Only a graded slab/i
  );

  await rejects(
    'a slab with quantity 2 is rejected',
    () => store.createInventoryItem({
      catalogCardId: cardA.id, kind: 'graded_slab', condition: 'NM',
      quantity: 2, currency: 'USD', purchaseCostCents: null,
      gradingCompany: 'PSA', grade: 9,
    }, userId),
    /unique object/i
  );

  await allows('a well-formed PSA 10 slab is accepted', () =>
    store.createInventoryItem({
      catalogCardId: cardA.id, kind: 'graded_slab', condition: 'NM',
      quantity: 1, currency: 'USD', purchaseCostCents: 30000,
      gradingCompany: 'PSA', grade: 10, certNumber: '12345678',
    }, userId));

  await rejects(
    'the same certification number cannot be entered twice',
    () => store.createInventoryItem({
      catalogCardId: cardA.id, kind: 'graded_slab', condition: 'NM',
      quantity: 1, currency: 'USD', purchaseCostCents: 31000,
      gradingCompany: 'PSA', grade: 10, certNumber: '12345678',
    }, userId),
    /already in your inventory|certification/i
  );

  // --- Pricing integrity --------------------------------------------------
  console.log('\nPricing claim integrity:');
  const retrievedAt = new Date().toISOString();

  await rejects(
    'a sold observation without a sale date is rejected',
    () => store.recordPriceObservations([{
      provider: 'ebay', claimType: 'sold_observation', priceCents: 20000,
      currency: 'USD', retrievedAt, status: 'ok',
    }], { userId, inventoryItemId: raw.id }),
    /must have a sale date/i
  );

  await allows('a market estimate without a date is fine', () =>
    store.recordPriceObservations([{
      provider: 'tcgdex', claimType: 'market_estimate', priceCents: 32463,
      currency: 'USD', retrievedAt, status: 'ok',
    }], { userId, inventoryItemId: raw.id, catalogCardId: cardA.id }));

  const sale = {
    provider: 'manual' as const, claimType: 'sold_observation' as const,
    priceCents: 20000, currency: 'USD', observedAt: new Date().toISOString(),
    retrievedAt, status: 'ok' as const, externalId: 'sale-001',
  };
  await allows('a dated sold observation is accepted', () =>
    store.recordPriceObservations([sale], { userId, inventoryItemId: raw.id }));

  await store.recordPriceObservations([sale], { userId, inventoryItemId: raw.id });
  const obs = await store.getPriceObservations({ inventoryItemId: raw.id });
  const soldCount = obs.filter((o) => o.externalId === 'sale-001').length;
  if (soldCount === 1) ok('the same transaction is not counted twice');
  else fail('the same transaction is not counted twice', `found ${soldCount} copies`);

  if (obs.length === 2) ok('both observations are retrievable');
  else fail('both observations are retrievable', `got ${obs.length}`);

  // --- Settings -----------------------------------------------------------
  console.log('\nPricing settings:');
  const settings = await store.getPricingSettings(userId);
  const expected = { LP: 85, MP: 70, HP: 50, DMG: 30 };
  const adjMatches = Object.entries(expected)
    .every(([k, v]) => settings.condition_adjustments[k] === v);
  if (adjMatches && settings.apply_condition_adjustments) {
    ok('condition adjustments match the Supabase defaults');
  } else {
    fail('condition adjustments match the Supabase defaults',
      JSON.stringify(settings.condition_adjustments));
  }

  await rejects(
    'a fractional typo like 0.7 is rejected',
    () => store.updatePricingSettings(userId, { condition_adjustments: { MP: 0.7 } }),
    /between 1 and 100/i
  );
  await rejects(
    'a percentage above 100 is rejected',
    () => store.updatePricingSettings(userId, { condition_adjustments: { MP: 170 } }),
    /between 1 and 100/i
  );
  await rejects(
    'adjusting Near Mint is rejected',
    () => store.updatePricingSettings(userId, { condition_adjustments: { NM: 90 } }),
    /anchor/i
  );
  await allows('valid percentages are accepted', () =>
    store.updatePricingSettings(userId, { condition_adjustments: { LP: 85, MP: 70 } }));

  // --- Listing and filtering ---------------------------------------------
  console.log('\nInventory listing:');
  const all = await store.listInventory();
  if (all.length === 2) ok('both live items are listed');
  else fail('both live items are listed', `got ${all.length}`);

  const slabs = await store.listInventory({ kind: 'graded_slab' });
  if (slabs.length === 1) ok('filtering by kind works');
  else fail('filtering by kind works', `got ${slabs.length}`);

  const found = await store.listInventory({ search: 'charizard' });
  if (found.length === 2) ok('free-text search matches the catalog name');
  else fail('free-text search matches the catalog name', `got ${found.length}`);

  const byCert = await store.listInventory({ search: '12345678' });
  if (byCert.length === 1) ok('search finds a slab by certification number');
  else fail('search finds a slab by certification number', `got ${byCert.length}`);

  const none = await store.listInventory({ game: 'mtg' });
  if (none.length === 0) ok('filtering by a different game returns nothing');
  else fail('filtering by a different game returns nothing', `got ${none.length}`);

  await store.removeInventoryItem(raw.id);
  const afterRemove = await store.listInventory();
  if (afterRemove.length === 1) ok('a removed item drops out of the default list');
  else fail('a removed item drops out of the default list', `got ${afterRemove.length}`);

  const removed = await store.listInventory({ status: 'removed' });
  if (removed.length === 1) ok('but is still retrievable, so history survives');
  else fail('but is still retrievable, so history survives', `got ${removed.length}`);

  // --- Totals -------------------------------------------------------------
  console.log('\nDashboard totals:');
  const totals = await store.dashboardTotals();
  if (totals.itemCount === 1 && totals.totalCostCents === 30000) {
    ok(`totals exclude removed items (${formatMoney(totals.totalCostCents)} cost)`);
  } else {
    fail('totals exclude removed items',
      `${totals.itemCount} items, ${formatMoney(totals.totalCostCents)}`);
  }

  // --- Sales --------------------------------------------------------------
  //
  // Mirrors the Postgres-side checks in verify-schema.mjs, including the
  // regression guard that fungible stock can be sold more than once.
  console.log('\nSales and duplicate prevention:');

  const fungible = await store.createInventoryItem({
    catalogCardId: cardA.id, kind: 'raw_single', condition: 'NM',
    quantity: 3, currency: 'USD', purchaseCostCents: 1000,
  }, userId);

  const slab = await store.createInventoryItem({
    catalogCardId: reverse.id, kind: 'graded_slab', condition: 'NM',
    quantity: 1, currency: 'USD', purchaseCostCents: 20000,
    gradingCompany: 'PSA', grade: 10, certNumber: '99887766',
  }, userId);

  const baseSale = {
    channel: 'ebay' as const, currency: 'USD',
    soldAt: new Date('2026-09-01T12:00:00Z').toISOString(),
  };

  await allows('selling one of three copies is permitted', () =>
    store.recordSale({
      ...baseSale, salePriceCents: 1500, marketplaceFeeCents: 200,
      items: [{ inventoryItemId: fungible.id, quantity: 1 }],
    }, userId));

  const afterOne = await store.getInventoryItem(fungible.id);
  if (afterOne?.quantity_available === 2 && afterOne.status === 'in_stock') {
    ok('inventory decrements to 2 available and stays in stock');
  } else {
    fail('inventory decrements to 2 available and stays in stock',
      `available=${afterOne?.quantity_available} status=${afterOne?.status}`);
  }

  await allows('selling a SECOND copy of the same card is also permitted', () =>
    store.recordSale({
      ...baseSale, soldAt: new Date('2026-09-05T12:00:00Z').toISOString(),
      salePriceCents: 1400,
      items: [{ inventoryItemId: fungible.id, quantity: 1 }],
    }, userId));

  await rejects(
    'selling more copies than remain is rejected',
    () => store.recordSale({
      ...baseSale, soldAt: new Date('2026-09-06T12:00:00Z').toISOString(),
      salePriceCents: 1400,
      items: [{ inventoryItemId: fungible.id, quantity: 5 }],
    }, userId),
    /only 1 available|available/i
  );

  await allows('the PSA 10 slab is sold once', () =>
    store.recordSale({
      ...baseSale, salePriceCents: 35000, marketplaceFeeCents: 4600,
      shippingCostCents: 500, packagingCostCents: 100,
      items: [{ inventoryItemId: slab.id, quantity: 1 }],
    }, userId));

  const soldSlab = await store.getInventoryItem(slab.id);
  if (soldSlab?.status === 'sold' && soldSlab.quantity_available === 0) {
    ok('the slab is marked sold with nothing available');
  } else {
    fail('the slab is marked sold with nothing available',
      `status=${soldSlab?.status} available=${soldSlab?.quantity_available}`);
  }

  await rejects(
    'the same slab cannot be sold a second time',
    () => store.recordSale({
      ...baseSale, channel: 'mercari', salePriceCents: 34000,
      soldAt: new Date('2026-09-10T12:00:00Z').toISOString(),
      items: [{ inventoryItemId: slab.id, quantity: 1 }],
    }, userId),
    /already been sold|twice/i
  );

  // --- Conflict flagging ---------------------------------------------------
  console.log('\nConflict detection:');
  {
    const conflictItem = await store.createInventoryItem({
      catalogCardId: cardA.id, kind: 'raw_single', condition: 'NM',
      quantity: 4, currency: 'USD', purchaseCostCents: 500,
    }, userId);

    const t0 = new Date('2026-10-01T10:00:00Z').toISOString();
    const t1 = new Date('2026-10-01T10:03:00Z').toISOString(); // 3 minutes later

    const first = await store.recordSale({
      ...baseSale, soldAt: t0, salePriceCents: 900,
      items: [{ inventoryItemId: conflictItem.id, quantity: 1 }],
    }, userId);
    if (!first.sale.needs_review) ok('a first sale is not flagged');
    else fail('a first sale is not flagged', first.sale.review_reason ?? '');

    const second = await store.recordSale({
      ...baseSale, soldAt: t1, salePriceCents: 900,
      items: [{ inventoryItemId: conflictItem.id, quantity: 1 }],
    }, userId);
    if (second.sale.needs_review && /within \d+ minutes/.test(second.sale.review_reason ?? '')) {
      ok('a second sale minutes later IS flagged for review');
    } else {
      fail('a second sale minutes later IS flagged for review',
        `needs_review=${second.sale.needs_review}`);
    }
    if (second.warnings.some((w) => /end those listings yourself/i.test(w))) {
      ok('the operator is warned that other listings cannot be ended automatically');
    } else {
      fail('the operator is warned about other listings', second.warnings.join(' | '));
    }

    // Flagged, but NOT refused — two genuine sales on one day are normal.
    const stock = await store.getInventoryItem(conflictItem.id);
    if (stock?.quantity_available === 2) ok('the flagged sale still decremented stock');
    else fail('the flagged sale still decremented stock', `available=${stock?.quantity_available}`);
  }

  // --- Profit --------------------------------------------------------------
  console.log('\nProfit arithmetic:');
  {
    const summary = await store.salesSummary();

    // Slab: 35000 gross − 20000 cost − (4600+500+100) fees = 9800 net.
    const slabSale = (await store.listSales())
      .find((s) => s.items.some((i) => i.inventory_item_id === slab.id));
    if (!slabSale) {
      fail('the slab sale is retrievable');
    } else {
      const t = saleTotals(slabSale, slabSale.items);
      if (t.grossCents === 35000 && t.costCents === 20000 && t.feesCents === 5200
          && t.netCents === 9800) {
        ok(`slab sale nets ${formatMoney(t.netCents)} (35000 − 20000 cost − 5200 fees)`);
      } else {
        fail('slab sale profit', `gross ${t.grossCents} cost ${t.costCents} ` +
          `fees ${t.feesCents} net ${t.netCents}`);
      }
      if (Math.round(t.roiPercent ?? 0) === 49) ok('slab ROI is 49%');
      else fail('slab ROI is 49%', `got ${t.roiPercent}`);
    }

    if (summary.saleCount === 5) ok(`all ${summary.saleCount} sales are summarised`);
    else fail('all sales are summarised', `got ${summary.saleCount}`);

    if (summary.needsReviewCount === 1) ok('exactly one sale is flagged for review');
    else fail('exactly one sale is flagged for review', `got ${summary.needsReviewCount}`);

    if (summary.byChannel.some((c) => c.channel === 'ebay')) ok('revenue is grouped by channel');
    else fail('revenue is grouped by channel', JSON.stringify(summary.byChannel));

    if (summary.byMonth.length === 2) ok('revenue is grouped by month');
    else fail('revenue is grouped by month', JSON.stringify(summary.byMonth.map((m) => m.month)));

    console.log(`       revenue ${formatMoney(summary.grossRevenueCents)} · ` +
      `net ${formatMoney(summary.netProfitCents)} · ROI ${summary.roiPercent?.toFixed(0)}%`);
  }

  // --- Voiding -------------------------------------------------------------
  console.log('\nVoiding a sale:');
  {
    const sales = await store.listSales();
    const target = sales.find((s) => s.items.some((i) => i.inventory_item_id === slab.id))!;
    await store.voidSale(target.id, userId);

    const restored = await store.getInventoryItem(slab.id);
    if (restored?.quantity_available === 1 && restored.status === 'in_stock') {
      ok('voiding returns the slab to stock');
    } else {
      fail('voiding returns the slab to stock',
        `available=${restored?.quantity_available} status=${restored?.status}`);
    }

    const movements = await store.listMovements(slab.id);
    if (movements.some((m) => m.reason === 'sold') && movements.some((m) => m.reason === 'returned')) {
      ok('the movement ledger keeps both the sale and its reversal');
    } else {
      fail('the movement ledger keeps both entries', movements.map((m) => m.reason).join(', '));
    }

    await allows('and the slab can then be sold again', () =>
      store.recordSale({
        ...baseSale, salePriceCents: 33000,
        soldAt: new Date('2026-10-02T12:00:00Z').toISOString(),
        items: [{ inventoryItemId: slab.id, quantity: 1 }],
      }, userId));
  }

  // --- Expenses -------------------------------------------------------------
  console.log('\nExpenses:');
  await allows('an expense is recorded', () =>
    store.recordExpense({
      incurredOn: '2026-09-02', category: 'supplies',
      description: '500 penny sleeves', currency: 'USD', amountCents: 1200,
    }, userId));

  await rejects(
    'a negative expense is rejected',
    () => store.recordExpense({
      incurredOn: '2026-09-02', category: 'supplies', currency: 'USD', amountCents: -500,
    }, userId),
    /cannot be negative/i
  );

  const exp = await store.listExpenses();
  if (exp.length === 1) ok('expenses are listed back');
  else fail('expenses are listed back', `got ${exp.length}`);

  // --- Aging ----------------------------------------------------------------
  console.log('\nInventory aging:');
  {
    const buckets = await store.inventoryAging();
    const total = buckets.reduce((a, b) => a + b.itemCount, 0);
    if (total > 0) ok(`aging report buckets ${total} unsold item(s)`);
    else fail('aging report buckets unsold items', '0 items bucketed');

    const soldOut = buckets.reduce((a, b) => a + b.itemCount, 0);
    const allItems = await store.listInventory();
    const available = allItems.filter((i) => i.quantity_available > 0).length;
    if (soldOut === available) ok('fully sold items are excluded from aging');
    else fail('fully sold items are excluded from aging', `${soldOut} vs ${available}`);
  }

  // --- Backup round trip --------------------------------------------------
  console.log('\nBackup and restore:');
  const bundle = await store.exportAll({ includePhotos: false });
  const liveItems = await store.listInventory({ status: 'all' });
  if (bundle.format === 'cardvault-backup' && bundle.items.length === liveItems.length) {
    ok(`export contains all ${bundle.items.length} items including the removed one`);
  } else {
    fail('export contains all items',
      `${bundle.items.length} exported vs ${liveItems.length} in store`);
  }
  if (bundle.version === 2 && (bundle.sales?.length ?? 0) > 0
      && (bundle.saleItems?.length ?? 0) > 0) {
    ok(`export contains ${bundle.sales!.length} sales and their lines`);
  } else {
    fail('export contains sales', `version ${bundle.version}, ${bundle.sales?.length} sales`);
  }
  if ((bundle.expenses?.length ?? 0) === 1) ok('export contains expenses');
  else fail('export contains expenses', `${bundle.expenses?.length} expenses`);
  if (bundle.observations.length === 2) ok('export contains price history');
  else fail('export contains price history', `${bundle.observations.length} observations`);

  const restored = await store.importAll(bundle, userId);
  if (restored.imported > 0) ok(`re-import of an existing backup succeeds (${restored.imported} records)`);
  else fail('re-import of an existing backup succeeds', JSON.stringify(restored));

  const afterImport = await store.listInventory({ status: 'all' });
  if (afterImport.length === liveItems.length) {
    ok('re-importing does not duplicate existing items');
  } else {
    fail('re-importing does not duplicate existing items',
      `${afterImport.length} after vs ${liveItems.length} before`);
  }
  const salesAfter = await store.listSales();
  if (salesAfter.length === bundle.sales!.length) {
    ok('re-importing does not duplicate sales');
  } else {
    fail('re-importing does not duplicate sales',
      `${salesAfter.length} after vs ${bundle.sales!.length} before`);
  }

  await rejects(
    'a file that is not a CardVault backup is refused',
    async () => {
      const { assertBundle } = await import('../src/lib/store/local');
      assertBundle({ some: 'other json' });
    },
    /not a CardVault backup/i
  );

  // --- Lots ---------------------------------------------------------------
  //
  // The property that matters: allocating a card to a lot must make it
  // unavailable everywhere else, or the same physical card gets sold twice.
  console.log('\nLots and allocation:');
  {
    const loose = await store.createInventoryItem({
      catalogCardId: cardA.id, kind: 'raw_single', condition: 'NM',
      quantity: 2, currency: 'USD', purchaseCostCents: 2500,
    }, userId);
    const single = await store.createInventoryItem({
      catalogCardId: reverse.id, kind: 'raw_single', condition: 'LP',
      quantity: 1, currency: 'USD', purchaseCostCents: 800,
    }, userId);

    const lotA = await store.createLot(
      { title: 'Test lot A', currency: 'USD' }, userId
    );
    ok('a lot is created');

    const add = await store.addItemsToLot(
      lotA.id,
      [{ inventoryItemId: loose.id, quantity: 1 },
       { inventoryItemId: single.id, quantity: 1 }],
      userId
    );
    if (add.added === 2 && add.skipped.length === 0) ok('two cards allocate to the lot');
    else fail('two cards allocate to the lot', JSON.stringify(add));

    const afterAlloc = await store.getInventoryItem(single.id);
    if (afterAlloc?.quantity_available === 0) {
      ok('an allocated single has zero available');
    } else {
      fail('an allocated single has zero available',
        `available=${afterAlloc?.quantity_available}`);
    }

    // The headline guarantee.
    const lotB = await store.createLot({ title: 'Test lot B', currency: 'USD' }, userId);
    const second = await store.addItemsToLot(
      lotB.id, [{ inventoryItemId: single.id, quantity: 1 }], userId
    );
    if (second.added === 0 && /another lot|none available/i.test(second.skipped[0]?.reason ?? '')) {
      ok('the same card cannot be allocated to a second lot');
    } else {
      fail('the same card cannot be allocated to a second lot', JSON.stringify(second));
    }

    // An allocated card must also be invisible to individual sale.
    await rejects(
      'an allocated card cannot be sold individually',
      () => store.recordSale({
        channel: 'ebay', currency: 'USD',
        soldAt: new Date('2026-10-05T12:00:00Z').toISOString(),
        salePriceCents: 1000,
        items: [{ inventoryItemId: single.id, quantity: 1 }],
      }, userId),
      /available/i
    );

    const withLines = await store.getLot(lotA.id);
    if (withLines?.totalCostCents === 3300) {
      ok('lot cost basis sums its cards ($25.00 + $8.00)');
    } else {
      fail('lot cost basis sums its cards', `got ${formatMoney(withLines?.totalCostCents)}`);
    }

    // Removing a line gives the stock back.
    await store.removeItemFromLot(withLines!.items.find(
      (l) => l.inventory_item_id === single.id
    )!.id, userId);
    const released = await store.getInventoryItem(single.id);
    if (released?.quantity_available === 1) ok('removing from a lot returns the stock');
    else fail('removing from a lot returns the stock', `available=${released?.quantity_available}`);

    // Selling the lot moves everything in it to sold.
    await store.addItemsToLot(lotA.id, [{ inventoryItemId: single.id, quantity: 1 }], userId);
    await store.updateLot(lotA.id, { asking_price_cents: 9000 });
    const lotSale = await store.recordLotSale(lotA.id, {
      channel: 'ebay', currency: 'USD',
      soldAt: new Date('2026-10-06T12:00:00Z').toISOString(),
      salePriceCents: 9000, marketplaceFeeCents: 1200,
    }, userId);
    ok('the lot sells');

    const soldLot = await store.getLot(lotA.id);
    if (soldLot?.status === 'sold') ok('the lot is marked sold');
    else fail('the lot is marked sold', `status=${soldLot?.status}`);

    const soldSingle = await store.getInventoryItem(single.id);
    if (soldSingle?.status === 'sold' && soldSingle.quantity_available === 0) {
      ok('cards in the lot are marked sold');
    } else {
      fail('cards in the lot are marked sold',
        `status=${soldSingle?.status} available=${soldSingle?.quantity_available}`);
    }

    const sale = (await store.listSales()).find((s) => s.id === lotSale.sale.id)!;
    const t = saleTotals(sale, sale.items);
    // 9000 gross − 3300 cost − 1200 fee = 4500
    if (t.netCents === 4500) ok(`lot sale nets ${formatMoney(t.netCents)}`);
    else fail('lot sale net profit', `got ${formatMoney(t.netCents)}`);

    await rejects(
      'a sold lot cannot be sold again',
      () => store.recordLotSale(lotA.id, {
        channel: 'mercari', currency: 'USD',
        soldAt: new Date().toISOString(), salePriceCents: 8000,
      }, userId),
      /already been sold/i
    );

    await rejects(
      'an empty lot cannot be sold',
      () => store.recordLotSale(lotB.id, {
        channel: 'ebay', currency: 'USD',
        soldAt: new Date().toISOString(), salePriceCents: 100,
      }, userId),
      /no cards allocated/i
    );

    // Deleting a lot must release, not strand, its stock.
    const lotC = await store.createLot({ title: 'Test lot C', currency: 'USD' }, userId);
    await store.addItemsToLot(lotC.id, [{ inventoryItemId: loose.id, quantity: 1 }], userId);
    const beforeDelete = await store.getInventoryItem(loose.id);
    await store.deleteLot(lotC.id, userId);
    const afterDelete = await store.getInventoryItem(loose.id);
    if ((afterDelete?.quantity_available ?? 0) > (beforeDelete?.quantity_available ?? 0)) {
      ok('deleting a lot releases its cards back to available');
    } else {
      fail('deleting a lot releases its cards',
        `${beforeDelete?.quantity_available} -> ${afterDelete?.quantity_available}`);
    }
  }

  // --- Marketplace listings -------------------------------------------------
  console.log('\nMarketplace listings:');
  {
    const listItem = await store.createInventoryItem({
      catalogCardId: cardA.id, kind: 'raw_single', condition: 'NM',
      quantity: 1, currency: 'USD', purchaseCostCents: 1000,
      askingPriceCents: 4500,
    }, userId);

    await store.saveListing({
      inventoryItemId: listItem.id, marketplace: 'ebay',
      title: 'Charizard ex 151 #199', description: 'Body text',
      currency: 'USD', priceCents: 4500, status: 'ready_to_publish',
    }, userId);
    ok('an eBay draft is saved');

    await store.saveListing({
      inventoryItemId: listItem.id, marketplace: 'mercari',
      title: 'Charizard ex', description: 'Body text',
      currency: 'USD', priceCents: 4300,
    }, userId);

    const all = await store.listListings({ inventoryItemId: listItem.id });
    if (all.length === 2) ok('one card can have a draft per marketplace');
    else fail('one card can have a draft per marketplace', `got ${all.length}`);

    // Regenerating must replace, not duplicate.
    await store.saveListing({
      inventoryItemId: listItem.id, marketplace: 'ebay',
      title: 'Charizard ex 151 #199 Holofoil', description: 'Updated body',
      currency: 'USD', priceCents: 4700,
    }, userId);
    const again = await store.listListings({ inventoryItemId: listItem.id });
    if (again.length === 2) ok('re-saving replaces the draft rather than duplicating it');
    else fail('re-saving replaces the draft', `got ${again.length}`);

    const ebay = again.find((l) => l.marketplace === 'ebay')!;
    if (ebay.price_cents === 4700 && ebay.title?.includes('Holofoil')) {
      ok('the replaced draft carries the new text and price');
    } else {
      fail('the replaced draft carries the new text', JSON.stringify(ebay.title));
    }
    if (ebay.card_name === 'Charizard ex') ok('listings join to their card');
    else fail('listings join to their card', `got ${ebay.card_name}`);

    // The honesty constraint.
    await rejects(
      'a listing cannot be marked Published without a real URL',
      () => store.updateListing(ebay.id, { status: 'published' }),
      /without a real listing id/i
    );

    await allows('marking posted WITH a URL is accepted', () =>
      store.updateListing(ebay.id, {
        status: 'published',
        published_url: 'https://www.ebay.com/itm/123456789',
        external_listing_id: 'https://www.ebay.com/itm/123456789',
        published_at: new Date().toISOString(),
      }));

    // A published listing must survive a regenerate.
    await store.saveListing({
      inventoryItemId: listItem.id, marketplace: 'ebay',
      title: 'Regenerated title', description: 'New body',
      currency: 'USD', priceCents: 4700,
    }, userId);
    const afterRegen = (await store.listListings({ inventoryItemId: listItem.id }))
      .find((l) => l.marketplace === 'ebay')!;
    if (afterRegen.status === 'published') {
      ok('regenerating copy does not silently un-publish a live listing');
    } else {
      fail('regenerating does not un-publish', `status=${afterRegen.status}`);
    }

    await store.deleteListing(afterRegen.id);
    const left = await store.listListings({ inventoryItemId: listItem.id });
    if (left.length === 1) ok('a draft can be deleted');
    else fail('a draft can be deleted', `got ${left.length}`);
  }

  // --- Id generation outside a secure context -----------------------------
  //
  // Regression guard. crypto.randomUUID() exists only in secure contexts
  // (HTTPS or localhost). Reaching the dev server from a phone means
  // http://192.168.x.x:5173, which is neither, so every call site threw and
  // the Scan page rendered blank on the one device this app is built for.
  console.log('\nId generation without crypto.randomUUID:');
  {
    const { newId } = await import('../src/lib/id');
    const g = globalThis as unknown as { crypto: Crypto & { randomUUID?: unknown } };
    const real = g.crypto.randomUUID;
    const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

    try {
      Object.defineProperty(g.crypto, 'randomUUID', { value: undefined, configurable: true });
      const ids = new Set(Array.from({ length: 2000 }, () => newId()));
      if ([...ids].every((i) => V4.test(i))) ok('the fallback emits valid v4 UUIDs');
      else fail('the fallback emits valid v4 UUIDs', [...ids][0]);
      if (ids.size === 2000) ok('2000 generated ids are all unique');
      else fail('2000 generated ids are all unique', `${ids.size} distinct`);
    } finally {
      Object.defineProperty(g.crypto, 'randomUUID', { value: real, configurable: true });
    }

    if (V4.test(newId())) ok('the native path is still used when available');
    else fail('the native path is still used when available');
  }

  // --- Report -------------------------------------------------------------
  console.log(`\n${'-'.repeat(58)}`);
  if (failures.length === 0) {
    console.log(`\x1b[32m${passed} checks passed, 0 failed.\x1b[0m\n`);
    process.exit(0);
  }
  console.log(`\x1b[31m${passed} passed, ${failures.length} FAILED:\x1b[0m`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log();
  process.exit(1);
}

main().catch((e) => {
  console.error('\nHarness crashed:', e);
  if (e instanceof RuleViolation) console.error('(a RuleViolation escaped)');
  process.exit(1);
});
