/**
 * Valuation engine.
 *
 * Two distinct valuation methods, exactly as specified:
 *
 *   computeComp()      — for graded slabs and anything with real sold data.
 *                        Averages the N most recent COMPLETED SALES.
 *   summariseEstimates() — for raw singles priced from provider snapshots.
 *                        Never calls its output a comp.
 *
 * The invariant that holds the whole thing together: `computeComp` accepts
 * only claims whose type is in COMP_ELIGIBLE (today: `sold_observation`).
 * An asking price or a market estimate cannot physically reach the averaging
 * code, so the rule "never present an asking price as a confirmed sale" is
 * enforced by the type system rather than by reviewer vigilance.
 */

import type {
  CardCondition,
  ConfidenceLevel,
  PriceClaim,
  PriceClaimType,
} from '../providers/types';
import { COMP_ELIGIBLE } from '../providers/types';

export interface CompSettings {
  /** Fewer than this many sales means the result is low confidence. */
  minSalesForComp: number;
  /** The comp averages at most this many of the most recent sales. */
  maxSalesForComp: number;
  /** Sales older than this are excluded from the comp entirely. */
  maxSaleAgeDays: number;
  /**
   * A sale is treated as an outlier when it sits further than this fraction
   * from the median of the candidate set. 0.5 means "more than 50% away".
   * Set to null to disable outlier rejection.
   */
  outlierThreshold: number | null;
}

export const DEFAULT_COMP_SETTINGS: CompSettings = {
  minSalesForComp: 3,
  maxSalesForComp: 4,
  maxSaleAgeDays: 180,
  outlierThreshold: 0.5,
};

export interface CompResult {
  estimateCents: number | null;
  currency: string;
  /** Human-readable description of exactly how the number was produced. */
  method: string;
  confidence: ConfidenceLevel;
  /** The sales actually averaged, in the order shown to the operator. */
  salesUsed: PriceClaim[];
  /** Sales that were considered and rejected, with the reason why. */
  rejected: { claim: PriceClaim; reason: string }[];
  medianCents: number | null;
  lowCents: number | null;
  highCents: number | null;
  /** Everything the operator should know before trusting this number. */
  limitations: string[];
}

const DAY_MS = 86_400_000;

