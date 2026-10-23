/**
 * Price refresh for one inventory item.
 *
 * Shared by the per-item Refresh button and the batch refresh, so a card
 * priced one way cannot disagree with the same card priced the other way.
 *
 * What it writes:
 *   - new rows in price_observations (append-only history)
 *   - the COMPUTED valuation on the item (market_value_cents and friends)
 *   - last_price_refresh_at
 *
 * What it never touches: market_value_override_cents, asking_price_cents and
 * minimum_price_cents. Those are the operator's numbers, and a background
 * refresh silently editing them is exactly the behaviour the brief forbids.
 */

import {
  externalIdFor, getPriceObservations, recordPriceObservations, updateInventoryItem,
  type InventoryItemFull, type PricingSettingsRow,
} from './db';
import { activePricingProvidersFor } from '../providers/registry';
import { computeComp, summariseEstimates, type CompTarget } from './valuation';

export interface RefreshOutcome {
  itemId: string;
  /** Operator-facing card name, for the results list. */
  label: string;
  status: 'priced' | 'no_price' | 'error';
  valueCents: number | null;
  confidence: string | null;
  method: string | null;
  /** Why no price, or what went wrong. */
  messages: string[];
}

export function valuationTargetFor(item: InventoryItemFull): CompTarget {
  return {
    currency: item.currency,
    condition: item.kind === 'graded_slab' ? null : item.condition,
    gradingCompany: item.grading_company,
    grade: item.grade,
    finish: item.card_catalog?.finish ?? null,
    variant: item.card_catalog?.variant ?? null,
  };
}

export async function refreshItemPrices(
  item: InventoryItemFull,
  userId: string,
  settings: PricingSettingsRow | null
): Promise<RefreshOutcome> {
  const label = item.card_catalog?.name ?? 'Unidentified card';
  const messages: string[] = [];

  const game = item.card_catalog?.game ?? 'other';
  const providers = activePricingProvidersFor(game);

  if (providers.length === 0) {
    messages.push(`No connected price source covers ${game}.`);
  }
  if (!item.catalog_card_id) {
    messages.push('Not linked to a catalog card, so there is nothing to look up.');
  }

  try {
    for (const p of providers) {
      const externalId = item.catalog_card_id
        ? await externalIdFor(item.catalog_card_id, p.id)
        : null;

      const res = await p.fetchPrices({
        game,
        externalId: externalId ?? undefined,
        name: item.card_catalog?.name ?? '',
        setCode: item.card_catalog?.set_code ?? undefined,
        collectorNumber: item.card_catalog?.collector_number ?? undefined,
        language: item.card_catalog?.language,
        finish: item.card_catalog?.finish ?? undefined,
        condition: item.condition,
        gradingCompany: item.grading_company ?? undefined,
        grade: item.grade ?? undefined,
      });

      if (res.status === 'ok' && res.claims.length) {
        await recordPriceObservations(res.claims, {
          userId,
          catalogCardId: item.catalog_card_id,
          inventoryItemId: item.id,
        });
      } else if (res.message) {
        messages.push(`${p.label}: ${res.message}`);
      }
    }

    // Recompute from the FULL history, not just what we just fetched --
    // manually entered sales must still feed the comp.
    const claims = await getPriceObservations({
      inventoryItemId: item.id,
      catalogCardId: item.catalog_card_id,
    });
    const target = valuationTargetFor(item);

    const comp = computeComp(claims, target, {
      minSalesForComp: settings?.min_sales_for_comp ?? 3,
      maxSalesForComp: settings?.max_sales_for_comp ?? 4,
      maxSaleAgeDays: 180,
      outlierThreshold: 0.5,
    });
    const estimate = summariseEstimates(claims, target, {
      staleAfterDays: settings?.stale_after_days ?? 14,
      conditionAdjustments: settings?.condition_adjustments,
      applyConditionAdjustments: settings?.apply_condition_adjustments,
    });

    // A real comp beats an estimate whenever one exists.
    const chosen = comp.estimateCents != null ? comp : estimate;

    await updateInventoryItem(item.id, {
      market_value_cents: chosen.estimateCents,
      market_value_confidence: chosen.confidence,
      market_value_method: chosen.method,
      last_price_refresh_at: new Date().toISOString(),
    });

    return {
      itemId: item.id,
      label,
      status: chosen.estimateCents != null ? 'priced' : 'no_price',
      valueCents: chosen.estimateCents,
      confidence: chosen.confidence,
      method: chosen.method,
      messages,
    };
  } catch (e) {
    return {
      itemId: item.id,
      label,
      status: 'error',
      valueCents: null,
      confidence: null,
      method: null,
      messages: [...messages, e instanceof Error ? e.message : 'Refresh failed.'],
    };
  }
}

/** Days since a price was last refreshed, or null if never. */
export function staleDays(item: InventoryItemFull, now = Date.now()): number | null {
  if (!item.last_price_refresh_at) return null;
  const t = Date.parse(item.last_price_refresh_at);
  if (!Number.isFinite(t)) return null;
  return (now - t) / 86_400_000;
}

/** Items whose price is older than the operator's threshold, or never set. */
export function staleItems(
  items: InventoryItemFull[],
  staleAfterDays: number
): InventoryItemFull[] {
  return items.filter((i) => {
    const d = staleDays(i);
    return d === null || d > staleAfterDays;
  });
}
