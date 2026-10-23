/**
 * TCGdex — Pokemon catalog and price snapshot provider.
 *
 * Verified against the live API on 2026-10-22:
 *   - Free, open source, no API key, no registration.
 *   - Multi-language (en, ja, fr, de, es, it, pt, ...), which matters because
 *     Japanese singles are routine inventory for Pokemon resellers.
 *   - Card detail includes `variants_detailed[].pricing` carrying Cardmarket
 *     (EUR) and TCGplayer (USD) figures with their own `updated` timestamps.
 *
 * KNOWN LIMITATION, surfaced to the operator rather than hidden:
 * the pricing is per-FINISH, not per-CONDITION. TCGplayer's own API exposes
 * NM/LP/MP/HP/DMG tiers; TCGdex surfaces only the finish-level aggregate,
 * which is effectively Near-Mint-anchored. This provider therefore reports
 * conditionSpecific: false, and the valuation engine refuses to present these
 * figures as a condition-matched price for a played card.
 */

import { getJson, memoizeOnce } from '../../lib/http';
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

const BASE = 'https://api.tcgdex.net/v2';

export const TCGDEX_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'ja', label: 'Japanese' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'es', label: 'Spanish' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh-tw', label: 'Chinese (Traditional)' },
] as const;

interface BriefCard {
  id: string;
  localId: string;
  name: string;
  image?: string;
}

interface SetBrief {
  id: string;
  name: string;
  releaseDate?: string;
  cardCount?: { total?: number; official?: number };
}

interface TcgPlayerFinishPrices {
  productId?: number;
  lowPrice?: number | null;
  midPrice?: number | null;
  highPrice?: number | null;
  marketPrice?: number | null;
  directLowPrice?: number | null;
}

interface VariantDetailed {
  type?: string;
  size?: string;
  variantId?: string;
  thirdParty?: Record<string, number>;
  pricing?: {
    cardmarket?: Record<string, unknown> & { updated?: string; unit?: string };
    tcgplayer?: Record<string, unknown> & { updated?: string; unit?: string };
  };
}

interface FullCard {
  id: string;
  localId: string;
  name: string;
  image?: string;
  rarity?: string;
  illustrator?: string;
  category?: string;
  set?: {
    id: string;
    name: string;
    releaseDate?: string;
    cardCount?: { total?: number; official?: number };
  };
  variants?: Record<string, boolean>;
  variants_detailed?: VariantDetailed[];
}

/** One request per session gives us set id -> name for the whole catalogue. */
const loadSets = memoizeOnce(async () => {
  const sets = await getJson<SetBrief[]>(`${BASE}/en/sets`, { timeoutMs: 20_000 });
  const byId = new Map<string, SetBrief>();
  for (const s of sets) byId.set(s.id, s);
  return byId;
});

/**
 * Card ids are `{setId}-{localId}` and set ids themselves contain hyphens
 * (e.g. "30th-c-001"). Stripping the known localId suffix is exact; splitting
 * on "-" is not.
 */
function setIdFromCardId(id: string, localId: string): string {
  const suffix = `-${localId}`;
  return id.endsWith(suffix) ? id.slice(0, -suffix.length) : id.split('-')[0];
}

function imageUrl(base: string | undefined, quality: 'high' | 'low' = 'high'): string | undefined {
  return base ? `${base}/${quality}.webp` : undefined;
}

/** TCGdex variant keys -> human labels used consistently across the app. */
const FINISH_LABELS: Record<string, string> = {
  normal: 'Normal',
  holo: 'Holofoil',
  reverse: 'Reverse Holofoil',
  firstEdition: '1st Edition',
  wPromo: 'Promo',
};

/**
 * TCGplayer nests its prices under its OWN finish keys, which do not match
 * TCGdex's variant keys ("reverseHolofoil" vs "reverse"). Mapping them to the
 * same display labels lets us filter TCGplayer's sub-prices down to the single
 * finish the operator actually owns.
 */
