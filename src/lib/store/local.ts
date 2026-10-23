/**
 * Browser-local storage backend (IndexedDB).
 *
 * No account, no network, works offline. The trade-offs are real and are
 * stated plainly in the UI rather than hidden: data lives in this one browser
 * on this one device, and clearing site data erases it.
 *
 * Every invariant the Postgres schema enforces is enforced here too, via
 * ./rules.ts and a handful of unique IndexedDB indexes.
 */

import type {
  AgingBucket, BackupBundle, CatalogCardRow, DashboardTotals, DataStore, ExpenseRow,
  InventoryFilters, InventoryImageRow, InventoryItemFull, InventoryItemRow,
  InventoryMovementRow, InventoryStatus, ListingFull, ListingStatus, LotFull, LotItemRow,
  LotLine, LotRow, MarketplaceListingRow, NewExpense, NewInventoryItem, NewListing,
  NewLot, NewSale, PricingSettingsRow,
  SaleFull, SaleItemRow, SaleLine, SaleRow, SalesSummary,
} from './types';
import type { CardCandidate, PriceClaim } from '../../providers/types';
import { STORES, idb, requestPersistence } from './idb';
import {
  RuleViolation, availableOf, candidateIdentityKey, catalogIdentityKey, certKey,
  conflictReason, isUniqueObject, saleBlockedReason, validateExpense, validateItem,
  validateObservation, validateSale, validateSettings,
} from './rules';
import { inventoryAging, summariseSales } from '../profit';
import { newId } from '../id';

/**
 * Local mode has no authentication, so there is one implicit user. The id is
 * stable and stored, so that an export from local mode carries a consistent
 * user_id and can be re-pointed at a real account on import.
 */
const LOCAL_USER_KEY = 'cardvault.localUserId';

function localUserId(): string {
  let id: string | null = null;
  try {
    id = localStorage.getItem(LOCAL_USER_KEY);
  } catch { /* storage blocked; fall through to an ephemeral id */ }

  if (!id) {
    id = newId();
    try { localStorage.setItem(LOCAL_USER_KEY, id); } catch { /* ignore */ }
  }
  return id;
}

const now = () => new Date().toISOString();

const DEFAULT_SETTINGS = (userId: string): PricingSettingsRow => ({
  user_id: userId,
  default_currency: 'USD',
  asking_price_strategy: 'manual',
  markup_percent: 0,
  markup_fixed_cents: 0,
  target_profit_percent: null,
  stale_after_days: 14,
  min_sales_for_comp: 3,
  max_sales_for_comp: 4,
  // Matches migration 0003 so both backends behave identically.
  condition_adjustments: { LP: 85, MP: 70, HP: 50, DMG: 30 },
  apply_condition_adjustments: true,
});

/** Internal row shapes carry derived keys that back the unique indexes. */
interface StoredCatalog extends CatalogCardRow { identity_key: string }
interface StoredItem extends InventoryItemRow { cert_key: string | null }
interface StoredObservation extends Record<string, unknown> { id: string; dedupe_key: string | null }
interface StoredPhoto { path: string; blob: Blob; type: string; size: number }
/**
 * `unique_object_key` is the sparse index key behind duplicate-sale
 * prevention. It is set only for graded slabs, so the unique index catches a
 * slab sold twice while leaving fungible stock free to sell repeatedly.
 */
interface StoredSaleItem extends SaleItemRow { unique_object_key?: string }

function stripSaleItem(row: StoredSaleItem): SaleItemRow {
  const { unique_object_key: _k, ...rest } = row;
  return rest;
}

/** Object URLs are cached so a re-render does not leak a new one each time. */
const urlCache = new Map<string, string>();

export class LocalStore implements DataStore {
  readonly kind = 'local' as const;

  async currentUserId(): Promise<string> {
    // Best-effort: ask the browser not to evict the database under disk
    // pressure. Failure is non-fatal, so it is not awaited for correctness.
    void requestPersistence();
    return localUserId();
  }

  // -- Catalog ------------------------------------------------------------

  async ensureCatalogCard(candidate: CardCandidate, userId: string): Promise<CatalogCardRow> {
    const key = candidateIdentityKey(candidate);
    const existing = await idb.getAllByIndex<StoredCatalog>(STORES.catalog, 'identity', key);
    if (existing[0]) return stripInternal(existing[0]);

    const row: StoredCatalog = {
      id: newId(),
      user_id: userId,
      game: candidate.game,
      name: candidate.name,
      set_name: candidate.setName ?? null,
      set_code: candidate.setCode ?? null,
      collector_number: candidate.collectorNumber ?? null,
      language: candidate.language,
      rarity: candidate.rarity ?? null,
      finish: candidate.finish ?? null,
      variant: candidate.variant ?? null,
      edition: candidate.edition ?? null,
      is_promo: candidate.isPromo ?? false,
      release_year: candidate.releaseYear ?? null,
      sport: null, player: null, team: null, manufacturer: null, parallel: null,
      has_autograph: null, has_memorabilia: null,
      attributes: candidate.attributes ?? {},
      catalog_source: candidate.providerId,
      catalog_image_url: candidate.imageUrl ?? null,
      created_at: now(),
      updated_at: now(),
      identity_key: key,
    };

    try {
      await idb.put(STORES.catalog, row);
    } catch (e) {
      // ConstraintError means another tab created it first; re-read.
      const again = await idb.getAllByIndex<StoredCatalog>(STORES.catalog, 'identity', key);
      if (again[0]) return stripInternal(again[0]);
      throw e;
    }

    if (candidate.externalId) {
      await idb.put(STORES.identifiers, {
        id: newId(),
        user_id: userId,
        catalog_card_id: row.id,
        provider: candidate.providerId,
        external_id: candidate.externalId,
        external_url: candidate.externalUrl ?? null,
      });
    }
    return stripInternal(row);
  }

  async externalIdFor(catalogCardId: string, provider: string): Promise<string | null> {
    const rows = await idb.getAllByIndex<{ external_id: string }>(
      STORES.identifiers, 'card_provider', [catalogCardId, provider] as unknown as IDBValidKey
    );
    return rows[0]?.external_id ?? null;
  }

  // -- Inventory ----------------------------------------------------------

