/**
 * Valuation engine tests.
 *
 * Includes the worked example from the specification: sales of $180, $195,
 * $205 and $220 must produce a comp of exactly $200.00.
 *
 * Run: npm run verify:valuation
 */
import {
  computeComp,
  summariseEstimates,
  suggestAskingPrice,
  DEFAULT_COMP_SETTINGS,
  type CompTarget,
} from '../src/lib/valuation';
import { formatMoney, parseMoney, netProfitCents, roiPercent } from '../src/lib/money';
import { inventoryAging, marginPercent, saleTotals } from '../src/lib/profit';
import { MARKETPLACES, generateListing, templateFor } from '../src/lib/listing';
import type { PriceClaim, PriceClaimType } from '../src/providers/types';

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`); }
  else { failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m ${name}\n       ${detail}`); }
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function sale(
  dollars: number,
  ageDays: number,
  extra: Partial<PriceClaim> = {}
): PriceClaim {
  return {
    provider: 'manual',
    claimType: 'sold_observation',
    priceCents: Math.round(dollars * 100),
    currency: 'USD',
    observedAt: daysAgo(ageDays),
    retrievedAt: new Date().toISOString(),
    status: 'ok',
    ...extra,
  };
}

function claim(type: PriceClaimType, dollars: number, extra: Partial<PriceClaim> = {}): PriceClaim {
  return {
    provider: 'tcgdex',
    claimType: type,
    priceCents: Math.round(dollars * 100),
    currency: 'USD',
    retrievedAt: new Date().toISOString(),
    status: 'ok',
    ...extra,
  };
}

const PSA10: CompTarget = { currency: 'USD', gradingCompany: 'PSA', grade: 10 };
const graded = (d: number, age: number, company = 'PSA', grade = 10) =>
  sale(d, age, { gradingCompany: company, grade });

console.log('\n=== The worked example from the brief ===');
{
  const r = computeComp(
    [graded(180, 10), graded(195, 8), graded(205, 5), graded(220, 2)],
    PSA10
  );
  check('four sales average to exactly $200.00',
    r.estimateCents === 20000, `got ${formatMoney(r.estimateCents)}`);
  check('reports that 4 sales were used', r.salesUsed.length === 4);
  check('median is reported', r.medianCents === 20000, `got ${formatMoney(r.medianCents)}`);
  check('range is reported', r.lowCents === 18000 && r.highCents === 22000);
  check('confidence is high for 4 tight recent sales',
    r.confidence === 'high', `got ${r.confidence}`);
  console.log(`       ${formatMoney(r.estimateCents)} · ${r.method} · confidence ${r.confidence}`);
  console.log(`       median ${formatMoney(r.medianCents)}, range ` +
    `${formatMoney(r.lowCents)}–${formatMoney(r.highCents)}`);
}

console.log('\n=== Only completed sales may form a comp ===');
{
  const r = computeComp(
    [
      claim('asking_price', 500),
      claim('market_estimate', 450),
      claim('sold_aggregate', 400),
      claim('ai_estimate', 600),
    ],
    PSA10
  );
  check('estimates and asking prices produce no comp at all',
    r.estimateCents === null && r.confidence === 'unavailable',
    `got ${formatMoney(r.estimateCents)} / ${r.confidence}`);
  check('the operator is told to enter a comp manually',
    r.limitations.some((l) => /manually/i.test(l)));
}

