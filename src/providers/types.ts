/**
 * Provider contracts.
 *
 * Two separate concerns deliberately kept apart:
 *
 *   CatalogProvider  — answers "which card is this?" (identity)
 *   PricingProvider  — answers "what is it worth?" (valuation)
 *
 * A provider may implement both (TCGdex does), but the interfaces never merge,
 * because identity must stay trustworthy even when pricing is unavailable.
 */

export type TcgGame =
  | 'pokemon' | 'mtg' | 'yugioh' | 'onepiece'
  | 'lorcana' | 'digimon' | 'sports' | 'other';

export type CardCondition = 'NM' | 'LP' | 'MP' | 'HP' | 'DMG' | 'NEEDS_REVIEW';

export const CONDITIONS: { value: CardCondition; label: string; hint: string }[] = [
  { value: 'NM',  label: 'Near Mint',        hint: 'Pack fresh; at most minor edge wear under close inspection' },
  { value: 'LP',  label: 'Lightly Played',   hint: 'Minor border or corner wear, light scratching' },
  { value: 'MP',  label: 'Moderately Played',hint: 'Obvious whitening, light creasing, surface wear' },
  { value: 'HP',  label: 'Heavily Played',   hint: 'Major whitening, creasing, or surface damage' },
  { value: 'DMG', label: 'Damaged',          hint: 'Tears, water damage, writing, or heavy creasing' },
  { value: 'NEEDS_REVIEW', label: 'Needs condition review', hint: 'Not yet assessed' },
];

/**
 * The defects an operator can flag. The AI may later suggest these, but a
 * suggestion is never the saved value -- condition is always operator-confirmed.
 */
export const DEFECT_FLAGS = [
  'whitening', 'scratches', 'dents', 'creases',
  'edge_wear', 'surface_damage', 'print_defect', 'off_centre',
] as const;
export type DefectFlag = (typeof DEFECT_FLAGS)[number];

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/**
 * A *candidate* match. The name is deliberate: this is a suggestion that the
 * operator must confirm, never a resolved identity. Nothing in the app writes
 * a candidate straight to inventory.
 */
export interface CardCandidate {
  providerId: string;
  externalId: string;
  externalUrl?: string;

  game: TcgGame;
  name: string;
  setName?: string;
  setCode?: string;
  collectorNumber?: string;
  /** Printed set size, e.g. the 165 in "199/165". */
  setTotal?: number;
  language: string;
  rarity?: string;
  finish?: string;
  variant?: string;
  edition?: string;
  isPromo?: boolean;
  releaseYear?: number;
  imageUrl?: string;

  /** Game-specific extras that do not deserve a column. */
  attributes?: Record<string, unknown>;
}

export interface CatalogQuery {
  game: TcgGame;
  /** Free-text name fragment. */
  name: string;
  /** Optional narrowing hints supplied by the operator. */
  collectorNumber?: string;
  setCode?: string;
  language?: string;
  limit?: number;
  signal?: AbortSignal;
}

export interface CatalogProvider {
  id: string;
  label: string;
  /** Link shown to the operator so they can verify a match themselves. */
  homepage: string;
  games: readonly TcgGame[];
  /** False when the provider needs credentials that are not configured. */
  isConfigured(): boolean;
  search(query: CatalogQuery): Promise<CardCandidate[]>;
  getById(externalId: string, language?: string): Promise<CardCandidate | null>;
  /**
   * Expand one catalog entry into its separately-collectable printings.
   *
   * This matters more than it sounds: a Pokemon card's holo, reverse-holo and
   * non-holo printings share a name, set and collector number but are
   * different objects with materially different prices. Collapsing them would
   * silently mis-price inventory, so the operator picks the exact printing.
   */
  listPrintings?(externalId: string, language?: string): Promise<CardCandidate[]>;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * Mirrors the price_claim_type enum in the database. The distinction between
 * these is the single most important thing in the pricing engine: it is what
 * stops an asking price being presented as a completed sale.
 */
export type PriceClaimType =
  | 'sold_observation'
  | 'sold_aggregate'
  | 'market_estimate'
  | 'asking_price'
  | 'ai_estimate'
  | 'manual';

export const CLAIM_LABELS: Record<PriceClaimType, string> = {
  sold_observation: 'Completed sale',
  sold_aggregate: 'Average of completed sales',
  market_estimate: 'Market estimate',
  asking_price: 'Current asking price',
  ai_estimate: 'AI estimate',
  manual: 'Entered manually',
};

/** Short explanation shown beside a price so its meaning is never ambiguous. */
export const CLAIM_DESCRIPTIONS: Record<PriceClaimType, string> = {
  sold_observation: 'One real transaction that completed on a given date.',
  sold_aggregate: "The provider's own average over recent completed sales.",
  market_estimate: "The provider's derived market price. Not a single transaction.",
  asking_price: 'What someone is asking today. No evidence anyone paid it.',
  ai_estimate: 'Produced by a model. Treat as a starting point only.',
  manual: 'You entered this value yourself.',
};

/** Only these claim types may be averaged into a sold comp. */
export const COMP_ELIGIBLE: ReadonlySet<PriceClaimType> = new Set<PriceClaimType>([
  'sold_observation',
]);

export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'unavailable';

export type RetrievalStatus = 'ok' | 'not_found' | 'error' | 'unconfigured' | 'stale';

/** One price, as reported by one source, with everything needed to judge it. */
export interface PriceClaim {
  provider: string;
  claimType: PriceClaimType;
  priceCents: number | null;
  currency: string;

  /** What the price was for -- used to reject mismatched comparisons. */
  condition?: CardCondition | null;
  gradingCompany?: string | null;
  grade?: number | null;
  finish?: string | null;
  variant?: string | null;

  /** Required for sold_observation: when the transaction completed. */
  observedAt?: string | null;
  retrievedAt: string;
  externalId?: string | null;
  sourceUrl?: string | null;
  status: RetrievalStatus;
  notes?: string | null;
  raw?: unknown;
}

export interface PriceLookup {
  game: TcgGame;
  externalId?: string;
  name: string;
  setCode?: string;
  collectorNumber?: string;
  language?: string;
  finish?: string;
  condition?: CardCondition;
  gradingCompany?: string;
  grade?: number;
  signal?: AbortSignal;
}

export interface PricingProviderResult {
  provider: string;
  status: RetrievalStatus;
  claims: PriceClaim[];
  /** Operator-facing explanation when status is not 'ok'. */
  message?: string;
  /** Where the operator can go to check this themselves. */
  manualUrl?: string;
}

export interface PricingProvider {
  id: string;
  label: string;
  homepage: string;
  games: readonly TcgGame[];
  /**
   * What this provider can actually deliver. Surfaced in Settings so the app
   * never implies a capability it does not have.
   */
  capabilities: {
    conditionSpecific: boolean;
    gradedPricing: boolean;
    individualSales: boolean;
  };
  isConfigured(): boolean;
  /** Why it is unconfigured, shown verbatim in Settings. */
  configurationNote?: string;
  fetchPrices(lookup: PriceLookup): Promise<PricingProviderResult>;
}
