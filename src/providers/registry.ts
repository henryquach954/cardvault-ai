/**
 * Provider registry.
 *
 * Every provider named anywhere in the product appears here, including the
 * ones that cannot currently be used. That is deliberate: a provider that is
 * absent from the UI looks like an oversight, whereas a provider listed as
 * "Unavailable" with a verified reason is information the operator can act on.
 *
 * Nothing in this file claims a connection. `isConfigured()` is the only thing
 * that grants a provider the right to contribute a price, and the unavailable
 * providers below hard-code it to false.
 */

import { tcgdex } from './catalog/tcgdex';
import { scryfall } from './catalog/scryfall';
import { ygoprodeck } from './catalog/ygoprodeck';
import type {
  CatalogProvider,
  PriceLookup,
  PricingProvider,
  PricingProviderResult,
  TcgGame,
} from './types';

export const GAMES: { value: TcgGame; label: string; catalog: string | null }[] = [
  { value: 'pokemon',  label: 'Pokémon',             catalog: 'tcgdex' },
  { value: 'mtg',      label: 'Magic: The Gathering', catalog: 'scryfall' },
  { value: 'yugioh',   label: 'Yu-Gi-Oh!',            catalog: 'ygoprodeck' },
  { value: 'onepiece', label: 'One Piece',            catalog: null },
  { value: 'lorcana',  label: 'Lorcana',              catalog: null },
  { value: 'digimon',  label: 'Digimon',              catalog: null },
  { value: 'sports',   label: 'Sports cards',         catalog: null },
  { value: 'other',    label: 'Other',                catalog: null },
];

export const CATALOG_PROVIDERS: CatalogProvider[] = [tcgdex, scryfall, ygoprodeck];

export function catalogProviderFor(game: TcgGame): CatalogProvider | null {
  return CATALOG_PROVIDERS.find((p) => (p.games as readonly string[]).includes(game)) ?? null;
}

// ---------------------------------------------------------------------------
// Providers that exist in the market but cannot currently be integrated.
// ---------------------------------------------------------------------------

interface UnavailableSpec {
  id: string;
  label: string;
  homepage: string;
  games: readonly TcgGame[];
  capabilities: PricingProvider['capabilities'];
  /** Verified reason, shown verbatim in Settings. Checked 2026-10-22. */
  reason: string;
  /** What the operator would have to do to change this, if anything. */
  path: string;
}

const UNAVAILABLE: UnavailableSpec[] = [
  {
    id: 'tcgplayer',
    label: 'TCGplayer',
    homepage: 'https://docs.tcgplayer.com',
    games: ['pokemon', 'mtg', 'yugioh', 'onepiece', 'lorcana'],
    capabilities: { conditionSpecific: true, gradedPricing: false, individualSales: false },
    reason:
      'TCGplayer closed its API programme to new applicants. Existing partners retain access; new keys are not being issued.',
    path:
      'No action available. Condition-specific TCGplayer pricing reaches this app only through a licensed reseller of that data.',
  },
  {
    id: 'cardladder',
    label: 'Card Ladder',
    homepage: 'https://www.cardladder.com',
    games: ['pokemon', 'sports', 'mtg'],
    capabilities: { conditionSpecific: false, gradedPricing: true, individualSales: true },
    reason:
      'Card Ladder publishes no public developer API. The only programmatic access on offer is third-party scrapers, which this app will not use.',
    path:
      'Use the manual comp entry workflow: look the card up on Card Ladder yourself and record the sales you find. They are stored as real, dated sold observations.',
  },
  {
    id: 'alt',
    label: 'ALT',
    homepage: 'https://alt.xyz',
    games: ['pokemon', 'sports'],
    capabilities: { conditionSpecific: false, gradedPricing: true, individualSales: true },
    reason:
      'ALT publishes no general developer API. A certification-number lookup is referenced publicly but appears to be partner-gated; this could not be verified.',
    path: 'Use manual comp entry, or contact ALT directly about partner API access.',
  },
  {
    id: 'ebay_sold',
    label: 'eBay — sold listings',
    homepage: 'https://developer.ebay.com',
    games: ['pokemon', 'mtg', 'yugioh', 'onepiece', 'sports', 'other'],
    capabilities: { conditionSpecific: false, gradedPricing: true, individualSales: true },
    reason:
      'eBay retired findCompletedItems in February 2025. The Browse API returns active listings only. Sold data lives in the Marketplace Insights API, a limited-release programme that is not open to new applicants, and eBay placed sold listings behind a sign-in wall in July 2026.',
    path:
      'You can apply to eBay for Marketplace Insights access with a business case, but approval is rare. Until then, record eBay comps through manual entry.',
  },
  {
    id: 'scrydex',
    label: 'Scrydex',
    homepage: 'https://scrydex.com',
    games: ['pokemon', 'mtg', 'onepiece', 'lorcana'],
    capabilities: { conditionSpecific: true, gradedPricing: true, individualSales: true },
    reason:
      'Scrydex is a paid API with no free tier. It is the designated successor to the deprecated Pokémon TCG API and is the only verified source offering condition-specific raw pricing together with graded pricing and sold history.',
    path:
      'Subscribe at scrydex.com (plans start around $29/month), then add the API key in Settings. The adapter is ready and will activate automatically.',
  },
];

/** A pricing provider that always, honestly, declines to produce a price. */
class UnavailableProvider implements PricingProvider {
  readonly id: string;
  readonly label: string;
  readonly homepage: string;
  readonly games: readonly TcgGame[];
  readonly capabilities: PricingProvider['capabilities'];
  readonly configurationNote: string;
  readonly remediation: string;

  constructor(spec: UnavailableSpec) {
    this.id = spec.id;
    this.label = spec.label;
    this.homepage = spec.homepage;
    this.games = spec.games;
    this.capabilities = spec.capabilities;
    this.configurationNote = spec.reason;
    this.remediation = spec.path;
  }

  isConfigured(): boolean {
    return false;
  }

  async fetchPrices(_lookup: PriceLookup): Promise<PricingProviderResult> {
    return {
      provider: this.id,
      status: 'unconfigured',
      claims: [],
      message: this.configurationNote,
      manualUrl: this.homepage,
    };
  }
}

export const UNAVAILABLE_PROVIDERS = UNAVAILABLE.map((s) => new UnavailableProvider(s));

export const PRICING_PROVIDERS: PricingProvider[] = [
  tcgdex,
  scryfall,
  ygoprodeck,
  ...UNAVAILABLE_PROVIDERS,
];

export function pricingProvidersFor(game: TcgGame): PricingProvider[] {
  return PRICING_PROVIDERS.filter((p) => p.games.includes(game));
}

/** Only providers that are genuinely usable right now. */
export function activePricingProvidersFor(game: TcgGame): PricingProvider[] {
  return pricingProvidersFor(game).filter((p) => p.isConfigured());
}