  async createInventoryItem(input: NewInventoryItem, userId: string): Promise<InventoryItemRow> {
    const base: InventoryItemRow = {
      id: input.id ?? newId(),
      user_id: userId,
      catalog_card_id: input.catalogCardId,
      kind: input.kind,
      sku: input.sku || null,
      status: 'in_stock',
      quantity: input.quantity,
      quantity_sold: 0,
      quantity_allocated: 0,
      quantity_available: 0, // recomputed below
      condition: input.condition,
      condition_notes: input.conditionNotes ?? null,
      defects: input.defects ?? {},
      grading_company: input.gradingCompany || null,
      grade: input.grade ?? null,
      cert_number: input.certNumber || null,
      grade_verified: false,
      currency: input.currency,
      purchase_cost_cents: input.purchaseCostCents,
      acquisition_date: input.acquisitionDate ?? null,
      acquisition_source: input.acquisitionSource ?? null,
      asking_price_cents: input.askingPriceCents ?? null,
      minimum_price_cents: input.minimumPriceCents ?? null,
      market_value_cents: null,
      market_value_override_cents: null,
      market_value_confidence: null,
      market_value_method: null,
      last_price_refresh_at: null,
      storage_location: input.storageLocation ?? null,
      notes: input.notes ?? null,
      listed_at: null,
      sold_at: null,
      created_at: now(),
      updated_at: now(),
    };
    base.quantity_available = availableOf(base);

    validateItem(base);

    const stored: StoredItem = {
      ...base,
      cert_key: certKey(base.grading_company, base.cert_number),
    };

    try {
      await idb.put(STORES.items, stored);
    } catch (e) {
      if ((e as DOMException)?.name === 'ConstraintError' && stored.cert_key) {
        throw new RuleViolation(
          `A slab with certification number ${base.cert_number} is already in your ` +
          `inventory. The same physical slab cannot be entered twice.`,
          'certNumber'
        );
      }
      throw e;
    }

    await idb.put(STORES.movements, {
      id: newId(),
      user_id: userId,
      inventory_item_id: base.id,
      reason: 'acquired',
      quantity_delta: base.quantity,
      note: input.acquisitionSource ?? null,
      created_at: now(),
    });

    return base;
  }

  async listInventory(filters: InventoryFilters = {}): Promise<InventoryItemFull[]> {
    const [items, catalog, images] = await Promise.all([
      idb.getAll<StoredItem>(STORES.items),
      idb.getAll<StoredCatalog>(STORES.catalog),
      idb.getAll<InventoryImageRow>(STORES.images),
    ]);

    const catalogById = new Map(catalog.map((c) => [c.id, stripInternal(c)]));
    const imagesByItem = new Map<string, InventoryImageRow[]>();
    for (const img of images) {
      const list = imagesByItem.get(img.inventory_item_id) ?? [];
      list.push(img);
      imagesByItem.set(img.inventory_item_id, list);
    }

    let rows: InventoryItemFull[] = items.map((i) => ({
      ...stripInternal(i),
      card_catalog: i.catalog_card_id ? catalogById.get(i.catalog_card_id) ?? null : null,
      inventory_images: (imagesByItem.get(i.id) ?? []).sort((a, b) => a.sort_order - b.sort_order),
    }));

    // Three distinct cases. 'all' genuinely means every status, including
    // removed; omitting the filter hides removed items, which is the sane
    // default for day-to-day browsing.
    if (filters.status === 'all') {
      // no status filter at all
    } else if (filters.status) {
      rows = rows.filter((r) => r.status === filters.status);
    } else {
      rows = rows.filter((r) => r.status !== 'removed');
    }

    if (filters.condition && filters.condition !== 'all') {
      rows = rows.filter((r) => r.condition === filters.condition);
    }
    if (filters.kind && filters.kind !== 'all') {
      rows = rows.filter((r) => r.kind === filters.kind);
    }
    if (filters.game && filters.game !== 'all') {
      rows = rows.filter((r) => r.card_catalog?.game === filters.game);
    }
    if (filters.search?.trim()) {
      const needle = filters.search.trim().toLowerCase();
      rows = rows.filter((r) => {
        const c = r.card_catalog;
        return [
          c?.name, c?.set_name, c?.set_code, c?.collector_number,
          r.sku, r.storage_location, r.cert_number, r.notes,
        ].filter(Boolean).some((f) => String(f).toLowerCase().includes(needle));
      });
    }

    const byDesc = (a: number | null, b: number | null) => (b ?? -1) - (a ?? -1);
    switch (filters.sort) {
      case 'name':
        rows.sort((a, b) => (a.card_catalog?.name ?? '').localeCompare(b.card_catalog?.name ?? ''));
        break;
      case 'value_desc':
        rows.sort((a, b) => byDesc(a.market_value_cents, b.market_value_cents));
        break;
      case 'cost_desc':
        rows.sort((a, b) => byDesc(a.purchase_cost_cents, b.purchase_cost_cents));
        break;
      case 'stale_price':
        // Never-refreshed items come first: they are the stalest of all.
        rows.sort((a, b) =>
          (a.last_price_refresh_at ?? '').localeCompare(b.last_price_refresh_at ?? ''));
        break;
      default:
        rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
    }

    return rows.slice(0, filters.limit ?? 200);
  }

  async getInventoryItem(id: string): Promise<InventoryItemFull | null> {
    const item = await idb.get<StoredItem>(STORES.items, id);
    if (!item) return null;
    const [catalog, images] = await Promise.all([
      item.catalog_card_id
        ? idb.get<StoredCatalog>(STORES.catalog, item.catalog_card_id)
        : Promise.resolve(undefined),
      idb.getAllByIndex<InventoryImageRow>(STORES.images, 'item', id),
    ]);
    return {
      ...stripInternal(item),
      card_catalog: catalog ? stripInternal(catalog) : null,
      inventory_images: images.sort((a, b) => a.sort_order - b.sort_order),
    };
  }

  async updateInventoryItem(
    id: string, patch: Partial<InventoryItemRow>
  ): Promise<InventoryItemRow> {
    const existing = await idb.get<StoredItem>(STORES.items, id);
    if (!existing) throw new RuleViolation('That item no longer exists.');

    const merged: StoredItem = { ...existing, ...patch, id, updated_at: now() };
    merged.quantity_available = availableOf(merged);
    merged.cert_key = certKey(merged.grading_company, merged.cert_number);

    validateItem(merged);
    await idb.put(STORES.items, merged);
    return stripInternal(merged);
  }