console.log('\n=== Mismatched sales are rejected with a reason ===');
{
  const r = computeComp(
    [
      graded(200, 5),
      graded(90, 6, 'PSA', 9),
      graded(150, 7, 'BGS', 10),
      sale(60, 8),
      graded(210, 9),
      graded(205, 400),
    ],
    PSA10
  );
  check('only matching PSA 10 sales are used', r.salesUsed.length === 2,
    `used ${r.salesUsed.length}`);
  const reasons = r.rejected.map((x) => x.reason);
  check('a PSA 9 sale is rejected as a different grade',
    reasons.some((x) => /different grade/.test(x)), reasons.join(' | '));
  check('a BGS 10 sale is rejected as a different company',
    reasons.some((x) => /different grading company/.test(x)));
  check('a raw sale is rejected for a graded target',
    reasons.some((x) => /not a graded sale/.test(x)));
  check('a 400-day-old sale is rejected as too old',
    reasons.some((x) => /older than/.test(x)));
  check('too few sales downgrades confidence to low', r.confidence === 'low');
  for (const x of r.rejected) {
    console.log(`       rejected ${formatMoney(x.claim.priceCents)} — ${x.reason}`);
  }
}

console.log('\n=== Outlier handling ===');
{
  const r = computeComp(
    [graded(200, 2), graded(205, 3), graded(195, 4), graded(20, 5)],
    PSA10
  );
  check('an absurd $20 sale is excluded from a ~$200 comp',
    !r.salesUsed.some((s) => s.priceCents === 2000),
    `used: ${r.salesUsed.map((s) => formatMoney(s.priceCents)).join(', ')}`);
  check('the comp lands at the true level',
    r.estimateCents === 20000, `got ${formatMoney(r.estimateCents)}`);
  check('the exclusion is explained', r.rejected.some((x) => /outlier/.test(x.reason)));
}

console.log('\n=== Only the newest N sales are used ===');
{
  const many = [
    graded(300, 1), graded(290, 2), graded(280, 3),
    graded(270, 4), graded(100, 60), graded(110, 70),
  ];
  const r = computeComp(many, PSA10, { ...DEFAULT_COMP_SETTINGS, outlierThreshold: null });
  check('exactly maxSalesForComp (4) sales are used', r.salesUsed.length === 4);
  check('the four most recent are the ones used',
    r.estimateCents === Math.round((30000 + 29000 + 28000 + 27000) / 4),
    `got ${formatMoney(r.estimateCents)}`);
}

console.log('\n=== Raw-card estimates are never called comps ===');
{
  const r = summariseEstimates(
    [claim('market_estimate', 324.63, { condition: null }), claim('asking_price', 296)],
    { currency: 'USD', condition: 'MP' }
  );
  check('the sold_aggregate/market_estimate is preferred over asking price',
    r.source?.claimType === 'market_estimate', `got ${r.source?.claimType}`);
  check('an NM-anchored price on an MP card is flagged',
    r.limitations.some((l) => /Near Mint/i.test(l)), r.limitations.join(' | '));
  check('confidence drops to low on condition mismatch', r.confidence === 'low');
  check('with adjustments off, the NM figure is left untouched',
    r.estimateCents === 32463 && r.adjustment === undefined,
    `got ${formatMoney(r.estimateCents)}`);
  for (const l of r.limitations) console.log(`       ! ${l}`);
}

