/**
 * Scryfall — Magic: The Gathering catalog and daily price snapshot.
 *
 * Verified live 2026-10-22. Free, no API key.
 *
 * Terms of use honoured here:
 *   - Scryfall asks for a descriptive User-Agent and an explicit Accept header.
 *   - Requests are spaced to respect their rate-limit guidance.
 *   - Their data may not be paywalled. This is a private personal tool and
 *     does not redistribute or gate the data, so that condition is satisfied.
 *
 * Prices are a once-daily snapshot per finish (usd, usd_foil, usd_etched).
 * They are market/listing-derived, NOT condition-specific and NOT individual
 * completed sales, so they are emitted as market_estimate only.
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

const BASE = 'https://api.scryfall.com';

const HEADERS = {
  // Scryfall explicitly requests that clients identify themselves.
  'User-Agent': 'CardVaultAI/0.1 (private inventory tool)',
  Accept: 'application/json',
};

/** Scryfall asks for ~100ms between requests. */
let lastCall = 0;
async function throttle() {
  const wait = 100 - (Date.now() - lastCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

interface ScryfallCard {
  id: string;
  name: string;
  lang: string;
  set: string;
  set_name: string;
  collector_number: string;
  rarity?: string;
  released_at?: string;
  scryfall_uri?: string;
  promo?: boolean;
  finishes?: string[];
  image_uris?: { normal?: string; small?: string; large?: string };
  card_faces?: { image_uris?: { normal?: string; small?: string } }[];
  prices?: Record<string, string | null>;
}

interface SearchResponse {
  data?: ScryfallCard[];
  total_cards?: number;
}

const FINISH_LABELS: Record<string, string> = {
  nonfoil: 'Non-foil',
  foil: 'Foil',
  etched: 'Etched Foil',
  glossy: 'Glossy',
};

function image(card: ScryfallCard): string | undefined {
  return card.image_uris?.normal ?? card.card_faces?.[0]?.image_uris?.normal;
}

function toCandidate(card: ScryfallCard, finish?: string): CardCandidate {
  return {
    providerId: 'scryfall',
    externalId: card.id,
    externalUrl: card.scryfall_uri,
    game: 'mtg',
    name: card.name,
    setName: card.set_name,
    setCode: card.set,
    collectorNumber: card.collector_number,
    language: card.lang,
    rarity: card.rarity,
    finish: finish ? FINISH_LABELS[finish] ?? finish : undefined,
    isPromo: card.promo,
    releaseYear: card.released_at ? Number(card.released_at.slice(0, 4)) : undefined,
    imageUrl: image(card),
    attributes: { finishes: card.finishes ?? [] },
  };
}

export class ScryfallProvider implements CatalogProvider, PricingProvider {
  readonly id = 'scryfall';
  readonly label = 'Scryfall';
  readonly homepage = 'https://scryfall.com';
  readonly games = ['mtg'] as const satisfies readonly ('mtg')[];

  readonly capabilities = {
    conditionSpecific: false,
    gradedPricing: false,
    individualSales: false,
  };

  isConfigured(): boolean {
    return true;
  }

  async search(query: CatalogQuery): Promise<CardCandidate[]> {
    const parts: string[] = [];
    if (query.name.trim()) parts.push(`"${query.name.trim().replace(/"/g, '')}"`);
    if (query.setCode) parts.push(`set:${query.setCode.trim()}`);
    if (query.collectorNumber) parts.push(`cn:${query.collectorNumber.trim()}`);
    if (query.language && query.language !== 'en') parts.push(`lang:${query.language}`);
    if (parts.length === 0) return [];

    // unique:prints returns each printing separately rather than collapsing
    // them, which is what a reseller needs -- printings price differently.
    const params = new URLSearchParams({
      q: parts.join(' '),
      unique: 'prints',
      order: 'released',
      dir: 'desc',
    });

    await throttle();
    try {
      const res = await getJson<SearchResponse>(`${BASE}/cards/search?${params}`, {
        headers: HEADERS,
        signal: query.signal,
      });
      return (res.data ?? []).slice(0, query.limit ?? 24).map((c) => toCandidate(c));
    } catch (err) {
      // Scryfall returns 404 for "no cards matched", which is not an error.
      if (err && typeof err === 'object' && 'status' in err && err.status === 404) return [];
      throw err;
    }
  }

  async getById(externalId: string): Promise<CardCandidate | null> {
    await throttle();
    try {
      const card = await getJson<ScryfallCard>(`${BASE}/cards/${externalId}`, { headers: HEADERS });
      return toCandidate(card);
    } catch {
      return null;
    }
  }

  async listPrintings(externalId: string): Promise<CardCandidate[]> {
    await throttle();
    const card = await getJson<ScryfallCard>(`${BASE}/cards/${externalId}`, { headers: HEADERS });
    const finishes = card.finishes ?? [];
    if (finishes.length <= 1) return [toCandidate(card, finishes[0])];
    return finishes.map((f) => toCandidate(card, f));
  }

  async fetchPrices(lookup: PriceLookup): Promise<PricingProviderResult> {
    if (!lookup.externalId) {
      return {
        provider: this.id,
        status: 'not_found',
        claims: [],
        message: 'This item is not linked to a Scryfall card.',
      };
    }

    await throttle();
    let card: ScryfallCard;
    try {
      card = await getJson<ScryfallCard>(`${BASE}/cards/${lookup.externalId}`, {
        headers: HEADERS,
        signal: lookup.signal,
      });
    } catch (err) {
      return {
        provider: this.id,
        status: 'error',
        claims: [],
        message: err instanceof Error ? err.message : 'Request failed',
        manualUrl: `https://scryfall.com/search?q=${encodeURIComponent(lookup.name)}`,
      };
    }

    const retrievedAt = new Date().toISOString();
    const claims: PriceClaim[] = [];

    const MAP: Record<string, { currency: string; finish: string }> = {
      usd: { currency: 'USD', finish: 'Non-foil' },
      usd_foil: { currency: 'USD', finish: 'Foil' },
      usd_etched: { currency: 'USD', finish: 'Etched Foil' },
      eur: { currency: 'EUR', finish: 'Non-foil' },
      eur_foil: { currency: 'EUR', finish: 'Foil' },
    };

    for (const [key, meta] of Object.entries(MAP)) {
      const raw = card.prices?.[key];
      const cents = decimalToCents(raw == null ? null : Number(raw), meta.currency);
      if (cents == null) continue;
      claims.push({
        provider: 'scryfall',
        claimType: 'market_estimate',
        priceCents: cents,
        currency: meta.currency,
        condition: null,
        finish: meta.finish,
        observedAt: null,
        retrievedAt,
        sourceUrl: card.scryfall_uri ?? null,
        status: 'ok',
        notes:
          'Scryfall daily price snapshot. Near-Mint-anchored and not condition-specific; not a record of a completed sale.',
        raw: { key },
      });
    }

    if (claims.length === 0) {
      return {
        provider: this.id,
        status: 'not_found',
        claims: [],
        message: 'Scryfall has no price for this printing.',
        manualUrl: card.scryfall_uri,
      };
    }
    return { provider: this.id, status: 'ok', claims, manualUrl: card.scryfall_uri };
  }
}

export const scryfall = new ScryfallProvider();
