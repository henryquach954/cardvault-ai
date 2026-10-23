/**
 * The storage contract.
 *
 * Two backends implement this:
 *   local.ts     — IndexedDB in the browser. No account, single device.
 *   supabase.ts  — hosted Postgres. Multi-device, authenticated, backed up.
 *
 * Pages never import a backend directly; they go through `src/lib/db.ts`,
 * which delegates to whichever is active. That is what makes switching a
 * configuration change rather than a rewrite.
 */

import type {
  CardCandidate, CardCondition, PriceClaim, TcgGame,
} from '../../providers/types';

// ---------------------------------------------------------------------------
// Row shapes — identical in both backends, matching the SQL schema
// ---------------------------------------------------------------------------

export interface CatalogCardRow {
  id: string;
  user_id: string;
  game: TcgGame;
  name: string;
  set_name: string | null;
  set_code: string | null;
  collector_number: string | null;
  language: string;
  rarity: string | null;
  finish: string | null;
  variant: string | null;
  edition: string | null;
  is_promo: boolean;
  release_year: number | null;
  sport: string | null;
  player: string | null;
  team: string | null;
  manufacturer: string | null;
  parallel: string | null;
  has_autograph: boolean | null;
  has_memorabilia: boolean | null;
  attributes: Record<string, unknown>;
  catalog_source: string | null;
  catalog_image_url: string | null;
  created_at: string;
  updated_at: string;
}

export type ItemKind = 'raw_single' | 'graded_slab' | 'sealed_product' | 'bulk_group';

export type InventoryStatus =
  | 'in_stock' | 'reserved' | 'allocated_to_lot' | 'listed' | 'sold' | 'removed';