console.log("\n=== The operator's own condition adjustments ===");
{
  const ADJ = { LP: 85, MP: 70, HP: 50, DMG: 30 };
  const nmPrice = claim('market_estimate', 324.63, { condition: null });
  const withAdj = (condition: CompTarget['condition'], gradingCompany?: string) =>
    summariseEstimates([nmPrice], { currency: 'USD', condition, gradingCompany, grade: gradingCompany ? 10 : undefined }, {
      conditionAdjustments: ADJ,
      applyConditionAdjustments: true,
    });

  const mp = withAdj('MP');
  check('MP applies 70% — $324.63 becomes $227.24',
    mp.estimateCents === 22724, `got ${formatMoney(mp.estimateCents)}`);
  check('the arithmetic is exposed for display',
    mp.adjustment?.baseCents === 32463 && mp.adjustment.factorPercent === 70
      && mp.adjustment.condition === 'MP');
  check('an adjusted figure is capped at low confidence', mp.confidence === 'low');
  check('it is labelled a derived estimate, not market data',
    mp.limitations.some((l) => /Derived estimate, not market data/.test(l)));
  check('the method names the operator as the source of the percentage',
    /adjusted to MP at 70% of Near Mint/.test(mp.method), mp.method);
  console.log(`       ${formatMoney(mp.estimateCents)} — ${mp.method}`);

  const lp = withAdj('LP');
  const hp = withAdj('HP');
  const dmg = withAdj('DMG');
  check('LP applies 85% — $275.94', lp.estimateCents === 27594,
    `got ${formatMoney(lp.estimateCents)}`);
  check('HP applies 50% — $162.32', hp.estimateCents === 16232,
    `got ${formatMoney(hp.estimateCents)}`);
  check('DMG applies 30% — $97.39', dmg.estimateCents === 9739,
    `got ${formatMoney(dmg.estimateCents)}`);
  console.log(`       LP ${formatMoney(lp.estimateCents)} · HP ${formatMoney(hp.estimateCents)}` +
    ` · DMG ${formatMoney(dmg.estimateCents)}`);

  const nm = withAdj('NM');
  check('NM is the anchor and is never adjusted',
    nm.estimateCents === 32463 && nm.adjustment === undefined,
    `got ${formatMoney(nm.estimateCents)}`);

  const unknown = withAdj('NEEDS_REVIEW');
  check('an ungraded-condition card is never adjusted',
    unknown.adjustment === undefined && unknown.confidence === 'low');
  check('and the operator is told to set a condition first',
    unknown.limitations.some((l) => /not been graded for condition/.test(l)));

  const slab = withAdj(null, 'PSA');
  check('a graded slab is never condition-adjusted',
    slab.adjustment === undefined,
    'raw condition factors must not be applied to a slab');

  // A missing factor must warn, never interpolate between the ones that exist.
  const partial = summariseEstimates([nmPrice], { currency: 'USD', condition: 'HP' }, {
    conditionAdjustments: { LP: 85, MP: 70 },
    applyConditionAdjustments: true,
  });
  check('a condition with no factor set is not guessed at',
    partial.estimateCents === 32463 && partial.adjustment === undefined,
    `got ${formatMoney(partial.estimateCents)}`);
  check('and says which setting is missing',
    partial.limitations.some((l) => /no adjustment set for HP/.test(l)),
    partial.limitations.join(' | '));

  // A provider that DOES report a condition must win over the heuristic.
  const realMp = summariseEstimates(
    [claim('sold_aggregate', 210, { condition: 'MP' })],
    { currency: 'USD', condition: 'MP' },
    { conditionAdjustments: ADJ, applyConditionAdjustments: true }
  );
  check('real condition-specific data is used as-is, not adjusted',
    realMp.estimateCents === 21000 && realMp.adjustment === undefined,
    `got ${formatMoney(realMp.estimateCents)}`);
  console.log('       (a genuine MP price beats the heuristic — no double discount)');
}

console.log('\n=== A raw price must not value a slab ===');
{
  const r = summariseEstimates([claim('market_estimate', 324.63)], PSA10);
  check('using a raw price for a PSA 10 is flagged and low confidence',
    r.confidence === 'low' && r.limitations.some((l) => /raw-card price/i.test(l)));
  console.log(`       ! ${r.limitations[0]}`);
}

console.log('\n=== Currencies are never silently converted ===');
{
  const eur = claim('sold_aggregate', 294.94, { currency: 'EUR' });
  const r = summariseEstimates([eur], { currency: 'USD' });
  check('a EUR-only price yields no USD estimate', r.estimateCents === null);
  check('the operator is told why', r.limitations.some((l) => /does not convert/i.test(l)));
  console.log(`       ! ${r.limitations[0]}`);
}

console.log('\n=== Asking-price strategies ===');
{
  check('manual strategy suggests nothing',
    suggestAskingPrice(10000, 'manual', {}) === null);
  check('market strategy mirrors the estimate',
    suggestAskingPrice(10000, 'market', {}) === 10000);
  check('market + 15% computes correctly',
    suggestAskingPrice(10000, 'market_plus_percent', { markupPercent: 15 }) === 11500);
  check('market + $2.50 computes correctly',
    suggestAskingPrice(10000, 'market_plus_fixed', { markupFixedCents: 250 }) === 10250);
  check('no base price means no suggestion',
    suggestAskingPrice(null, 'market', {}) === null);
}