  async removeInventoryItem(id: string, hard = false): Promise<void> {
    if (!hard) {
      await this.updateInventoryItem(id, { status: 'removed' });
      return;
    }
    const images = await this.listImages(id);
    for (const img of images) await this.deleteImage(img);
    await idb.delete(STORES.items, id);
  }

  // -- Photos -------------------------------------------------------------

  async uploadPhoto(args: {
    file: File; itemId: string; userId: string; face: InventoryImageRow['face'];
  }): Promise<{ path: string }> {
    const ext = (args.file.type.split('/')[1] ?? 'jpg').replace('jpeg', 'jpg');
    const path = `${args.userId}/${args.itemId}/${args.face}-${Date.now()}.${ext}`;

    const photo: StoredPhoto = {
      path,
      // The Blob is stored directly; IndexedDB handles binary natively, so
      // there is no base64 inflation.
      blob: args.file,
      type: args.file.type || 'image/jpeg',
      size: args.file.size,
    };

    try {
      await idb.put(STORES.photos, photo);
    } catch (e) {
      if ((e as DOMException)?.name === 'QuotaExceededError') {
        throw new RuleViolation(
          'Your browser is out of storage space for this site. Export a backup and ' +
          'remove some photos, or switch to Supabase for unlimited photo storage.'
        );
      }
      throw e;
    }
    return { path };
  }

  async attachImages(
    itemId: string, userId: string,
    images: { path: string; face: InventoryImageRow['face']; sortOrder: number }[]
  ): Promise<void> {
    await idb.putMany<InventoryImageRow>(
      STORES.images,
      images.map((i) => ({
        id: newId(),
        user_id: userId,
        inventory_item_id: itemId,
        storage_path: i.path,
        face: i.face,
        sort_order: i.sortOrder,
        created_at: now(),
      }))
    );
  }

  async listImages(itemId: string): Promise<InventoryImageRow[]> {
    const rows = await idb.getAllByIndex<InventoryImageRow>(STORES.images, 'item', itemId);
    return rows.sort((a, b) => a.sort_order - b.sort_order);
  }

  async deleteImage(image: InventoryImageRow): Promise<void> {
    await idb.delete(STORES.images, image.id);
    await idb.delete(STORES.photos, image.storage_path);
    const url = urlCache.get(image.storage_path);
    if (url) { URL.revokeObjectURL(url); urlCache.delete(image.storage_path); }
  }

  async discardUploads(paths: string[]): Promise<void> {
    for (const p of paths) {
      await idb.delete(STORES.photos, p);
      const url = urlCache.get(p);
      if (url) { URL.revokeObjectURL(url); urlCache.delete(p); }
    }
  }