export interface InventoryItemRow {
  id: string;
  user_id: string;
  catalog_card_id: string | null;
  kind: ItemKind;
  sku: string | null;
  status: InventoryStatus;
  quantity: number;
  quantity_sold: number;
  quantity_allocated: number;
  /** Derived: quantity − sold − allocated. Never written directly. */
  quantity_available: number;
  condition: CardCondition;
  condition_notes: string | null;
  defects: Record<string, boolean>;
  grading_company: string | null;
  grade: number | null;
  cert_number: string | null;
  grade_verified: boolean;
  currency: string;
  purchase_cost_cents: number | null;
  acquisition_date: string | null;
  acquisition_source: string | null;
  asking_price_cents: number | null;
  minimum_price_cents: number | null;
  market_value_cents: number | null;
  market_value_override_cents: number | null;
  market_value_confidence: string | null;
  market_value_method: string | null;
  last_price_refresh_at: string | null;
  storage_location: string | null;
  notes: string | null;
  listed_at: string | null;
  sold_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface InventoryImageRow {
  id: string;
  user_id: string;
  inventory_item_id: string;
  storage_path: string;
  face: 'front' | 'back' | 'detail' | 'slab' | 'other';
  sort_order: number;
  created_at: string;
}

export interface PricingSettingsRow {
  user_id: string;
  default_currency: string;
  asking_price_strategy: string;
  markup_percent: number;
  markup_fixed_cents: number;
  target_profit_percent: number | null;
  stale_after_days: number;
  min_sales_for_comp: number;
  max_sales_for_comp: number;
  condition_adjustments: Record<string, number>;
  apply_condition_adjustments: boolean;
}

export interface InventoryItemFull extends InventoryItemRow {
  card_catalog: CatalogCardRow | null;
  inventory_images: InventoryImageRow[];
}

export interface NewInventoryItem {
  id?: string;
  catalogCardId: string | null;
  kind: ItemKind;
  condition: CardCondition;
  conditionNotes?: string | null;
  defects?: Record<string, boolean>;
  quantity: number;
  currency: string;
  purchaseCostCents: number | null;
  acquisitionDate?: string | null;
  acquisitionSource?: string | null;
  storageLocation?: string | null;
  sku?: string | null;
  notes?: string | null;
  askingPriceCents?: number | null;
  minimumPriceCents?: number | null;
  gradingCompany?: string | null;
  grade?: number | null;
  certNumber?: string | null;
}

export interface InventoryFilters {
  search?: string;
  game?: TcgGame | 'all';
  condition?: CardCondition | 'all';
  status?: InventoryStatus | 'all';
  kind?: ItemKind | 'all';
  sort?: 'newest' | 'name' | 'value_desc' | 'cost_desc' | 'stale_price';
  limit?: number;
}

export interface DashboardTotals {
  itemCount: number;
  cardCount: number;
  totalCostCents: number;
  totalValueCents: number;
  valuedItemCount: number;
  listedCount: number;
  soldCount: number;
  needsIdentification: number;
  needsConditionReview: number;
}

// ---------------------------------------------------------------------------
// Sales and expenses
// ---------------------------------------------------------------------------

export type SaleChannel = 'ebay' | 'facebook' | 'mercari' | 'card_show' | 'manual' | 'other';

export const SALE_CHANNELS: { value: SaleChannel; label: string }[] = [
  { value: 'ebay', label: 'eBay' },
  { value: 'facebook', label: 'Facebook Marketplace' },
  { value: 'mercari', label: 'Mercari' },
  { value: 'card_show', label: 'Card show' },
  { value: 'manual', label: 'Direct / other' },
  { value: 'other', label: 'Other' },
];

export interface SaleRow {
  id: string;
  user_id: string;
  channel: SaleChannel;
  sold_at: string;
  buyer_note: string | null;
  currency: string;
  /** What the buyer paid for the goods, excluding shipping they were charged. */
  sale_price_cents: number;
  shipping_charged_cents: number;
  marketplace_fee_cents: number;
  shipping_cost_cents: number;
  packaging_cost_cents: number;
  other_fee_cents: number;
  refund_cents: number;
  /** Set when two sales land against the same item close together. */
  needs_review: boolean;
  review_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface SaleItemRow {
  id: string;
  user_id: string;
  sale_id: string;
  inventory_item_id: string | null;
  lot_id: string | null;
  quantity: number;
  /**
   * Cost and price are SNAPSHOT at the moment of sale. Editing an item's
   * purchase cost later must not silently rewrite historical profit.
   */
  unit_cost_cents: number | null;
  unit_price_cents: number | null;
  created_at: string;
}

/** A sale line joined to enough of the card to display it. */
export interface SaleLine extends SaleItemRow {
  card_name: string | null;
  set_name: string | null;
  collector_number: string | null;
  kind: ItemKind | null;
  grading_company: string | null;
  grade: number | null;
}

export interface SaleFull extends SaleRow {
  items: SaleLine[];
}

export interface NewSale {
  channel: SaleChannel;
  soldAt: string;
  currency: string;
  salePriceCents: number;
  shippingChargedCents?: number;
  marketplaceFeeCents?: number;
  shippingCostCents?: number;
  packagingCostCents?: number;
  otherFeeCents?: number;
  refundCents?: number;
  buyerNote?: string | null;
  items: { inventoryItemId: string; quantity: number; unitPriceCents?: number | null }[];
}

// ---------------------------------------------------------------------------
// Lots
// ---------------------------------------------------------------------------

export interface LotRow {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  game: TcgGame | null;
  status: InventoryStatus;
  currency: string;
  asking_price_cents: number | null;
  minimum_price_cents: number | null;
  card_count: number | null;
  storage_location: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface LotItemRow {
  id: string;
  user_id: string;
  lot_id: string;
  inventory_item_id: string;
  quantity: number;
  created_at: string;
}

/** A lot line joined to enough of the card to display and cost it. */
export interface LotLine extends LotItemRow {
  card_name: string | null;
  set_name: string | null;
  collector_number: string | null;
  condition: CardCondition | null;
  kind: ItemKind | null;
  grading_company: string | null;
  grade: number | null;
  /** Snapshot of the item's purchase cost, for the lot's cost basis. */
  unit_cost_cents: number | null;
}

export interface LotFull extends LotRow {
  items: LotLine[];
  /** Sum of the allocated cards' purchase costs. Null parts count as unknown. */
  totalCostCents: number;
  costIncomplete: boolean;
  /** Total cards allocated, respecting per-line quantity. */
  allocatedCount: number;
}

export interface NewLot {
  title: string;
  description?: string | null;
  game?: TcgGame | null;
  currency: string;
  askingPriceCents?: number | null;
  minimumPriceCents?: number | null;
  cardCount?: number | null;
  storageLocation?: string | null;
  notes?: string | null;
}

// ---------------------------------------------------------------------------
// Marketplace listings
// ---------------------------------------------------------------------------

export type ListingStatus =
  | 'draft' | 'ready_to_publish' | 'publishing' | 'published'
  | 'failed' | 'action_required' | 'sold' | 'ended';

export const LISTING_STATUS_LABELS: Record<ListingStatus, string> = {
  draft: 'Draft',
  ready_to_publish: 'Ready to publish',
  publishing: 'Publishing',
  published: 'Published',
  failed: 'Failed',
  action_required: 'Action required',
  sold: 'Sold',
  ended: 'Ended',
};

export interface MarketplaceListingRow {
  id: string;
  user_id: string;
  inventory_item_id: string | null;
  lot_id: string | null;
  marketplace: 'ebay' | 'facebook' | 'mercari';
  status: ListingStatus;
  title: string | null;
  description: string | null;
  category: string | null;
  item_specifics: Record<string, unknown>;
  condition_text: string | null;
  keywords: string[] | null;
  photo_order: string[] | null;
  shipping_notes: string | null;
  currency: string;
  price_cents: number | null;
  /** Only ever set from a real platform response. */
  external_listing_id: string | null;
  published_url: string | null;
  published_at: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** A listing joined to enough of its card to show in a list. */
export interface ListingFull extends MarketplaceListingRow {
  card_name: string | null;
  set_name: string | null;
  lot_title: string | null;
}

export interface NewListing {
  inventoryItemId?: string | null;
  lotId?: string | null;
  marketplace: 'ebay' | 'facebook' | 'mercari';
  title: string;
  description: string;
  category?: string | null;
  conditionText?: string | null;
  keywords?: string[];
  shippingNotes?: string | null;
  currency: string;
  priceCents: number | null;
  status?: ListingStatus;
}

export interface ExpenseRow {
  id: string;
  user_id: string;
  incurred_on: string;
  category: string;
  description: string | null;
  currency: string;
  amount_cents: number;
  created_at: string;
}

export const EXPENSE_CATEGORIES = [
  'supplies', 'shipping', 'fees', 'inventory', 'travel', 'equipment', 'other',
] as const;

export interface NewExpense {
  incurredOn: string;
  category: string;
  description?: string | null;
  currency: string;
  amountCents: number;
}

export interface InventoryMovementRow {
  id: string;
  user_id: string;
  inventory_item_id: string;
  reason: string;
  quantity_delta: number;
  sale_id: string | null;
  lot_id: string | null;
  note: string | null;
  created_at: string;
}

/** Everything the Sales & Profit dashboard needs, computed from real rows. */
export interface SalesSummary {
  currency: string;
  saleCount: number;
  cardsSold: number;
  grossRevenueCents: number;
  totalCostCents: number;
  totalFeesCents: number;
  netProfitCents: number;
  /** null when no cost basis is known — not zero. */
  roiPercent: number | null;
  averageSalePriceCents: number | null;
  /** Mean days between acquiring a card and selling it. */
  averageDaysToSell: number | null;
  byMonth: { month: string; revenueCents: number; netCents: number; count: number }[];
  byChannel: { channel: SaleChannel; revenueCents: number; netCents: number; count: number }[];
  byGame: { game: string; revenueCents: number; netCents: number; count: number }[];
  /** Sales flagged for review because of a possible double-sale. */
  needsReviewCount: number;
}

export interface AgingBucket {
  label: string;
  itemCount: number;
  costCents: number;
}

/** A portable snapshot of everything, used for backup and for migration. */
export interface BackupBundle {
  format: 'cardvault-backup';
  /**
   * 1 — inventory, catalog, photos, price history.
   * 2 — adds sales, sale lines and expenses.
   * Version 1 bundles still import; their sales arrays simply read as empty.
   */
  version: 1 | 2;
  exportedAt: string;
  catalog: CatalogCardRow[];
  identifiers: { id: string; user_id: string; catalog_card_id: string; provider: string; external_id: string; external_url: string | null }[];
  items: InventoryItemRow[];
  images: InventoryImageRow[];
  /** storage_path -> base64 data URL. Omitted when photos are excluded. */
  photos: Record<string, string>;
  observations: Record<string, unknown>[];
  settings: PricingSettingsRow | null;
  /** Added in version 2. Absent on older bundles. */
  sales?: SaleRow[];
  saleItems?: SaleItemRow[];
  expenses?: ExpenseRow[];
}

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

export interface DataStore {
  /** 'local' or 'supabase'. Shown in the UI so the mode is never ambiguous. */
  readonly kind: 'local' | 'supabase';