console.log('\n=== Money handling ===');
{
  check('"$1,299.99" parses to 129999 cents', parseMoney('$1,299.99') === 129999);
  check('blank input is unknown (null), not zero', parseMoney('') === null);
  check('"0" is a real zero, not unknown', parseMoney('0') === 0);
  check('negative input is rejected', parseMoney('-5') === null);
  check('JPY has no minor unit', parseMoney('1200', 'JPY') === 1200);
  check('0.1 + 0.2 problem does not arise',
    parseMoney('0.10')! + parseMoney('0.20')! === 30);

  const net = netProfitCents({
    salePriceCents: 20000, shippingChargedCents: 500, costCents: 8000,
    marketplaceFeeCents: 2600, shippingCostCents: 450, packagingCostCents: 75,
  });
  check('net profit computes to $93.75', net === 9375, `got ${formatMoney(net)}`);
  check('ROI computes to 117.2%',
    Math.round(roiPercent(net, 8000)! * 10) / 10 === 117.2, `got ${roiPercent(net, 8000)}`);
  check('ROI on unknown cost is null, not Infinity', roiPercent(net, null) === null);
  check('ROI on zero cost is null, not Infinity', roiPercent(net, 0) === null);
  console.log(`       net ${formatMoney(net)} on $80.00 cost = ${roiPercent(net, 8000)!.toFixed(1)}% ROI`);
}

console.log('\n=== Profit edge cases ===');
{
  const sale = (over: Partial<Parameters<typeof saleTotals>[0]> = {}) => ({
    id: '', user_id: '', channel: 'ebay' as const, sold_at: '2026-09-01T00:00:00Z',
    buyer_note: null, currency: 'USD',
    sale_price_cents: 10000, shipping_charged_cents: 0, marketplace_fee_cents: 0,
    shipping_cost_cents: 0, packaging_cost_cents: 0, other_fee_cents: 0, refund_cents: 0,
    needs_review: false, review_reason: null, created_at: '', updated_at: '',
    ...over,
  });
  const line = (cost: number | null, qty = 1) => ({
    id: '', user_id: '', sale_id: '', inventory_item_id: 'i', lot_id: null,
    quantity: qty, unit_cost_cents: cost, unit_price_cents: null, created_at: '',
  });

  const known = saleTotals(sale(), [line(4000)]);
  check('net = gross − cost − fees', known.netCents === 6000, `got ${known.netCents}`);
  check('known cost is not flagged incomplete', known.costIncomplete === false);

  const unknown = saleTotals(sale(), [line(null)]);
  check('unknown cost contributes 0 but IS flagged',
    unknown.costCents === 0 && unknown.costIncomplete === true);
  check('unknown cost yields no ROI rather than infinite ROI',
    unknown.roiPercent === null, `got ${unknown.roiPercent}`);
  console.log('       (profit is shown as optimistic, not silently overstated)');

  const qty = saleTotals(sale({ sale_price_cents: 9000 }), [line(1000, 3)]);
  check('cost multiplies by quantity', qty.costCents === 3000, `got ${qty.costCents}`);

  const shipped = saleTotals(
    sale({ shipping_charged_cents: 500, shipping_cost_cents: 450, marketplace_fee_cents: 1325 }),
    [line(4000)]
  );
  check('shipping charged counts as revenue, postage paid as cost',
    shipped.grossCents === 10500 && shipped.feesCents === 1775
    && shipped.netCents === 4725,
    `gross ${shipped.grossCents} fees ${shipped.feesCents} net ${shipped.netCents}`);

  const refunded = saleTotals(sale({ refund_cents: 10000 }), [line(4000)]);
  check('a full refund produces a loss equal to the cost',
    refunded.netCents === -4000, `got ${refunded.netCents}`);

  check('margin is null on zero revenue', marginPercent(0, 0) === null);
  check('margin computes on real revenue',
    Math.round(marginPercent(6000, 10000)!) === 60);
}

