/**
 * YGOPRODeck — Yu-Gi-Oh! catalog and vendor price snapshot.
 *
 * Verified live 2026-10-22. Free, no API key. Rate limited to ~20 req/s.
 *
 * IMPORTANT ACCURACY CAVEAT, surfaced in the UI rather than buried here:
 * YGOPRODeck returns `card_prices` at the CARD level, not the PRINTING level.
 * It is the lowest price found across every set and rarity that card was ever
 * printed in. For a reseller that is close to useless on its own -- a Secret
 * Rare first printing and a common reprint share one number. These are
 * therefore emitted as low-confidence market_estimate with an explicit note,
 * and the app does not let them silently become an asking price.
 */

import { getJson } from '../../lib/http';
import { decimalToCents } from '../../lib/money';
import type {
  CardCandidate,
  CatalogProvider,
  CatalogQuery,
  PriceClaim,
  PriceLookup,
  PricingProvider,
  PricingProviderResult,
} from '../types';

const BASE = 'https://db.ygoprodeck.com/api/v7';

interface YgoSet {
  set_name?: string;
  set_code?: string;
  set_rarity?: string;
  set_price?: string;
}

interface YgoCard {
  id: number;
  name: string;
  type?: string;
  race?: string;
  attribute?: string;
  archetype?: string;
  ygoprodeck_url?: string;
  card_sets?: YgoSet[];
  card_images?: { id: number; image_url?: string; image_url_small?: string }[];
  card_prices?: Record<string, string>[];
}

interface YgoResponse {
  data?: YgoCard[];
  error?: string;
}

/** Yu-Gi-Oh set codes look like "LOB-EN001"; the leading token is the set. */
function setCodeOf(s: YgoSet): string | undefined {
  return s.set_code?.split('-')[0];
}

export class YgoprodeckProvider implements CatalogProvider, PricingProvider {
  readonly id = 'ygoprodeck';
  readonly label = 'YGOPRODeck';
  readonly homepage = 'https://ygoprodeck.com';
  readonly games = ['yugioh'] as const satisfies readonly ('yugioh')[];

  readonly capabilities = {
    conditionSpecific: false,
    gradedPricing: false,
    individualSales: false,
  };

  isConfigured(): boolean {
    return true;
  }

  async search(query: CatalogQuery): Promise<CardCandidate[]> {
    const term = query.name.trim();
    if (!term) return [];

    const params = new URLSearchParams({ fname: term, num: '20', offset: '0' });
    let res: YgoResponse;
    try {
      res = await getJson<YgoResponse>(`${BASE}/cardinfo.php?${params}`, {
        signal: query.signal,
      });
    } catch (err) {
      // The API answers "no match" with HTTP 400 and an error body.
      if (err && typeof err === 'object' && 'status' in err && err.status === 400) return [];
      throw err;
    }

    const out: CardCandidate[] = [];
    for (const card of res.data ?? []) {
      const image = card.card_images?.[0];
      const sets = card.card_sets ?? [];

      // Expand to one candidate per printing -- rarity and set drive price.
      if (sets.length === 0) {
        out.push({
          providerId: 'ygoprodeck',
          externalId: String(card.id),
          externalUrl: card.ygoprodeck_url,
          game: 'yugioh',
          name: card.name,
          language: query.language ?? 'en',
          imageUrl: image?.image_url_small ?? image?.image_url,
          attributes: { type: card.type, race: card.race, attribute: card.attribute },
        });
        continue;
      }

      for (const s of sets) {
        if (query.setCode && setCodeOf(s)?.toLowerCase() !== query.setCode.trim().toLowerCase()) {
          continue;
        }
        out.push({
          providerId: 'ygoprodeck',
          // The printing is identified by card id plus set code, since the
          // API has no per-printing identifier of its own.
          externalId: `${card.id}:${s.set_code ?? ''}`,
          externalUrl: card.ygoprodeck_url,
          game: 'yugioh',
          name: card.name,
          setName: s.set_name,
          setCode: setCodeOf(s),
          collectorNumber: s.set_code,
          language: query.language ?? 'en',
          rarity: s.set_rarity,
          imageUrl: image?.image_url_small ?? image?.image_url,
          attributes: { type: card.type, race: card.race, attribute: card.attribute },
        });
      }
    }
    return out.slice(0, query.limit ?? 30);
  }