const TCGPLAYER_FINISH_LABELS: Record<string, string> = {
  normal: 'Normal',
  holofoil: 'Holofoil',
  reverseHolofoil: 'Reverse Holofoil',
  '1stEdition': '1st Edition',
  '1stEditionHolofoil': '1st Edition Holofoil',
  '1stEditionNormal': '1st Edition',
  unlimited: 'Unlimited',
  unlimitedHolofoil: 'Holofoil',
};

function yearFrom(date?: string): number | undefined {
  if (!date) return undefined;
  const y = Number(String(date).slice(0, 4));
  return Number.isFinite(y) ? y : undefined;
}

async function toCandidate(card: FullCard, language: string): Promise<CardCandidate> {
  const sets = await loadSets().catch(() => new Map<string, SetBrief>());
  const setId = card.set?.id ?? setIdFromCardId(card.id, card.localId);
  const set = card.set ?? sets.get(setId);

  return {
    providerId: 'tcgdex',
    externalId: card.id,
    externalUrl: `https://tcgdex.dev/cards/${card.id}`,
    game: 'pokemon',
    name: card.name,
    setName: set?.name,
    setCode: setId,
    collectorNumber: card.localId,
    setTotal: set?.cardCount?.official ?? set?.cardCount?.total,
    language,
    rarity: card.rarity,
    imageUrl: imageUrl(card.image),
    releaseYear: yearFrom(card.set?.releaseDate ?? (set as SetBrief | undefined)?.releaseDate),
    attributes: {
      illustrator: card.illustrator,
      category: card.category,
      availableVariants: card.variants ?? {},
    },
  };
}

export class TcgdexProvider implements CatalogProvider, PricingProvider {
  readonly id = 'tcgdex';
  readonly label = 'TCGdex';
  readonly homepage = 'https://tcgdex.dev';
  readonly games = ['pokemon'] as const satisfies readonly ('pokemon')[];

  readonly capabilities = {
    // Per-finish only. See the file header -- this is the honest answer, and
    // the UI uses it to refuse to call an NM figure an MP price.
    conditionSpecific: false,
    gradedPricing: false,
    individualSales: false,
  };

  /** No key required, so this provider is always available. */
  isConfigured(): boolean {
    return true;
  }

  async search(query: CatalogQuery): Promise<CardCandidate[]> {
    const lang = query.language ?? 'en';
    const limit = query.limit ?? 24;

    const params = new URLSearchParams();
    const term = query.name.trim();
    if (term) params.set('name', `like:${term}`);
    if (query.collectorNumber) params.set('localId', query.collectorNumber.trim());
    if (query.setCode) params.set('set', query.setCode.trim());
    params.set('pagination:page', '1');
    params.set('pagination:itemsPerPage', String(Math.min(limit, 60)));

    const brief = await getJson<BriefCard[]>(`${BASE}/${lang}/cards?${params}`, {
      signal: query.signal,
    });

    const sets = await loadSets().catch(() => new Map<string, SetBrief>());

    return brief.map((c) => {
      const setId = setIdFromCardId(c.id, c.localId);
      const set = sets.get(setId);
      return {
        providerId: 'tcgdex',
        externalId: c.id,
        externalUrl: `https://tcgdex.dev/cards/${c.id}`,
        game: 'pokemon',
        name: c.name,
        setName: set?.name,
        setCode: setId,
        collectorNumber: c.localId,
        setTotal: set?.cardCount?.official ?? set?.cardCount?.total,
        language: lang,
        // Deliberately absent from search results: rarity and finish require
        // the detail call. Showing a guess here would be inventing data.
        imageUrl: imageUrl(c.image, 'low'),
        releaseYear: yearFrom(set?.releaseDate),
      } satisfies CardCandidate;
    });
  }