  currentUserId(): Promise<string>;

  ensureCatalogCard(candidate: CardCandidate, userId: string): Promise<CatalogCardRow>;
  externalIdFor(catalogCardId: string, provider: string): Promise<string | null>;

  createInventoryItem(input: NewInventoryItem, userId: string): Promise<InventoryItemRow>;
  listInventory(filters?: InventoryFilters): Promise<InventoryItemFull[]>;
  getInventoryItem(id: string): Promise<InventoryItemFull | null>;
  updateInventoryItem(id: string, patch: Partial<InventoryItemRow>): Promise<InventoryItemRow>;
  removeInventoryItem(id: string, hard?: boolean): Promise<void>;

  uploadPhoto(args: {
    file: File; itemId: string; userId: string;
    face: InventoryImageRow['face']; sortOrder?: number;
  }): Promise<{ path: string }>;
  attachImages(
    itemId: string, userId: string,
    images: { path: string; face: InventoryImageRow['face']; sortOrder: number }[]
  ): Promise<void>;
  listImages(itemId: string): Promise<InventoryImageRow[]>;
  deleteImage(image: InventoryImageRow): Promise<void>;
  discardUploads(paths: string[]): Promise<void>;
  /** Display URLs for stored photos, keyed by storage path. */
  signedUrls(paths: string[], expiresIn?: number): Promise<Record<string, string>>;