  async getById(externalId: string): Promise<CardCandidate | null> {
    const [cardId, setCode] = externalId.split(':');
    try {
      const res = await getJson<YgoResponse>(`${BASE}/cardinfo.php?id=${cardId}`);
      const card = res.data?.[0];
      if (!card) return null;
      const s = card.card_sets?.find((x) => x.set_code === setCode);
      const image = card.card_images?.[0];
      return {
        providerId: 'ygoprodeck',
        externalId,
        externalUrl: card.ygoprodeck_url,
        game: 'yugioh',
        name: card.name,
        setName: s?.set_name,
        setCode: s ? setCodeOf(s) : undefined,
        collectorNumber: s?.set_code,
        language: 'en',
        rarity: s?.set_rarity,
        imageUrl: image?.image_url ?? image?.image_url_small,
        attributes: { type: card.type, race: card.race, attribute: card.attribute },
      };
    } catch {
      return null;
    }
  }

  async fetchPrices(lookup: PriceLookup): Promise<PricingProviderResult> {
    const cardId = lookup.externalId?.split(':')[0];
    if (!cardId) {
      return {
        provider: this.id,
        status: 'not_found',
        claims: [],
        message: 'This item is not linked to a YGOPRODeck card.',
      };
    }

    let res: YgoResponse;
    try {
      res = await getJson<YgoResponse>(`${BASE}/cardinfo.php?id=${cardId}`, {
        signal: lookup.signal,
      });
    } catch (err) {
      return {
        provider: this.id,
        status: 'error',
        claims: [],
        message: err instanceof Error ? err.message : 'Request failed',
      };
    }

    const card = res.data?.[0];
    const prices = card?.card_prices?.[0];
    if (!card || !prices) {
      return {
        provider: this.id,
        status: 'not_found',
        claims: [],
        message: 'YGOPRODeck has no price data for this card.',
        manualUrl: card?.ygoprodeck_url,
      };
    }

    const retrievedAt = new Date().toISOString();
    const CAVEAT =
      'YGOPRODeck reports one price per CARD, not per printing — it is the lowest across every set and rarity. It is not specific to your set, rarity, or condition.';

    const VENDORS: Record<string, { label: string; currency: string }> = {
      tcgplayer_price: { label: 'TCGplayer', currency: 'USD' },
      cardmarket_price: { label: 'Cardmarket', currency: 'EUR' },
      ebay_price: { label: 'eBay', currency: 'USD' },
      amazon_price: { label: 'Amazon', currency: 'USD' },
      coolstuffinc_price: { label: 'CoolStuffInc', currency: 'USD' },
    };

    const claims: PriceClaim[] = [];
    for (const [key, meta] of Object.entries(VENDORS)) {
      const n = Number(prices[key]);
      const cents = decimalToCents(Number.isFinite(n) ? n : null, meta.currency);
      if (cents == null || cents === 0) continue;
      claims.push({
        provider: `${meta.label} (via YGOPRODeck)`,
        claimType: 'market_estimate',
        priceCents: cents,
        currency: meta.currency,
        condition: null,
        observedAt: null,
        retrievedAt,
        sourceUrl: card.ygoprodeck_url ?? null,
        status: 'ok',
        notes: CAVEAT,
        raw: { key },
      });
    }

    if (claims.length === 0) {
      return {
        provider: this.id,
        status: 'not_found',
        claims: [],
        message: 'YGOPRODeck returned no usable prices for this card.',
        manualUrl: card.ygoprodeck_url,
      };
    }
    return { provider: this.id, status: 'ok', claims, manualUrl: card.ygoprodeck_url };
  }
}

export const ygoprodeck = new YgoprodeckProvider();