  async getById(externalId: string, language = 'en'): Promise<CardCandidate | null> {
    try {
      const card = await getJson<FullCard>(`${BASE}/${language}/cards/${externalId}`);
      return await toCandidate(card, language);
    } catch {
      return null;
    }
  }

  /** One candidate per actually-printed finish, each separately ownable. */
  async listPrintings(externalId: string, language = 'en'): Promise<CardCandidate[]> {
    const card = await getJson<FullCard>(`${BASE}/${language}/cards/${externalId}`);
    const base = await toCandidate(card, language);

    const detailed = card.variants_detailed ?? [];
    if (detailed.length > 0) {
      return detailed.map((v) => ({
        ...base,
        finish: FINISH_LABELS[v.type ?? ''] ?? v.type ?? undefined,
        variant: v.size && v.size !== 'standard' ? v.size : undefined,
        attributes: { ...base.attributes, variantId: v.variantId, thirdParty: v.thirdParty },
      }));
    }

    // Older sets expose only the boolean `variants` map.
    const flags = Object.entries(card.variants ?? {}).filter(([, on]) => on);
    if (flags.length === 0) return [base];
    return flags.map(([key]) => ({
      ...base,
      finish: FINISH_LABELS[key] ?? key,
      edition: key === 'firstEdition' ? '1st Edition' : undefined,
      isPromo: key === 'wPromo' || undefined,
    }));
  }

  // -------------------------------------------------------------------------
  // PricingProvider
  // -------------------------------------------------------------------------

