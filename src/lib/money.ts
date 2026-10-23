/**
 * Money is always an integer number of minor units (cents) plus a currency.
 *
 * Floating point is never used for money anywhere in this application. The
 * classic failure is 0.1 + 0.2 !== 0.3; in an inventory ledger that surfaces
 * as profit totals that drift by a cent per transaction and never reconcile.
 */

export type CurrencyCode = 'USD' | 'EUR' | 'GBP' | 'CAD' | 'JPY' | 'AUD';

/** Currencies whose minor unit is not 1/100. */
const ZERO_DECIMAL: ReadonlySet<string> = new Set(['JPY']);

export function minorUnitScale(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 1 : 100;
}

/**
 * Parse human input ("12.50", "$1,299", "") into integer cents.
 * Returns null for blank or unparseable input -- null means "unknown",
 * which is distinct from 0 meaning "actually free".
 */
export function parseMoney(input: string, currency: CurrencyCode = 'USD'): number | null {
  if (input == null) return null;
  const cleaned = String(input).replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;

  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0) return null;

  const scale = minorUnitScale(currency);
  // Round half-up at the minor unit, then coerce to a safe integer.
  return Math.round(value * scale);
}

/** Format integer cents for display. */
export function formatMoney(
  cents: number | null | undefined,
  currency: CurrencyCode = 'USD',
  opts: { blank?: string } = {}
): string {
  if (cents == null) return opts.blank ?? '—';
  const scale = minorUnitScale(currency);
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    minimumFractionDigits: scale === 1 ? 0 : 2,
    maximumFractionDigits: scale === 1 ? 0 : 2,
  }).format(cents / scale);
}

/** Convert integer cents to the decimal string an <input> expects. */
export function centsToInput(cents: number | null | undefined, currency: CurrencyCode = 'USD'): string {
  if (cents == null) return '';
  const scale = minorUnitScale(currency);
  return scale === 1 ? String(cents) : (cents / scale).toFixed(2);
}

/** Convert a provider's decimal price (e.g. 324.63) to integer cents. */
export function decimalToCents(value: number | null | undefined, currency = 'USD'): number | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value * minorUnitScale(currency));
}

/** Apply a percentage markup to a cents amount, rounding to the nearest cent. */
export function applyPercent(cents: number, percent: number): number {
  return Math.round(cents * (1 + percent / 100));
}

/** Net profit for a sale, in cents. All inputs are integer cents. */
export function netProfitCents(input: {
  salePriceCents: number;
  shippingChargedCents?: number;
  costCents?: number | null;
  marketplaceFeeCents?: number;
  shippingCostCents?: number;
  packagingCostCents?: number;
  otherFeeCents?: number;
  refundCents?: number;
}): number {
  const gross = input.salePriceCents + (input.shippingChargedCents ?? 0);
  const outflow =
    (input.costCents ?? 0) +
    (input.marketplaceFeeCents ?? 0) +
    (input.shippingCostCents ?? 0) +
    (input.packagingCostCents ?? 0) +
    (input.otherFeeCents ?? 0) +
    (input.refundCents ?? 0);
  return gross - outflow;
}

/** Return on investment as a percentage, or null when cost is unknown/zero. */
export function roiPercent(netCents: number, costCents: number | null | undefined): number | null {
  if (costCents == null || costCents === 0) return null;
  return (netCents / costCents) * 100;
}