console.log('\n=== Inventory aging ===');
{
  const day = 86_400_000;
  const nowMs = Date.parse('2026-10-22T00:00:00Z');
  const item = (daysOld: number, cost: number, over = {}) => ({
    id: String(daysOld), user_id: '', catalog_card_id: null, kind: 'raw_single',
    sku: null, status: 'in_stock', quantity: 1, quantity_sold: 0, quantity_allocated: 0,
    quantity_available: 1, condition: 'NM', condition_notes: null, defects: {},
    grading_company: null, grade: null, cert_number: null, grade_verified: false,
    currency: 'USD', purchase_cost_cents: cost,
    acquisition_date: new Date(nowMs - daysOld * day).toISOString(),
    acquisition_source: null, asking_price_cents: null, minimum_price_cents: null,
    market_value_cents: null, market_value_override_cents: null,
    market_value_confidence: null, market_value_method: null, last_price_refresh_at: null,
    storage_location: null, notes: null, listed_at: null, sold_at: null,
    created_at: new Date(nowMs - daysOld * day).toISOString(),
    updated_at: '', card_catalog: null, inventory_images: [],
    ...over,
  }) as unknown as Parameters<typeof inventoryAging>[0][number];

  const buckets = inventoryAging([
    item(5, 1000), item(45, 2000), item(120, 3000), item(200, 4000), item(500, 5000),
  ], nowMs);

  const labels = buckets.map((b) => `${b.label}=${b.itemCount}`);
  check('each item lands in exactly one bucket',
    buckets.every((b) => b.itemCount === 1), labels.join(' '));
  check('cost tied up is bucketed with the item',
    buckets[4].costCents === 5000, `got ${buckets[4].costCents}`);

  const sold = inventoryAging([
    item(5, 1000, { status: 'sold', quantity_available: 0 }),
  ], nowMs);
  check('sold stock is excluded from aging',
    sold.every((b) => b.itemCount === 0));

  const removed = inventoryAging([item(5, 1000, { status: 'removed' })], nowMs);
  check('removed stock is excluded from aging',
    removed.every((b) => b.itemCount === 0));

  console.log(`       ${labels.join(' · ')}`);
}

