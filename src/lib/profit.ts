/**
 * Profit arithmetic and sales aggregation.
 *
 * Deliberately a pure module with no storage dependency, so both backends
 * feed it the same rows and get byte-identical numbers. If this lived inside
 * either backend the two would eventually disagree, and a business dashboard
 * that reports different profit depending on where the data happens to live
 * is worse than no dashboard.
 *
 * Everything here operates on ACTUAL recorded transaction values. Estimated
 * market value never enters these calculations -- the brief is explicit that
 * actual sales and estimates must stay separate, and mixing them would make
 * "profit" mean nothing.
 */

import type {
  AgingBucket, InventoryItemFull, SaleChannel, SaleFull, SaleItemRow, SaleRow, SalesSummary,
} from './store/types';

const DAY_MS = 86_400_000;

export interface SaleTotals {
  /** What the buyer paid in total, including any shipping they were charged. */
  grossCents: number;
  /** Cost basis of the goods, snapshot at the time of sale. */
  costCents: number;
  /** Everything that left your pocket apart from the goods themselves. */
  feesCents: number;
  netCents: number;
  /** null when no cost basis is known. Never 0, never Infinity. */
  roiPercent: number | null;
  /** True when at least one line has no recorded cost. */
  costIncomplete: boolean;
}

/**
 * Profit for a single sale.
 *
 * Note the treatment of unknown cost: a line with a null unit_cost_cents
 * contributes 0 to cost but sets `costIncomplete`, so the UI can show the
 * number while making clear it is optimistic. Treating unknown as zero
 * silently would overstate profit, which is the dangerous direction.
 */
export function saleTotals(sale: SaleRow, items: SaleItemRow[]): SaleTotals {
  const grossCents = sale.sale_price_cents + (sale.shipping_charged_cents ?? 0);

  let costCents = 0;
  let costIncomplete = items.length === 0;
  for (const line of items) {
    if (line.unit_cost_cents == null) costIncomplete = true;
    else costCents += line.unit_cost_cents * line.quantity;
  }

  const feesCents =
    (sale.marketplace_fee_cents ?? 0) +
    (sale.shipping_cost_cents ?? 0) +
    (sale.packaging_cost_cents ?? 0) +
    (sale.other_fee_cents ?? 0) +
    (sale.refund_cents ?? 0);

  const netCents = grossCents - costCents - feesCents;

  return {
    grossCents,
    costCents,
    feesCents,
    netCents,
    roiPercent: costCents > 0 ? (netCents / costCents) * 100 : null,
    costIncomplete,
  };
}

/** Margin as a percentage of gross revenue. null when nothing was sold. */
export function marginPercent(netCents: number, grossCents: number): number | null {
  if (grossCents <= 0) return null;
  return (netCents / grossCents) * 100;
}

function monthKey(iso: string): string {
  return iso.slice(0, 7); // YYYY-MM
}

/**
 * Aggregate a set of sales into the business dashboard figures.
 *
 * `acquiredAt` maps an inventory item id to when it was acquired, used for
 * average time to sell. Items with no acquisition date are excluded from that
 * average rather than counted as zero days.
 */