  async fetchPrices(lookup: PriceLookup): Promise<PricingProviderResult> {
    if (!lookup.externalId) {
      return {
        provider: this.id,
        status: 'not_found',
        claims: [],
        message: 'This item is not linked to a TCGdex catalog card, so no price can be retrieved.',
      };
    }

    let card: FullCard;
    try {
      card = await getJson<FullCard>(
        `${BASE}/${lookup.language ?? 'en'}/cards/${lookup.externalId}`,
        { signal: lookup.signal }
      );
    } catch (err) {
      return {
        provider: this.id,
        status: 'error',
        claims: [],
        message: err instanceof Error ? err.message : 'Request failed',
        manualUrl: `https://tcgdex.dev/cards/${lookup.externalId}`,
      };
    }

    const retrievedAt = new Date().toISOString();
    const claims: PriceClaim[] = [];

    const variants = card.variants_detailed ?? [];
    const wantedKey = Object.entries(FINISH_LABELS).find(
      ([, label]) => label.toLowerCase() === (lookup.finish ?? '').toLowerCase()
    )?.[0];

    // Finish matching is deliberately strict.
    //
    // If the caller named a finish, only an exact match will do -- a reverse
    // holo and a holo of the same card are different objects at different
    // prices, and returning one for the other is a silent mispricing. The
    // single-variant fallback applies ONLY when no finish was specified, i.e.
    // when there is genuinely nothing to disambiguate.
    const variant = lookup.finish
      ? variants.find((v) => v.type === wantedKey)
      : variants.length === 1
        ? variants[0]
        : undefined;

    if (!variant) {
      const available = variants
        .map((v) => FINISH_LABELS[v.type ?? ''] ?? v.type)
        .filter(Boolean)
        .join(', ');

      let message: string;
      if (variants.length === 0) {
        message = 'TCGdex has no pricing for this card.';
      } else if (lookup.finish) {
        message =
          `No price for the "${lookup.finish}" printing of this card. ` +
          `TCGdex lists prices for: ${available}. ` +
          `Prices are not interchangeable between finishes, so none is shown.`;
      } else {
        message =
          `This card has ${variants.length} printings (${available}) at different prices. ` +
          `Set the finish on this item to get the right one.`;
      }

      return {
        provider: this.id,
        status: 'not_found',
        claims: [],
        message,
        manualUrl: `https://tcgdex.dev/cards/${card.id}`,
      };
    }

    const finishLabel = FINISH_LABELS[variant.type ?? ''] ?? variant.type ?? null;

    // --- Cardmarket (EUR) --------------------------------------------------
    const cm = variant.pricing?.cardmarket;
    if (cm) {
      const unit = (cm.unit as string) ?? 'EUR';
      const observedAt = (cm.updated as string) ?? null;
      const push = (
        key: string,
        claimType: PriceClaim['claimType'],
        notes: string
      ) => {
        const cents = decimalToCents(cm[key] as number | null, unit);
        if (cents == null) return;
        claims.push({
          provider: 'cardmarket (via TCGdex)',
          claimType,
          priceCents: cents,
          currency: unit,
          condition: null,
          finish: finishLabel,
          observedAt: claimType === 'sold_observation' ? observedAt : null,
          retrievedAt,
          sourceUrl: `https://tcgdex.dev/cards/${card.id}`,
          status: 'ok',
          notes,
          raw: { key, updated: cm.updated },
        });
      };

      // Cardmarket's avgN series are averages of REAL completed sales over the
      // trailing N days -- genuinely sold-derived, but aggregates, not single
      // transactions. They are therefore sold_aggregate, never sold_observation.
      push('avg7', 'sold_aggregate', 'Cardmarket average of sales over the last 7 days.');
      push('avg30', 'sold_aggregate', 'Cardmarket average of sales over the last 30 days.');
      push('avg', 'sold_aggregate', 'Cardmarket all-time average sale price.');
      push('trend', 'market_estimate', "Cardmarket's own trend price. A derived figure, not a sale.");
      push('low', 'asking_price', 'Lowest current Cardmarket offer. Nobody has paid this.');
    }

    // --- TCGplayer (USD) ---------------------------------------------------
    const tp = variant.pricing?.tcgplayer;
    if (tp) {
      const unit = (tp.unit as string) ?? 'USD';
      for (const [finishKey, value] of Object.entries(tp)) {
        if (finishKey === 'unit' || finishKey === 'updated' || value == null) continue;
        if (typeof value !== 'object') continue;
        const p = value as TcgPlayerFinishPrices;
        const sub = TCGPLAYER_FINISH_LABELS[finishKey] ?? finishKey;

        // Same strictness as the variant selection above: when the operator
        // has told us which finish they own, TCGplayer's other finishes are
        // prices for a different object and must not be reported.
        if (finishLabel && sub !== finishLabel) continue;

        const push = (
          cents: number | null,
          claimType: PriceClaim['claimType'],
          notes: string
        ) => {
          if (cents == null) return;
          claims.push({
            provider: 'tcgplayer (via TCGdex)',
            claimType,
            priceCents: cents,
            currency: unit,
            // Explicitly null: TCGdex does not expose per-condition tiers.
            condition: null,
            finish: sub,
            observedAt: null,
            retrievedAt,
            sourceUrl: `https://tcgdex.dev/cards/${card.id}`,
            status: 'ok',
            notes,
            raw: { finishKey, updated: tp.updated },
          });
        };

        push(
          decimalToCents(p.marketPrice ?? null, unit),
          'market_estimate',
          'TCGplayer Market Price. Derived from recent sales, and Near-Mint-anchored — it is not a condition-specific price.'
        );
        push(
          decimalToCents(p.lowPrice ?? null, unit),
          'asking_price',
          'Lowest current TCGplayer listing.'
        );
        push(
          decimalToCents(p.midPrice ?? null, unit),
          'asking_price',
          'Midpoint of current TCGplayer listings.'
        );
      }
    }

    if (claims.length === 0) {
      return {
        provider: this.id,
        status: 'not_found',
        claims: [],
        message: 'TCGdex returned this card but carries no price data for it.',
        manualUrl: `https://tcgdex.dev/cards/${card.id}`,
      };
    }

    return {
      provider: this.id,
      status: 'ok',
      claims,
      manualUrl: `https://tcgdex.dev/cards/${card.id}`,
    };
  }
}

export const tcgdex = new TcgdexProvider();