console.log('\n=== Listing generation ===');
{
  const base = {
    id: 'i1', user_id: '', catalog_card_id: 'c1', kind: 'raw_single', sku: null,
    status: 'in_stock', quantity: 1, quantity_sold: 0, quantity_allocated: 0,
    quantity_available: 1, condition: 'LP', condition_notes: null, defects: {},
    grading_company: null, grade: null, cert_number: null, grade_verified: false,
    currency: 'USD', purchase_cost_cents: 1000, acquisition_date: null,
    acquisition_source: null, asking_price_cents: 4500, minimum_price_cents: null,
    market_value_cents: 4000, market_value_override_cents: null,
    market_value_confidence: null, market_value_method: null, last_price_refresh_at: null,
    storage_location: null, notes: null, listed_at: null, sold_at: null,
    created_at: '2026-01-01T00:00:00Z', updated_at: '',
    card_catalog: {
      id: 'c1', user_id: '', game: 'pokemon', name: 'Charizard ex',
      set_name: '151', set_code: 'sv03.5', collector_number: '199', language: 'en',
      rarity: 'Special illustration rare', finish: 'Holofoil', variant: null,
      edition: null, is_promo: false, release_year: 2023, sport: null, player: null,
      team: null, manufacturer: null, parallel: null, has_autograph: null,
      has_memorabilia: null, attributes: {}, catalog_source: 'tcgdex',
      catalog_image_url: null, created_at: '', updated_at: '',
    },
    inventory_images: [],
  };
  const item = (over: Record<string, unknown> = {}) =>
    ({ ...base, ...over }) as unknown as Parameters<typeof generateListing>[0];

  const ebay = generateListing(item(), 'ebay');
  check('eBay title stays within 80 characters',
    ebay.title.length <= 80, `${ebay.title.length}: ${ebay.title}`);
  check('the title leads with game and card name',
    /^Pokemon Charizard ex/.test(ebay.title), ebay.title);
  check('the description states the real set and number',
    ebay.description.includes('151') && ebay.description.includes('199'));
  check('the description states the real condition',
    /Condition: Lightly Played/.test(ebay.description));
  console.log(`       ${ebay.title}`);

  const mercari = generateListing(item(), 'mercari');
  check('Mercari description stays within 1000 characters',
    mercari.description.length <= 1000, `${mercari.description.length}`);

  // The honesty rules.
  const all = MARKETPLACES.map((m) => generateListing(item(), m.id));
  check('no generated copy claims the card was tested or authenticated',
    all.every((l) => !/\b(tested|authenticated|verified authentic|guaranteed)\b/i
      .test(l.description)),
    'a generated listing made an authenticity claim');

  const ungraded = generateListing(item({ condition: 'NEEDS_REVIEW' }), 'ebay');
  check('an unassessed condition is disclosed, not guessed',
    /has not been graded yet/i.test(ungraded.description), ungraded.description);

  const slab = generateListing(item({
    kind: 'graded_slab', grading_company: 'PSA', grade: 10,
    cert_number: '12345678', grade_verified: false, condition: 'NM',
  }), 'ebay');
  check('a slab title carries the company and grade',
    /PSA 10/.test(slab.title), slab.title);
  check('an unverified cert asks the buyer to check it themselves',
    /verify the certification number yourself/i.test(slab.description));

  const verified = generateListing(item({
    kind: 'graded_slab', grading_company: 'PSA', grade: 10,
    cert_number: '12345678', grade_verified: true, condition: 'NM',
  }), 'ebay');
  check('only a confirmed cert claims confirmation',
    /Certification confirmed/i.test(verified.description));

  const unidentified = generateListing(
    item({ catalog_card_id: null, card_catalog: null }), 'ebay'
  );
  check('an unidentified card does not get an invented name',
    unidentified.title === 'Trading card Lightly Played'
      || unidentified.title.startsWith('Trading card'),
    unidentified.title);
  check('and its description invents no set or rarity',
    !/Set:|Rarity:/.test(unidentified.description), unidentified.description);

  const defective = generateListing(
    item({ defects: { whitening: true, creases: true, scratches: false } }), 'ebay'
  );
  check('recorded defects are disclosed in the description',
    /whitening, creases/.test(defective.description), defective.description);
  check('unticked defects are not mentioned',
    !/scratches/.test(defective.description));

  check('templates are chosen from what the item is',
    templateFor(item()) === 'raw_single'
    && templateFor(item({ kind: 'graded_slab', grading_company: 'PSA', grade: 9 })) === 'graded_slab'
    && templateFor(item({ market_value_cents: 50000 })) === 'high_value_single');

  const longName = generateListing(item({
    card_catalog: { ...base.card_catalog,
      name: 'Extremely Long Pokemon Card Name That Will Definitely Overflow The Limit VMAX' },
  }), 'ebay');
  check('an overlong title is truncated and flagged',
    longName.title.length <= 80 && longName.titleTruncated,
    `${longName.title.length} truncated=${longName.titleTruncated}`);
  check('truncation happens on a word boundary',
    !longName.title.endsWith('-') && !/\s$/.test(longName.title));
}

console.log(`\n${'-'.repeat(58)}`);
if (failures.length === 0) {
  console.log(`\x1b[32m${passed} checks passed, 0 failed.\x1b[0m\n`);
} else {
  console.log(`\x1b[31m${passed} passed, ${failures.length} FAILED:\x1b[0m`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log();
  process.exit(1);
}