export function summariseSales(
  sales: SaleFull[],
  opts: {
    currency?: string;
    acquiredAt?: Map<string, string | null>;
    gameOf?: Map<string, string | null>;
  } = {}
): SalesSummary {
  const currency = opts.currency ?? 'USD';

  const summary: SalesSummary = {
    currency,
    saleCount: 0,
    cardsSold: 0,
    grossRevenueCents: 0,
    totalCostCents: 0,
    totalFeesCents: 0,
    netProfitCents: 0,
    roiPercent: null,
    averageSalePriceCents: null,
    averageDaysToSell: null,
    byMonth: [],
    byChannel: [],
    byGame: [],
    needsReviewCount: 0,
  };

  const months = new Map<string, { revenueCents: number; netCents: number; count: number }>();
  const channels = new Map<SaleChannel, { revenueCents: number; netCents: number; count: number }>();
  const games = new Map<string, { revenueCents: number; netCents: number; count: number }>();
  const daysToSell: number[] = [];

  for (const sale of sales) {
    const totals = saleTotals(sale, sale.items);

    summary.saleCount += 1;
    summary.grossRevenueCents += totals.grossCents;
    summary.totalCostCents += totals.costCents;
    summary.totalFeesCents += totals.feesCents;
    summary.netProfitCents += totals.netCents;
    if (sale.needs_review) summary.needsReviewCount += 1;

    for (const line of sale.items) summary.cardsSold += line.quantity;

    const mk = monthKey(sale.sold_at);
    const m = months.get(mk) ?? { revenueCents: 0, netCents: 0, count: 0 };
    m.revenueCents += totals.grossCents;
    m.netCents += totals.netCents;
    m.count += 1;
    months.set(mk, m);

    const c = channels.get(sale.channel) ?? { revenueCents: 0, netCents: 0, count: 0 };
    c.revenueCents += totals.grossCents;
    c.netCents += totals.netCents;
    c.count += 1;
    channels.set(sale.channel, c);

    // Revenue is attributed to a game only when the sale has exactly one
    // line; splitting a multi-card sale across games would require allocating
    // shipping and fees between them, which is guesswork.
    if (opts.gameOf && sale.items.length === 1) {
      const game = opts.gameOf.get(sale.items[0].inventory_item_id ?? '') ?? 'unknown';
      const g = games.get(game) ?? { revenueCents: 0, netCents: 0, count: 0 };
      g.revenueCents += totals.grossCents;
      g.netCents += totals.netCents;
      g.count += 1;
      games.set(game, g);
    }

    if (opts.acquiredAt) {
      for (const line of sale.items) {
        const acquired = line.inventory_item_id
          ? opts.acquiredAt.get(line.inventory_item_id)
          : null;
        if (!acquired) continue;
        const days = (Date.parse(sale.sold_at) - Date.parse(acquired)) / DAY_MS;
        if (Number.isFinite(days) && days >= 0) daysToSell.push(days);
      }
    }
  }

  if (summary.totalCostCents > 0) {
    summary.roiPercent = (summary.netProfitCents / summary.totalCostCents) * 100;
  }
  if (summary.saleCount > 0) {
    summary.averageSalePriceCents = Math.round(summary.grossRevenueCents / summary.saleCount);
  }
  if (daysToSell.length > 0) {
    summary.averageDaysToSell =
      daysToSell.reduce((a, b) => a + b, 0) / daysToSell.length;
  }

  summary.byMonth = [...months.entries()]
    .map(([month, v]) => ({ month, ...v }))
    .sort((a, b) => a.month.localeCompare(b.month));

  summary.byChannel = [...channels.entries()]
    .map(([channel, v]) => ({ channel, ...v }))
    .sort((a, b) => b.netCents - a.netCents);

  summary.byGame = [...games.entries()]
    .map(([game, v]) => ({ game, ...v }))
    .sort((a, b) => b.netCents - a.netCents);

  return summary;
}

/** Buckets for the unsold-inventory aging report. */
const AGE_BUCKETS: { label: string; maxDays: number }[] = [
  { label: '0–30 days', maxDays: 30 },
  { label: '31–90 days', maxDays: 90 },
  { label: '91–180 days', maxDays: 180 },
  { label: '181–365 days', maxDays: 365 },
  { label: 'Over a year', maxDays: Infinity },
];

/**
 * How long unsold stock has been sitting, by cost.
 *
 * Aged by acquisition date where known, falling back to when the record was
 * created. Sold and removed items are excluded -- this answers "what is stuck",
 * not "what did I once own".
 */
export function inventoryAging(items: InventoryItemFull[], now = Date.now()): AgingBucket[] {
  const buckets: AgingBucket[] = AGE_BUCKETS.map((b) => ({
    label: b.label, itemCount: 0, costCents: 0,
  }));

  for (const item of items) {
    if (item.status === 'sold' || item.status === 'removed') continue;
    if (item.quantity_available <= 0) continue;

    const since = item.acquisition_date ?? item.created_at;
    const days = (now - Date.parse(since)) / DAY_MS;
    if (!Number.isFinite(days)) continue;

    const index = AGE_BUCKETS.findIndex((b) => days <= b.maxDays);
    const bucket = buckets[index === -1 ? buckets.length - 1 : index];
    bucket.itemCount += 1;
    bucket.costCents += (item.purchase_cost_cents ?? 0) * item.quantity_available;
  }

  return buckets;
}