  recordPriceObservations(
    claims: PriceClaim[],
    ctx: { userId: string; catalogCardId?: string | null; inventoryItemId?: string | null }
  ): Promise<void>;
  getPriceObservations(args: {
    catalogCardId?: string | null; inventoryItemId?: string | null; limit?: number;
  }): Promise<PriceClaim[]>;

  getPricingSettings(userId: string): Promise<PricingSettingsRow>;
  updatePricingSettings(
    userId: string, patch: Partial<PricingSettingsRow>
  ): Promise<PricingSettingsRow>;

  dashboardTotals(): Promise<DashboardTotals>;

  // -- Sales, expenses, ledger --------------------------------------------

  /**
   * Record a sale and decrement inventory atomically-ish.
   *
   * Returns the sale plus any warnings the operator must act on -- most
   * importantly, marketplace listings that are still live elsewhere and
   * cannot be ended automatically because no publishing integration exists.
   */
  recordSale(
    input: NewSale, userId: string
  ): Promise<{ sale: SaleRow; warnings: string[] }>;
  listSales(filters?: { from?: string; to?: string; limit?: number }): Promise<SaleFull[]>;
  getSale(id: string): Promise<SaleFull | null>;
  /** Reverse a sale and return the stock. History is kept, not erased. */
  voidSale(id: string, userId: string): Promise<void>;

  // -- Lots ----------------------------------------------------------------

  createLot(input: NewLot, userId: string): Promise<LotRow>;
  listLots(filters?: { status?: InventoryStatus | 'all' }): Promise<LotFull[]>;
  getLot(id: string): Promise<LotFull | null>;
  updateLot(id: string, patch: Partial<LotRow>): Promise<LotRow>;
  /** Deleting a lot releases its allocations back to available stock. */
  deleteLot(id: string, userId: string): Promise<void>;

  /**
   * Allocate cards to a lot. Allocation increments quantity_allocated, so a
   * card already committed to another lot cannot be committed twice -- the
   * generated availability column refuses it.
   */
  addItemsToLot(
    lotId: string,
    items: { inventoryItemId: string; quantity: number }[],
    userId: string
  ): Promise<{ added: number; skipped: { label: string; reason: string }[] }>;
  removeItemFromLot(lotItemId: string, userId: string): Promise<void>;

  /** Sell a whole lot: one sale, every allocated card moved to sold. */
  recordLotSale(
    lotId: string,
    input: Omit<NewSale, 'items'>,
    userId: string
  ): Promise<{ sale: SaleRow; warnings: string[] }>;

  // -- Marketplace listings -------------------------------------------------

  /** Create or replace the draft for one item on one marketplace. */
  saveListing(input: NewListing, userId: string): Promise<MarketplaceListingRow>;
  listListings(filters?: {
    status?: ListingStatus | 'all';
    marketplace?: 'ebay' | 'facebook' | 'mercari';
    inventoryItemId?: string;
  }): Promise<ListingFull[]>;
  updateListing(id: string, patch: Partial<MarketplaceListingRow>): Promise<MarketplaceListingRow>;
  deleteListing(id: string): Promise<void>;

  recordExpense(input: NewExpense, userId: string): Promise<ExpenseRow>;
  listExpenses(filters?: { from?: string; to?: string }): Promise<ExpenseRow[]>;
  deleteExpense(id: string): Promise<void>;

  listMovements(inventoryItemId: string): Promise<InventoryMovementRow[]>;

  salesSummary(range?: { from?: string; to?: string }): Promise<SalesSummary>;
  inventoryAging(): Promise<AgingBucket[]>;

  /** Backup / migration. */
  exportAll(opts?: { includePhotos?: boolean }): Promise<BackupBundle>;
  importAll(bundle: BackupBundle, userId: string): Promise<{ imported: number; skipped: number }>;
}