  /** Object URLs stand in for signed URLs; the interface is identical. */
  async signedUrls(paths: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const path of paths) {
      const cached = urlCache.get(path);
      if (cached) { out[path] = cached; continue; }
      const photo = await idb.get<StoredPhoto>(STORES.photos, path);
      if (!photo?.blob) continue;
      const url = URL.createObjectURL(photo.blob);
      urlCache.set(path, url);
      out[path] = url;
    }
    return out;
  }

  // -- Pricing ------------------------------------------------------------

  async recordPriceObservations(
    claims: PriceClaim[],
    ctx: { userId: string; catalogCardId?: string | null; inventoryItemId?: string | null }
  ): Promise<void> {
    for (const c of claims) {
      const dedupe = validateObservation(c);
      const row: StoredObservation = {
        id: newId(),
        user_id: ctx.userId,
        catalog_card_id: ctx.catalogCardId ?? null,
        inventory_item_id: ctx.inventoryItemId ?? null,
        provider: c.provider,
        claim_type: c.claimType,
        external_id: c.externalId ?? null,
        source_url: c.sourceUrl ?? null,
        price_cents: c.priceCents,
        currency: c.currency,
        condition: c.condition ?? null,
        grading_company: c.gradingCompany ?? null,
        grade: c.grade ?? null,
        finish: c.finish ?? null,
        variant: c.variant ?? null,
        observed_at: c.observedAt ?? null,
        retrieved_at: c.retrievedAt,
        status: c.status,
        notes: c.notes ?? null,
        raw: c.raw ?? null,
        created_at: now(),
        dedupe_key: dedupe,
      };
      try {
        await idb.put(STORES.observations, row);
      } catch (e) {
        // A duplicate completed sale on refresh is expected, not an error --
        // the unique index exists to stop double-counting a transaction.
        if ((e as DOMException)?.name !== 'ConstraintError') throw e;
      }
    }
  }

  async getPriceObservations(args: {
    catalogCardId?: string | null; inventoryItemId?: string | null; limit?: number;
  }): Promise<PriceClaim[]> {
    let rows: StoredObservation[] = [];
    if (args.inventoryItemId) {
      rows = await idb.getAllByIndex(STORES.observations, 'item', args.inventoryItemId);
    } else if (args.catalogCardId) {
      rows = await idb.getAllByIndex(STORES.observations, 'card', args.catalogCardId);
    } else {
      return [];
    }

    return rows
      .sort((a, b) => String(b.retrieved_at).localeCompare(String(a.retrieved_at)))
      .slice(0, args.limit ?? 100)
      .map((r) => ({
        provider: r.provider as string,
        claimType: r.claim_type as PriceClaim['claimType'],
        priceCents: r.price_cents as number | null,
        currency: r.currency as string,
        condition: r.condition as PriceClaim['condition'],
        gradingCompany: r.grading_company as string | null,
        grade: r.grade as number | null,
        finish: r.finish as string | null,
        variant: r.variant as string | null,
        observedAt: r.observed_at as string | null,
        retrievedAt: r.retrieved_at as string,
        externalId: r.external_id as string | null,
        sourceUrl: r.source_url as string | null,
        status: r.status as PriceClaim['status'],
        notes: r.notes as string | null,
        raw: r.raw,
      }));
  }

  async getPricingSettings(userId: string): Promise<PricingSettingsRow> {
    const existing = await idb.get<PricingSettingsRow>(STORES.settings, userId);
    if (existing) return existing;
    const created = DEFAULT_SETTINGS(userId);
    await idb.put(STORES.settings, created);
    return created;
  }

  async updatePricingSettings(
    userId: string, patch: Partial<PricingSettingsRow>
  ): Promise<PricingSettingsRow> {
    validateSettings(patch);
    const current = await this.getPricingSettings(userId);
    const merged = { ...current, ...patch, user_id: userId };
    validateSettings(merged);
    await idb.put(STORES.settings, merged);
    return merged;
  }

  // -- Aggregates ---------------------------------------------------------

  async dashboardTotals(): Promise<DashboardTotals> {
    const items = (await idb.getAll<StoredItem>(STORES.items))
      .filter((i) => i.status !== 'removed');

    const t: DashboardTotals = {
      itemCount: 0, cardCount: 0, totalCostCents: 0, totalValueCents: 0,
      valuedItemCount: 0, listedCount: 0, soldCount: 0,
      needsIdentification: 0, needsConditionReview: 0,
    };

    for (const r of items) {
      t.itemCount += 1;
      t.cardCount += r.quantity;
      t.totalCostCents += (r.purchase_cost_cents ?? 0) * r.quantity;

      const value = r.market_value_override_cents ?? r.market_value_cents;
      if (value != null) {
        t.totalValueCents += value * (r.quantity_available || r.quantity);
        t.valuedItemCount += 1;
      }
      if (r.status === 'listed') t.listedCount += 1;
      if (r.status === 'sold') t.soldCount += 1;
      if (!r.catalog_card_id) t.needsIdentification += 1;
      if (r.condition === 'NEEDS_REVIEW') t.needsConditionReview += 1;
    }
    return t;
  }

  // -- Sales ---------------------------------------------------------------

  async recordSale(
    input: NewSale, userId: string
  ): Promise<{ sale: SaleRow; warnings: string[] }> {
    validateSale(input);

    const warnings: string[] = [];
    const saleId = newId();
    const timestamp = now();

    // 1. Load every item and check it can actually be sold BEFORE writing
    //    anything, so a bad line cannot leave a half-recorded sale behind.
    const lines: { item: StoredItem; quantity: number; unitPriceCents: number | null }[] = [];
    for (const line of input.items) {
      const item = await idb.get<StoredItem>(STORES.items, line.inventoryItemId);
      if (!item) throw new RuleViolation('One of those cards no longer exists.');

      const priorUnique = isUniqueObject(item.kind)
        ? await idb.getAllByIndex<StoredSaleItem>(STORES.saleItems, 'item', item.id)
        : [];
      const blocked = saleBlockedReason(item, line.quantity, priorUnique.length > 0);
      if (blocked) throw new RuleViolation(blocked);

      lines.push({
        item,
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents ?? null,
      });
    }

    // 2. Flag a possible double entry rather than refusing it.
    const priorTimes: string[] = [];
    for (const { item } of lines) {
      const prior = await idb.getAllByIndex<StoredSaleItem>(STORES.saleItems, 'item', item.id);
      for (const p of prior) {
        const sale = await idb.get<SaleRow>(STORES.sales, p.sale_id);
        if (sale) priorTimes.push(sale.sold_at);
      }
    }
    const conflict = conflictReason(input.soldAt, priorTimes);

    const sale: SaleRow = {
      id: saleId,
      user_id: userId,
      channel: input.channel,
      sold_at: input.soldAt,
      buyer_note: input.buyerNote ?? null,
      currency: input.currency,
      sale_price_cents: input.salePriceCents,
      shipping_charged_cents: input.shippingChargedCents ?? 0,
      marketplace_fee_cents: input.marketplaceFeeCents ?? 0,
      shipping_cost_cents: input.shippingCostCents ?? 0,
      packaging_cost_cents: input.packagingCostCents ?? 0,
      other_fee_cents: input.otherFeeCents ?? 0,
      refund_cents: input.refundCents ?? 0,
      needs_review: conflict != null,
      review_reason: conflict,
      created_at: timestamp,
      updated_at: timestamp,
    };
    await idb.put(STORES.sales, sale);
    if (conflict) warnings.push(conflict);

    // 3. Write the lines, snapshotting cost so later edits to the item do not
    //    rewrite historical profit.
    for (const { item, quantity, unitPriceCents } of lines) {
      const row: StoredSaleItem = {
        id: newId(),
        user_id: userId,
        sale_id: saleId,
        inventory_item_id: item.id,
        lot_id: null,
        quantity,
        unit_cost_cents: item.purchase_cost_cents,
        unit_price_cents: unitPriceCents,
        created_at: timestamp,
        // Sparse key: present only for unique objects, which is what makes
        // the unique index permit repeat sales of fungible stock.
        unique_object_key: isUniqueObject(item.kind) ? item.id : undefined,
      };
      try {
        await idb.put(STORES.saleItems, row);
      } catch (e) {
        if ((e as DOMException)?.name === 'ConstraintError') {
          throw new RuleViolation(
            'That graded slab has already been sold. The same physical slab cannot be sold twice.'
          );
        }
        throw e;
      }

      // 4. Decrement the quantity ledger. updateInventoryItem re-validates,
      //    so an oversell is caught here even if the pre-check was raced.
      const sold = item.quantity_sold + quantity;
      const stillAvailable = item.quantity - sold - item.quantity_allocated;
      await this.updateInventoryItem(item.id, {
        quantity_sold: sold,
        status: stillAvailable <= 0 ? 'sold' : item.status,
        sold_at: stillAvailable <= 0 ? input.soldAt : item.sold_at,
      });

      await idb.put(STORES.movements, {
        id: newId(),
        user_id: userId,
        inventory_item_id: item.id,
        reason: 'sold',
        quantity_delta: -quantity,
        sale_id: saleId,
        lot_id: null,
        note: `Sold via ${input.channel}`,
        created_at: timestamp,
      });

      // 5. Other marketplaces cannot be ended automatically, because no
      //    publishing integration exists yet. Say so rather than implying it
      //    was handled.
      warnings.push(
        `If this card is listed anywhere else, end those listings yourself — ` +
        `no marketplace integration is connected, so nothing was ended automatically.`
      );
    }

    return { sale, warnings: [...new Set(warnings)] };
  }

  async listSales(
    filters: { from?: string; to?: string; limit?: number } = {}
  ): Promise<SaleFull[]> {
    const [sales, saleItems, items, catalog] = await Promise.all([
      idb.getAll<SaleRow>(STORES.sales),
      idb.getAll<StoredSaleItem>(STORES.saleItems),
      idb.getAll<StoredItem>(STORES.items),
      idb.getAll<StoredCatalog>(STORES.catalog),
    ]);

    const itemById = new Map(items.map((i) => [i.id, i]));
    const catalogById = new Map(catalog.map((c) => [c.id, c]));
    const linesBySale = new Map<string, SaleLine[]>();

    for (const si of saleItems) {
      const item = si.inventory_item_id ? itemById.get(si.inventory_item_id) : undefined;
      const card = item?.catalog_card_id ? catalogById.get(item.catalog_card_id) : undefined;
      const line: SaleLine = {
        ...stripSaleItem(si),
        card_name: card?.name ?? null,
        set_name: card?.set_name ?? null,
        collector_number: card?.collector_number ?? null,
        kind: item?.kind ?? null,
        grading_company: item?.grading_company ?? null,
        grade: item?.grade ?? null,
      };
      const list = linesBySale.get(si.sale_id) ?? [];
      list.push(line);
      linesBySale.set(si.sale_id, list);
    }

    return sales
      .filter((s) => (!filters.from || s.sold_at >= filters.from)
        && (!filters.to || s.sold_at <= filters.to))
      .sort((a, b) => b.sold_at.localeCompare(a.sold_at))
      .slice(0, filters.limit ?? 500)
      .map((s) => ({ ...s, items: linesBySale.get(s.id) ?? [] }));
  }

  async getSale(id: string): Promise<SaleFull | null> {
    const all = await this.listSales();
    return all.find((s) => s.id === id) ?? null;
  }

  async voidSale(id: string, userId: string): Promise<void> {
    const lines = await idb.getAllByIndex<StoredSaleItem>(STORES.saleItems, 'sale', id);

    for (const line of lines) {
      if (!line.inventory_item_id) continue;
      const item = await idb.get<StoredItem>(STORES.items, line.inventory_item_id);
      if (!item) continue;

      const sold = Math.max(0, item.quantity_sold - line.quantity);
      await this.updateInventoryItem(item.id, {
        quantity_sold: sold,
        status: item.status === 'sold' ? 'in_stock' : item.status,
        sold_at: null,
      });

      // The reversal is appended, never by deleting the original movement:
      // the ledger is a history, not a current-state cache.
      await idb.put(STORES.movements, {
        id: newId(),
        user_id: userId,
        inventory_item_id: item.id,
        reason: 'returned',
        quantity_delta: line.quantity,
        sale_id: id,
        lot_id: null,
        note: 'Sale voided',
        created_at: now(),
      });
      await idb.delete(STORES.saleItems, line.id);
    }
    await idb.delete(STORES.sales, id);
  }

  // -- Lots -----------------------------------------------------------------

  async createLot(input: NewLot, userId: string): Promise<LotRow> {
    if (!input.title.trim()) {
      throw new RuleViolation('Give the lot a title so you can find it later.', 'title');
    }
    const row: LotRow = {
      id: newId(),
      user_id: userId,
      title: input.title.trim(),
      description: input.description ?? null,
      game: input.game ?? null,
      status: 'in_stock',
      currency: input.currency,
      asking_price_cents: input.askingPriceCents ?? null,
      minimum_price_cents: input.minimumPriceCents ?? null,
      card_count: input.cardCount ?? null,
      storage_location: input.storageLocation ?? null,
      notes: input.notes ?? null,
      created_at: now(),
      updated_at: now(),
    };
    await idb.put(STORES.lots, row);
    return row;
  }

  /** Join lot rows to their lines and compute the cost basis. */
  private async hydrateLots(lots: LotRow[]): Promise<LotFull[]> {
    const [lines, items, catalog] = await Promise.all([
      idb.getAll<LotItemRow>(STORES.lotItems),
      idb.getAll<StoredItem>(STORES.items),
      idb.getAll<StoredCatalog>(STORES.catalog),
    ]);
    const itemById = new Map(items.map((i) => [i.id, i]));
    const catalogById = new Map(catalog.map((c) => [c.id, c]));

    const byLot = new Map<string, LotLine[]>();
    for (const line of lines) {
      const item = itemById.get(line.inventory_item_id);
      const card = item?.catalog_card_id ? catalogById.get(item.catalog_card_id) : undefined;
      const full: LotLine = {
        ...line,
        card_name: card?.name ?? null,
        set_name: card?.set_name ?? null,
        collector_number: card?.collector_number ?? null,
        condition: item?.condition ?? null,
        kind: item?.kind ?? null,
        grading_company: item?.grading_company ?? null,
        grade: item?.grade ?? null,
        unit_cost_cents: item?.purchase_cost_cents ?? null,
      };
      const list = byLot.get(line.lot_id) ?? [];
      list.push(full);
      byLot.set(line.lot_id, list);
    }

    return lots.map((lot) => {
      const lotLines = byLot.get(lot.id) ?? [];
      let totalCostCents = 0;
      let costIncomplete = false;
      let allocatedCount = 0;
      for (const l of lotLines) {
        if (l.unit_cost_cents == null) costIncomplete = true;
        else totalCostCents += l.unit_cost_cents * l.quantity;
        allocatedCount += l.quantity;
      }
      return { ...lot, items: lotLines, totalCostCents, costIncomplete, allocatedCount };
    });
  }

  async listLots(filters: { status?: InventoryStatus | 'all' } = {}): Promise<LotFull[]> {
    let lots = await idb.getAll<LotRow>(STORES.lots);
    if (filters.status === 'all') {
      // every status
    } else if (filters.status) {
      lots = lots.filter((l) => l.status === filters.status);
    } else {
      lots = lots.filter((l) => l.status !== 'removed');
    }
    lots.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return this.hydrateLots(lots);
  }

  async getLot(id: string): Promise<LotFull | null> {
    const lot = await idb.get<LotRow>(STORES.lots, id);
    if (!lot) return null;
    return (await this.hydrateLots([lot]))[0] ?? null;
  }

  async updateLot(id: string, patch: Partial<LotRow>): Promise<LotRow> {
    const existing = await idb.get<LotRow>(STORES.lots, id);
    if (!existing) throw new RuleViolation('That lot no longer exists.');
    const merged = { ...existing, ...patch, id, updated_at: now() };
    if (
      merged.minimum_price_cents != null && merged.asking_price_cents != null
      && merged.minimum_price_cents > merged.asking_price_cents
    ) {
      throw new RuleViolation(
        'The minimum acceptable price cannot be higher than the asking price.',
        'minimum_price_cents'
      );
    }
    await idb.put(STORES.lots, merged);
    return merged;
  }

  async deleteLot(id: string, userId: string): Promise<void> {
    const lines = await idb.getAllByIndex<LotItemRow>(STORES.lotItems, 'lot', id);
    for (const line of lines) await this.releaseAllocation(line, userId, 'Lot deleted');
    await idb.delete(STORES.lots, id);
  }

  /** Return one allocation to available stock and log the movement. */
  private async releaseAllocation(
    line: LotItemRow, userId: string, note: string
  ): Promise<void> {
    const item = await idb.get<StoredItem>(STORES.items, line.inventory_item_id);
    if (item) {
      await this.updateInventoryItem(item.id, {
        quantity_allocated: Math.max(0, item.quantity_allocated - line.quantity),
        status: item.status === 'allocated_to_lot' ? 'in_stock' : item.status,
      });
      await idb.put(STORES.movements, {
        id: newId(),
        user_id: userId,
        inventory_item_id: item.id,
        reason: 'released_from_lot',
        quantity_delta: line.quantity,
        sale_id: null,
        lot_id: line.lot_id,
        note,
        created_at: now(),
      });
    }
    await idb.delete(STORES.lotItems, line.id);
  }

  async addItemsToLot(
    lotId: string,
    items: { inventoryItemId: string; quantity: number }[],
    userId: string
  ): Promise<{ added: number; skipped: { label: string; reason: string }[] }> {
    const lot = await idb.get<LotRow>(STORES.lots, lotId);
    if (!lot) throw new RuleViolation('That lot no longer exists.');

    const existing = await idb.getAllByIndex<LotItemRow>(STORES.lotItems, 'lot', lotId);
    const alreadyIn = new Set(existing.map((l) => l.inventory_item_id));

    let added = 0;
    const skipped: { label: string; reason: string }[] = [];

    for (const entry of items) {
      const item = await idb.get<StoredItem>(STORES.items, entry.inventoryItemId);
      const label = item?.id ?? entry.inventoryItemId;
      if (!item) {
        skipped.push({ label, reason: 'no longer exists' });
        continue;
      }
      if (alreadyIn.has(item.id)) {
        skipped.push({ label, reason: 'already in this lot' });
        continue;
      }
      const available = availableOf(item);
      if (entry.quantity > available) {
        skipped.push({
          label,
          reason: available <= 0
            ? 'none available — it may already be in another lot or sold'
            : `only ${available} available`,
        });
        continue;
      }

      // The generated availability column is the real guard; this write
      // fails loudly if something changed underneath us.
      await this.updateInventoryItem(item.id, {
        quantity_allocated: item.quantity_allocated + entry.quantity,
        status: availableOf(item) - entry.quantity <= 0 ? 'allocated_to_lot' : item.status,
      });

      await idb.put(STORES.lotItems, {
        id: newId(),
        user_id: userId,
        lot_id: lotId,
        inventory_item_id: item.id,
        quantity: entry.quantity,
        created_at: now(),
      } satisfies LotItemRow);

      await idb.put(STORES.movements, {
        id: newId(),
        user_id: userId,
        inventory_item_id: item.id,
        reason: 'allocated_to_lot',
        quantity_delta: -entry.quantity,
        sale_id: null,
        lot_id: lotId,
        note: `Allocated to "${lot.title}"`,
        created_at: now(),
      });
      added += 1;
    }

    return { added, skipped };
  }

  async removeItemFromLot(lotItemId: string, userId: string): Promise<void> {
    const line = await idb.get<LotItemRow>(STORES.lotItems, lotItemId);
    if (!line) return;
    await this.releaseAllocation(line, userId, 'Removed from lot');
  }

  async recordLotSale(
    lotId: string,
    input: Omit<NewSale, 'items'>,
    userId: string
  ): Promise<{ sale: SaleRow; warnings: string[] }> {
    const lot = await idb.get<LotRow>(STORES.lots, lotId);
    if (!lot) throw new RuleViolation('That lot no longer exists.');
    if (lot.status === 'sold') {
      throw new RuleViolation('This lot has already been sold.');
    }

    const lines = await idb.getAllByIndex<LotItemRow>(STORES.lotItems, 'lot', lotId);
    if (lines.length === 0) {
      throw new RuleViolation('This lot has no cards allocated to it yet.');
    }
    validateSale({ ...input, items: lines.map((l) => ({ quantity: l.quantity })) });

    const saleId = newId();
    const timestamp = now();

    // Cost basis is the sum of the allocated cards, snapshot now.
    let costCents = 0;
    for (const line of lines) {
      const item = await idb.get<StoredItem>(STORES.items, line.inventory_item_id);
      if (item?.purchase_cost_cents != null) {
        costCents += item.purchase_cost_cents * line.quantity;
      }
    }

    const sale: SaleRow = {
      id: saleId,
      user_id: userId,
      channel: input.channel,
      sold_at: input.soldAt,
      buyer_note: input.buyerNote ?? null,
      currency: input.currency,
      sale_price_cents: input.salePriceCents,
      shipping_charged_cents: input.shippingChargedCents ?? 0,
      marketplace_fee_cents: input.marketplaceFeeCents ?? 0,
      shipping_cost_cents: input.shippingCostCents ?? 0,
      packaging_cost_cents: input.packagingCostCents ?? 0,
      other_fee_cents: input.otherFeeCents ?? 0,
      refund_cents: input.refundCents ?? 0,
      needs_review: false,
      review_reason: null,
      created_at: timestamp,
      updated_at: timestamp,
    };
    await idb.put(STORES.sales, sale);

    // One sale line for the lot as a whole, carrying the aggregate cost.
    await idb.put(STORES.saleItems, {
      id: newId(),
      user_id: userId,
      sale_id: saleId,
      inventory_item_id: null,
      lot_id: lotId,
      quantity: 1,
      unit_cost_cents: costCents,
      unit_price_cents: input.salePriceCents,
      created_at: timestamp,
    } satisfies StoredSaleItem);

    // Every allocated card moves from allocated to sold.
    for (const line of lines) {
      const item = await idb.get<StoredItem>(STORES.items, line.inventory_item_id);
      if (!item) continue;
      await this.updateInventoryItem(item.id, {
        quantity_allocated: Math.max(0, item.quantity_allocated - line.quantity),
        quantity_sold: item.quantity_sold + line.quantity,
        status: item.quantity - (item.quantity_sold + line.quantity) <= 0
          ? 'sold'
          : 'in_stock',
        sold_at: input.soldAt,
      });
      await idb.put(STORES.movements, {
        id: newId(),
        user_id: userId,
        inventory_item_id: item.id,
        reason: 'sold',
        quantity_delta: 0, // already deducted when allocated; this reclassifies
        sale_id: saleId,
        lot_id: lotId,
        note: `Sold as part of "${lot.title}"`,
        created_at: timestamp,
      });
    }

    await this.updateLot(lotId, { status: 'sold' });

    return {
      sale,
      warnings: [
        `If this lot is listed anywhere else, end those listings yourself — ` +
        `no marketplace integration is connected, so nothing was ended automatically.`,
      ],
    };
  }

  // -- Marketplace listings -------------------------------------------------

  async saveListing(input: NewListing, userId: string): Promise<MarketplaceListingRow> {
    const existing = input.inventoryItemId
      ? (await idb.getAllByIndex<MarketplaceListingRow>(
          STORES.listings, 'item', input.inventoryItemId
        )).find((l) => l.marketplace === input.marketplace)
      : undefined;

    const row: MarketplaceListingRow = {
      id: existing?.id ?? newId(),
      user_id: userId,
      inventory_item_id: input.inventoryItemId ?? null,
      lot_id: input.lotId ?? null,
      marketplace: input.marketplace,
      // Regenerating a draft must never silently un-publish something that
      // is already live, so a published listing keeps its status.
      status: existing?.status === 'published'
        ? 'published'
        : input.status ?? existing?.status ?? 'draft',
      title: input.title,
      description: input.description,
      category: input.category ?? null,
      item_specifics: existing?.item_specifics ?? {},
      condition_text: input.conditionText ?? null,
      keywords: input.keywords ?? null,
      photo_order: existing?.photo_order ?? null,
      shipping_notes: input.shippingNotes ?? null,
      currency: input.currency,
      price_cents: input.priceCents,
      external_listing_id: existing?.external_listing_id ?? null,
      published_url: existing?.published_url ?? null,
      published_at: existing?.published_at ?? null,
      last_synced_at: existing?.last_synced_at ?? null,
      last_error: existing?.last_error ?? null,
      created_at: existing?.created_at ?? now(),
      updated_at: now(),
    };
    await idb.put(STORES.listings, row);
    return row;
  }

  async listListings(filters: {
    status?: ListingStatus | 'all';
    marketplace?: 'ebay' | 'facebook' | 'mercari';
    inventoryItemId?: string;
  } = {}): Promise<ListingFull[]> {
    const [rows, items, catalog, lots] = await Promise.all([
      idb.getAll<MarketplaceListingRow>(STORES.listings),
      idb.getAll<StoredItem>(STORES.items),
      idb.getAll<StoredCatalog>(STORES.catalog),
      idb.getAll<LotRow>(STORES.lots),
    ]);
    const itemById = new Map(items.map((i) => [i.id, i]));
    const catalogById = new Map(catalog.map((c) => [c.id, c]));
    const lotById = new Map(lots.map((l) => [l.id, l]));

    let out = rows;
    if (filters.inventoryItemId) {
      out = out.filter((r) => r.inventory_item_id === filters.inventoryItemId);
    }
    if (filters.marketplace) out = out.filter((r) => r.marketplace === filters.marketplace);
    if (filters.status && filters.status !== 'all') {
      out = out.filter((r) => r.status === filters.status);
    }

    return out
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map((r) => {
        const item = r.inventory_item_id ? itemById.get(r.inventory_item_id) : undefined;
        const card = item?.catalog_card_id ? catalogById.get(item.catalog_card_id) : undefined;
        return {
          ...r,
          card_name: card?.name ?? null,
          set_name: card?.set_name ?? null,
          lot_title: r.lot_id ? lotById.get(r.lot_id)?.title ?? null : null,
        };
      });
  }

  async updateListing(
    id: string, patch: Partial<MarketplaceListingRow>
  ): Promise<MarketplaceListingRow> {
    const existing = await idb.get<MarketplaceListingRow>(STORES.listings, id);
    if (!existing) throw new RuleViolation('That listing no longer exists.');
    const merged = { ...existing, ...patch, id, updated_at: now() };

    // Mirrors listing_published_needs_proof: nothing may call itself
    // Published without an id and timestamp from the real platform.
    if (merged.status === 'published'
        && (!merged.external_listing_id || !merged.published_at)) {
      throw new RuleViolation(
        'A listing cannot be marked Published without a real listing id from the '
        + 'platform. Use "Mark as posted" and paste the URL instead.'
      );
    }
    await idb.put(STORES.listings, merged);
    return merged;
  }

  async deleteListing(id: string): Promise<void> {
    await idb.delete(STORES.listings, id);
  }

  // -- Expenses -------------------------------------------------------------

  async recordExpense(input: NewExpense, userId: string): Promise<ExpenseRow> {
    validateExpense(input);
    const row: ExpenseRow = {
      id: newId(),
      user_id: userId,
      incurred_on: input.incurredOn,
      category: input.category,
      description: input.description ?? null,
      currency: input.currency,
      amount_cents: input.amountCents,
      created_at: now(),
    };
    await idb.put(STORES.expenses, row);
    return row;
  }

  async listExpenses(filters: { from?: string; to?: string } = {}): Promise<ExpenseRow[]> {
    const rows = await idb.getAll<ExpenseRow>(STORES.expenses);
    return rows
      .filter((e) => (!filters.from || e.incurred_on >= filters.from)
        && (!filters.to || e.incurred_on <= filters.to))
      .sort((a, b) => b.incurred_on.localeCompare(a.incurred_on));
  }

  async deleteExpense(id: string): Promise<void> {
    await idb.delete(STORES.expenses, id);
  }

  async listMovements(inventoryItemId: string): Promise<InventoryMovementRow[]> {
    const rows = await idb.getAllByIndex<InventoryMovementRow>(
      STORES.movements, 'item', inventoryItemId
    );
    return rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async salesSummary(range: { from?: string; to?: string } = {}): Promise<SalesSummary> {
    const [sales, items, catalog, settings] = await Promise.all([
      this.listSales(range),
      idb.getAll<StoredItem>(STORES.items),
      idb.getAll<StoredCatalog>(STORES.catalog),
      this.getPricingSettings(await this.currentUserId()),
    ]);

    const catalogById = new Map(catalog.map((c) => [c.id, c]));
    const acquiredAt = new Map<string, string | null>();
    const gameOf = new Map<string, string | null>();
    for (const i of items) {
      acquiredAt.set(i.id, i.acquisition_date ?? i.created_at);
      gameOf.set(i.id, i.catalog_card_id
        ? catalogById.get(i.catalog_card_id)?.game ?? null
        : null);
    }

    return summariseSales(sales, {
      currency: settings.default_currency, acquiredAt, gameOf,
    });
  }

  async inventoryAging(): Promise<AgingBucket[]> {
    return inventoryAging(await this.listInventory({ limit: 10_000 }));
  }

  // -- Backup and migration ------------------------------------------------

  async exportAll(opts: { includePhotos?: boolean } = {}): Promise<BackupBundle> {
    const [catalog, identifiers, items, images, observations, settingsAll,
           sales, saleItems, expenses] = await Promise.all([
      idb.getAll<StoredCatalog>(STORES.catalog),
      idb.getAll<BackupBundle['identifiers'][number]>(STORES.identifiers),
      idb.getAll<StoredItem>(STORES.items),
      idb.getAll<InventoryImageRow>(STORES.images),
      idb.getAll<StoredObservation>(STORES.observations),
      idb.getAll<PricingSettingsRow>(STORES.settings),
      idb.getAll<SaleRow>(STORES.sales),
      idb.getAll<StoredSaleItem>(STORES.saleItems),
      idb.getAll<ExpenseRow>(STORES.expenses),
    ]);

    const photos: Record<string, string> = {};
    if (opts.includePhotos !== false) {
      for (const img of images) {
        const photo = await idb.get<StoredPhoto>(STORES.photos, img.storage_path);
        if (photo?.blob) photos[img.storage_path] = await blobToDataUrl(photo.blob);
      }
    }

    return {
      format: 'cardvault-backup',
      version: 2,
      exportedAt: now(),
      catalog: catalog.map(stripInternal),
      identifiers,
      items: items.map(stripInternal),
      images,
      photos,
      observations,
      settings: settingsAll[0] ?? null,
      sales,
      saleItems: saleItems.map(stripSaleItem),
      expenses,
    };
  }

  async importAll(
    bundle: BackupBundle, userId: string
  ): Promise<{ imported: number; skipped: number }> {
    assertBundle(bundle);
    let imported = 0;
    let skipped = 0;

    for (const c of bundle.catalog) {
      const row: StoredCatalog = {
        ...c, user_id: userId, identity_key: catalogIdentityKey(c),
      };
      try { await idb.put(STORES.catalog, row); imported++; } catch { skipped++; }
    }
    for (const i of bundle.identifiers) {
      try { await idb.put(STORES.identifiers, { ...i, user_id: userId }); } catch { /* non-fatal */ }
    }
    for (const it of bundle.items) {
      const row: StoredItem = {
        ...it, user_id: userId, cert_key: certKey(it.grading_company, it.cert_number),
      };
      try { await idb.put(STORES.items, row); imported++; } catch { skipped++; }
    }
    for (const [path, dataUrl] of Object.entries(bundle.photos ?? {})) {
      try {
        const blob = await dataUrlToBlob(dataUrl);
        await idb.put(STORES.photos, { path, blob, type: blob.type, size: blob.size });
      } catch { skipped++; }
    }
    for (const img of bundle.images) {
      try { await idb.put(STORES.images, { ...img, user_id: userId }); } catch { skipped++; }
    }
    for (const o of bundle.observations) {
      try { await idb.put(STORES.observations, { ...o, user_id: userId }); } catch { /* dupes expected */ }
    }
    // Sales and expenses arrived in version 2; older bundles simply have none.
    for (const sale of bundle.sales ?? []) {
      try { await idb.put(STORES.sales, { ...sale, user_id: userId }); imported++; }
      catch { skipped++; }
    }
    for (const line of bundle.saleItems ?? []) {
      const item = line.inventory_item_id
        ? await idb.get<StoredItem>(STORES.items, line.inventory_item_id)
        : undefined;
      const row: StoredSaleItem = {
        ...line,
        user_id: userId,
        unique_object_key: item && isUniqueObject(item.kind) ? item.id : undefined,
      };
      try { await idb.put(STORES.saleItems, row); imported++; } catch { skipped++; }
    }
    for (const e of bundle.expenses ?? []) {
      try { await idb.put(STORES.expenses, { ...e, user_id: userId }); imported++; }
      catch { skipped++; }
    }

    if (bundle.settings) {
      await idb.put(STORES.settings, { ...bundle.settings, user_id: userId });
    }
    return { imported, skipped };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drop the derived index keys that exist only inside IndexedDB. */
function stripInternal<T extends object>(row: T): Omit<T, 'identity_key' | 'cert_key'> {
  const { identity_key: _i, cert_key: _c, ...rest } = row as Record<string, unknown>;
  return rest as Omit<T, 'identity_key' | 'cert_key'>;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return res.blob();
}

export function assertBundle(b: unknown): asserts b is BackupBundle {
  const bundle = b as Partial<BackupBundle>;
  if (!bundle || bundle.format !== 'cardvault-backup') {
    throw new RuleViolation('That file is not a CardVault backup.');
  }
  if (bundle.version !== 1 && bundle.version !== 2) {
    throw new RuleViolation(
      `That backup is version ${bundle.version}, which this build cannot read.`
    );
  }
  for (const key of ['catalog', 'items', 'images'] as const) {
    if (!Array.isArray(bundle[key])) {
      throw new RuleViolation(`The backup is missing its "${key}" section and may be corrupt.`);
    }
  }
}

export const localStore = new LocalStore();