function daysAgo(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / DAY_MS;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** Describes the exact card a comp must match. */
export interface CompTarget {
  currency: string;
  condition?: CardCondition | null;
  gradingCompany?: string | null;
  grade?: number | null;
  finish?: string | null;
  variant?: string | null;
}

/**
 * Decide whether one sale is a legitimate comparable for the target card.
 *
 * This is the rule that stops a PSA 9 sale being averaged into a PSA 10 comp,
 * and a holo sale into a reverse-holo comp. It returns a rejection reason
 * rather than a boolean so the UI can show the operator *why* a sale they can
 * see on the source site was not counted.
 */
export function matchReason(claim: PriceClaim, target: CompTarget): string | null {
  if (claim.priceCents == null) return 'no price';
  if (claim.currency !== target.currency) {
    return `different currency (${claim.currency})`;
  }

  // Graded comparisons must match company AND grade exactly. A PSA 10 and a
  // PSA 9 of the same card routinely differ by multiples, so "close" is wrong.
  if (target.gradingCompany || target.grade != null) {
    if (!claim.gradingCompany || !claim.grade) return 'not a graded sale';
    if (claim.gradingCompany.toUpperCase() !== (target.gradingCompany ?? '').toUpperCase()) {
      return `different grading company (${claim.gradingCompany})`;
    }
    if (Number(claim.grade) !== Number(target.grade)) {
      return `different grade (${claim.gradingCompany} ${claim.grade})`;
    }
  } else if (claim.gradingCompany) {
    return `graded sale (${claim.gradingCompany} ${claim.grade ?? '?'}) cannot price a raw card`;
  }

  if (target.finish && claim.finish && claim.finish !== target.finish) {
    return `different finish (${claim.finish})`;
  }
  if (target.variant && claim.variant && claim.variant !== target.variant) {
    return `different variant (${claim.variant})`;
  }

  // For raw cards, condition drives price. A sale with no recorded condition
  // is usable but weakens confidence; a mismatched condition is not usable.
  if (!target.gradingCompany && target.condition && claim.condition) {
    if (claim.condition !== target.condition) {
      return `different condition (${claim.condition})`;
    }
  }

  return null;
}

/**
 * Average the most recent valid completed sales.
 *
 * Example from the brief: sales of $180, $195, $205 and $220 produce a comp
 * of $200 — the arithmetic mean of the selected sales.
 */
export function computeComp(
  claims: PriceClaim[],
  target: CompTarget,
  settings: CompSettings = DEFAULT_COMP_SETTINGS
): CompResult {
  const rejected: { claim: PriceClaim; reason: string }[] = [];
  const limitations: string[] = [];

  // 1. Only genuine completed sales are even considered.
  const sales: PriceClaim[] = [];
  for (const c of claims) {
    if (!COMP_ELIGIBLE.has(c.claimType)) continue; // silently not a comp input
    if (c.status !== 'ok') continue;

    const mismatch = matchReason(c, target);
    if (mismatch) {
      rejected.push({ claim: c, reason: mismatch });
      continue;
    }
    const age = daysAgo(c.observedAt);
    if (age == null) {
      rejected.push({ claim: c, reason: 'no sale date' });
      continue;
    }
    if (age > settings.maxSaleAgeDays) {
      rejected.push({ claim: c, reason: `older than ${settings.maxSaleAgeDays} days` });
      continue;
    }
    sales.push(c);
  }

  if (sales.length === 0) {
    return {
      estimateCents: null,
      currency: target.currency,
      method: 'No completed sales available',
      confidence: 'unavailable',
      salesUsed: [],
      rejected,
      medianCents: null,
      lowCents: null,
      highCents: null,
      limitations: ['No reliable price available. Enter a comp manually to value this item.'],
    };
  }

  // 2. Most recent first, then take the comp window.
  sales.sort((a, b) => Date.parse(b.observedAt!) - Date.parse(a.observedAt!));
  let window = sales.slice(0, settings.maxSalesForComp);

  // 3. Reject outliers against the median of the window, not the mean --
  //    a single absurd sale drags a mean, but barely moves a median.
  const threshold = settings.outlierThreshold;
  if (threshold != null && window.length >= 3) {
    const med = median(window.map((s) => s.priceCents!))!;
    const kept = window.filter((s) => {
      const deviation = Math.abs(s.priceCents! - med) / med;
      if (deviation > threshold) {
        rejected.push({
          claim: s,
          reason: `outlier: ${Math.round(deviation * 100)}% from the median of the sample`,
        });
        return false;
      }
      return true;
    });
    if (kept.length >= 2) window = kept;
  }

  const prices = window.map((s) => s.priceCents!);
  const estimateCents = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const med = median(prices);

  // 4. Confidence, stated in terms the operator can audit.
  let confidence: ConfidenceLevel;
  const spread = high > 0 ? (high - low) / high : 0;
  const newest = daysAgo(window[0].observedAt) ?? 999;

  if (window.length >= settings.minSalesForComp && spread <= 0.25 && newest <= 60) {
    confidence = 'high';
  } else if (window.length >= 2) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  if (window.length < settings.minSalesForComp) {
    confidence = 'low';
    limitations.push(
      `Based on only ${window.length} sale${window.length === 1 ? '' : 's'}. ` +
      `${settings.minSalesForComp} or more is needed for a reliable comp — treat this as indicative.`
    );
  }
  if (spread > 0.4) {
    limitations.push(
      `Wide spread between the highest and lowest sale (${Math.round(spread * 100)}%). ` +
      `The average may not represent a typical result.`
    );
  }
  if (newest > 90) {
    limitations.push(`The most recent sale is ${Math.round(newest)} days old.`);
  }
  if (!target.gradingCompany && window.some((s) => !s.condition)) {
    limitations.push('Some sales have no recorded condition, so they may not match this card.');
  }

  return {
    estimateCents,
    currency: target.currency,
    method:
      `Average of the ${window.length} most recent completed ` +
      `sale${window.length === 1 ? '' : 's'}`,
    confidence,
    salesUsed: window,
    rejected,
    medianCents: med,
    lowCents: low,
    highCents: high,
    limitations,
  };
}

// ---------------------------------------------------------------------------
// Estimates (raw singles from provider snapshots)
// ---------------------------------------------------------------------------

/** Preference order when no completed sales exist. Most trustworthy first. */
const ESTIMATE_PRIORITY: PriceClaimType[] = [
  'sold_aggregate',   // provider's own average of real sales
  'market_estimate',  // provider's derived market price
  'manual',
  'asking_price',     // weakest: nobody has paid this
  'ai_estimate',
];

export interface EstimateResult {
  estimateCents: number | null;
  currency: string;
  method: string;
  confidence: ConfidenceLevel;
  source: PriceClaim | null;
  alternatives: PriceClaim[];
  limitations: string[];
  /**
   * Set when the operator's own condition adjustment was applied. Present so
   * the UI can show the arithmetic rather than just a number -- the operator
   * should always be able to see that this figure is derived from their own
   * setting and not reported by any provider.
   */
  adjustment?: {
    baseCents: number;
    factorPercent: number;
    condition: CardCondition;
  };
}

/** The operator's discount factors, as a percentage of the Near Mint price. */
export type ConditionAdjustments = Partial<Record<CardCondition, number>>;

/**
 * Conditions an adjustment may legitimately apply to.
 *
 * NM is the anchor and is never adjusted. NEEDS_REVIEW is excluded because an
 * unassessed card has no known condition -- discounting it would be guessing
 * twice over.
 */
const ADJUSTABLE: ReadonlySet<CardCondition> = new Set<CardCondition>(['LP', 'MP', 'HP', 'DMG']);

/**
 * Pick the single most defensible estimate from a set of provider snapshots,
 * and say plainly what it is and is not.
 */
export function summariseEstimates(
  claims: PriceClaim[],
  target: CompTarget,
  opts: {
    staleAfterDays?: number;
    /** Operator-supplied percentages of the NM price, e.g. { MP: 70 }. */
    conditionAdjustments?: ConditionAdjustments;
    applyConditionAdjustments?: boolean;
  } = {}
): EstimateResult {
  const staleAfter = opts.staleAfterDays ?? 14;
  const usable = claims.filter(
    (c) => c.status === 'ok' && c.priceCents != null && c.currency === target.currency
  );

  if (usable.length === 0) {
    const otherCurrencies = [...new Set(
      claims.filter((c) => c.priceCents != null).map((c) => c.currency)
    )];
    return {
      estimateCents: null,
      currency: target.currency,
      method: 'No reliable price available',
      confidence: 'unavailable',
      source: null,
      alternatives: [],
      limitations: otherCurrencies.length
        ? [
            `Prices were found only in ${otherCurrencies.join(', ')}. ` +
            `This app does not convert currencies, because a converted price is ` +
            `an estimate of an estimate. Enter a value manually instead.`,
          ]
        : ['No configured provider returned a price for this card.'],
    };
  }

  const byPriority = [...usable].sort(
    (a, b) => ESTIMATE_PRIORITY.indexOf(a.claimType) - ESTIMATE_PRIORITY.indexOf(b.claimType)
  );
  const source = byPriority[0];
  const limitations: string[] = [];

  let confidence: ConfidenceLevel;
  switch (source.claimType) {
    case 'sold_aggregate':  confidence = 'medium'; break;
    case 'market_estimate': confidence = 'medium'; break;
    case 'manual':          confidence = 'medium'; break;
    default:                confidence = 'low';
  }

  // The honesty rules from the brief, applied mechanically.
  if (source.claimType === 'asking_price') {
    limitations.push(
      'This is a current asking price, not a sale. Nobody has paid it. ' +
      'Treat it as an upper bound.'
    );
  }
  // Condition handling for raw cards priced from an NM-anchored snapshot.
  //
  // Three distinct outcomes, and the difference between them matters:
  //   a) the operator has supplied a factor -> apply it, label it as THEIRS
  //   b) adjustments are off -> show the NM figure with an explicit warning
  //   c) no factor exists for this condition -> warn, never interpolate
  let estimateCents = source.priceCents;
  let method = `${source.provider} — ${source.claimType.replace(/_/g, ' ')}`;
  let adjustment: EstimateResult['adjustment'];

  const needsAdjustment =
    !target.gradingCompany &&
    source.condition == null &&
    target.condition != null &&
    ADJUSTABLE.has(target.condition);

  if (needsAdjustment) {
    const condition = target.condition as CardCondition;
    const factor = opts.conditionAdjustments?.[condition];
    const enabled = opts.applyConditionAdjustments === true;

    if (enabled && typeof factor === 'number' && factor > 0 && factor <= 100 && estimateCents != null) {
      const baseCents = estimateCents;
      estimateCents = Math.round((baseCents * factor) / 100);
      adjustment = { baseCents, factorPercent: factor, condition };
      method =
        `${source.provider} ${source.claimType.replace(/_/g, ' ')}, ` +
        `adjusted to ${condition} at ${factor}% of Near Mint`;

      // Indirect pricing evidence, per the confidence ladder: a real market
      // figure passed through the operator's own heuristic. Never better
      // than low, however consistent the underlying snapshot is.
      confidence = 'low';
      limitations.push(
        `Derived estimate, not market data. This is ${source.provider}'s ` +
        `Near-Mint-anchored price with YOUR ${condition} adjustment of ${factor}% ` +
        `applied. No source reported an actual ${condition} price for this card. ` +
        `Change the percentage in Settings, or record a real sale instead.`
      );
    } else if (enabled) {
      confidence = 'low';
      limitations.push(
        `This figure is anchored to Near Mint but the card is ${condition}, and ` +
        `you have no adjustment set for ${condition}. Add one in Settings, or ` +
        `record a manual comp — the app will not guess the discount.`
      );
    } else {
      confidence = 'low';
      limitations.push(
        `This figure is not condition-specific and is anchored to Near Mint, ` +
        `but this card is ${condition}. The real value is lower, and condition ` +
        `adjustments are turned off — enable them in Settings or record a manual comp.`
      );
    }
  } else if (source.condition == null && target.condition === 'NEEDS_REVIEW') {
    confidence = 'low';
    limitations.push(
      'This card has not been graded for condition yet, so no adjustment can be ' +
      'applied. Set its condition to get a usable estimate.'
    );
  }
  if (target.gradingCompany) {
    confidence = 'low';
    limitations.push(
      `This is a raw-card price. It does not value a ${target.gradingCompany} ` +
      `${target.grade ?? ''} slab — graded comps need completed sales of the same ` +
      `company and grade, entered manually.`
    );
  }

  const age = daysAgo(source.observedAt ?? source.retrievedAt);
  if (age != null && age > staleAfter) {
    if (confidence === 'medium') confidence = 'low';
    limitations.push(`Last refreshed ${Math.round(age)} days ago.`);
  }

  return {
    estimateCents,
    currency: source.currency,
    method,
    confidence,
    source,
    alternatives: byPriority.slice(1),
    limitations,
    adjustment,
  };
}

/**
 * Derive an asking price from a valuation, per the operator's strategy.
 * Returns null when there is nothing defensible to base it on -- the UI then
 * asks for a manual price rather than inventing one.
 */
export function suggestAskingPrice(
  baseCents: number | null,
  strategy: string,
  opts: { markupPercent?: number; markupFixedCents?: number }
): number | null {
  if (baseCents == null) return null;
  switch (strategy) {
    case 'market':
      return baseCents;
    case 'market_plus_percent':
      return Math.round(baseCents * (1 + (opts.markupPercent ?? 0) / 100));
    case 'market_plus_fixed':
      return baseCents + (opts.markupFixedCents ?? 0);
    default:
      return null; // 'manual'
  }
}
