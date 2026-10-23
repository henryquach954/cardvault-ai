/**
 * Hosted Postgres backend (Supabase).
 *
 * Multi-device, authenticated, backed up, with row-level security. The
 * database enforces every invariant independently of ./rules.ts, so a bug in
 * the client cannot corrupt the ledger.
 */

import { requireSupabase, PHOTO_BUCKET } from '../supabase';
import type {
  AgingBucket, BackupBundle, CatalogCardRow, DashboardTotals, DataStore, ExpenseRow,
  InventoryFilters, InventoryImageRow, InventoryItemFull, InventoryItemRow,
  InventoryMovementRow, InventoryStatus, ItemKind, ListingFull, ListingStatus, LotFull,
  LotItemRow, LotLine, LotRow, MarketplaceListingRow, NewExpense, NewInventoryItem,
  NewListing, NewLot, NewSale, PricingSettingsRow,
  SaleFull, SaleItemRow, SaleLine, SaleRow, SalesSummary,
} from './types';
import type { CardCandidate, CardCondition, PriceClaim } from '../../providers/types';
import {
  RuleViolation, conflictReason, isUniqueObject, saleBlockedReason, validateExpense,
  validateItem, validateSale, validateSettings,
} from './rules';
import { inventoryAging, summariseSales } from '../profit';

type TotalsRow = Pick<
  InventoryItemRow,
  'quantity' | 'quantity_available' | 'status' | 'condition' | 'catalog_card_id'
  | 'purchase_cost_cents' | 'market_value_cents' | 'market_value_override_cents'
>;

export class SupabaseStore implements DataStore {
  readonly kind = 'supabase' as const;

  async currentUserId(): Promise<string> {
    const { data, error } = await requireSupabase().auth.getUser();
    if (error || !data.user) throw new Error('Not signed in.');
    return data.user.id;
  }

  // -- Catalog ------------------------------------------------------------

  async ensureCatalogCard(candidate: CardCandidate, userId: string): Promise<CatalogCardRow> {
    const sb = requireSupabase();

    const match = () => {
      let q = sb
        .from('card_catalog')
        .select('*')
        .eq('user_id', userId)
        .eq('game', candidate.game)
        .ilike('name', candidate.name)
        .eq('language', candidate.language);

      // .is() for nulls, .eq() for values -- PostgREST distinguishes them.
      const pairs: [string, string | undefined][] = [
        ['set_code', candidate.setCode],
        ['collector_number', candidate.collectorNumber],
        ['finish', candidate.finish],
        ['variant', candidate.variant],
        ['edition', candidate.edition],
      ];
      for (const [col, val] of pairs) {
        q = val == null || val === '' ? q.is(col, null) : q.eq(col, val);
      }
      return q.maybeSingle();
    };

    const existing = await match();
    if (existing.data) return existing.data as CatalogCardRow;

    const { data, error } = await sb.from('card_catalog').insert({
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
      attributes: candidate.attributes ?? {},
      catalog_source: candidate.providerId,
      catalog_image_url: candidate.imageUrl ?? null,
    }).select().single();

    if (error) {
      // 23505 = unique_violation: another tab created it first.
      if (error.code === '23505') {
        const retry = await match();
        if (retry.data) return retry.data as CatalogCardRow;
      }
      throw error;
    }

    if (candidate.externalId) {
      await sb.from('catalog_identifiers').insert({
        user_id: userId,
        catalog_card_id: data.id,
        provider: candidate.providerId,
        external_id: candidate.externalId,
        external_url: candidate.externalUrl ?? null,
      });
    }
    return data as CatalogCardRow;
  }

  async externalIdFor(catalogCardId: string, provider: string): Promise<string | null> {
    const { data } = await requireSupabase()
      .from('catalog_identifiers')
      .select('external_id')
      .eq('catalog_card_id', catalogCardId)
      .eq('provider', provider)
      .maybeSingle();
    return data?.external_id ?? null;
  }

  // -- Inventory ----------------------------------------------------------

  async createInventoryItem(input: NewInventoryItem, userId: string): Promise<InventoryItemRow> {
    const sb = requireSupabase();

    // Validated client-side first so the operator gets a readable message
    // rather than a raw constraint name. Postgres checks it again regardless.
    validateItem({
      kind: input.kind,
      grading_company: input.gradingCompany || null,
      grade: input.grade ?? null,
      cert_number: input.certNumber || null,
      quantity: input.quantity,
      quantity_sold: 0,
      quantity_allocated: 0,
      asking_price_cents: input.askingPriceCents ?? null,
      minimum_price_cents: input.minimumPriceCents ?? null,
    });

    const { data, error } = await sb.from('inventory_items').insert({
      id: input.id,
      user_id: userId,
      catalog_card_id: input.catalogCardId,
      kind: input.kind,
      condition: input.condition,
      condition_notes: input.conditionNotes ?? null,
      defects: input.defects ?? {},
      quantity: input.quantity,
      currency: input.currency,
      purchase_cost_cents: input.purchaseCostCents,
      acquisition_date: input.acquisitionDate ?? null,
      acquisition_source: input.acquisitionSource ?? null,
      storage_location: input.storageLocation ?? null,
      sku: input.sku || null,
      notes: input.notes ?? null,
      asking_price_cents: input.askingPriceCents ?? null,
      minimum_price_cents: input.minimumPriceCents ?? null,
      grading_company: input.gradingCompany || null,
      grade: input.grade ?? null,
      cert_number: input.certNumber || null,
    }).select().single();

    if (error) throw translate(error);

    await sb.from('inventory_movements').insert({
      user_id: userId,
      inventory_item_id: data.id,
      reason: 'acquired',
      quantity_delta: input.quantity,
      note: input.acquisitionSource ?? null,
    });

    return data as InventoryItemRow;
  }

  async listInventory(filters: InventoryFilters = {}): Promise<InventoryItemFull[]> {
    const sb = requireSupabase();
    let q = sb
      .from('inventory_items')
      .select('*, card_catalog(*), inventory_images(*)')
      .limit(filters.limit ?? 200);

    // 'all' means every status, including removed. Omitting it hides removed
    // items, which is the right default for browsing. Kept identical to the
    // local backend so the two cannot drift.
    if (filters.status === 'all') {
      // no status filter at all
    } else if (filters.status) {
      q = q.eq('status', filters.status);
    } else {
      q = q.neq('status', 'removed');
    }

    if (filters.condition && filters.condition !== 'all') q = q.eq('condition', filters.condition);
    if (filters.kind && filters.kind !== 'all') q = q.eq('kind', filters.kind);

    switch (filters.sort) {
      case 'value_desc': q = q.order('market_value_cents', { ascending: false, nullsFirst: false }); break;
      case 'cost_desc': q = q.order('purchase_cost_cents', { ascending: false, nullsFirst: false }); break;
      case 'stale_price': q = q.order('last_price_refresh_at', { ascending: true, nullsFirst: true }); break;
      default: q = q.order('created_at', { ascending: false });
    }

    const { data, error } = await q;
    if (error) throw error;

    let rows = (data ?? []) as unknown as InventoryItemFull[];

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
    if (filters.sort === 'name') {
      rows.sort((a, b) => (a.card_catalog?.name ?? '').localeCompare(b.card_catalog?.name ?? ''));
    }
    return rows;
  }

  async getInventoryItem(id: string): Promise<InventoryItemFull | null> {
    const { data, error } = await requireSupabase()
      .from('inventory_items')
      .select('*, card_catalog(*), inventory_images(*)')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    return (data as unknown as InventoryItemFull) ?? null;
  }

  async updateInventoryItem(
    id: string, patch: Partial<InventoryItemRow>
  ): Promise<InventoryItemRow> {
    const { data, error } = await requireSupabase()
      .from('inventory_items').update(patch).eq('id', id).select().single();
    if (error) throw translate(error);
    return data as InventoryItemRow;
  }

  async removeInventoryItem(id: string, hard = false): Promise<void> {
    const sb = requireSupabase();
    if (hard) {
      const images = await this.listImages(id);
      if (images.length) {
        await sb.storage.from(PHOTO_BUCKET).remove(images.map((i) => i.storage_path));
      }
      const { error } = await sb.from('inventory_items').delete().eq('id', id);
      if (error) throw error;
      return;
    }
    const { error } = await sb.from('inventory_items').update({ status: 'removed' }).eq('id', id);
    if (error) throw error;
  }

  // -- Photos -------------------------------------------------------------

  async uploadPhoto(args: {
    file: File; itemId: string; userId: string; face: InventoryImageRow['face'];
  }): Promise<{ path: string }> {
    const fromName = args.file.name.split('.').pop()?.toLowerCase();
    const ext = fromName && /^[a-z0-9]{2,5}$/.test(fromName)
      ? fromName
      : (args.file.type.split('/')[1] ?? 'jpg').replace('jpeg', 'jpg');

    const path = `${args.userId}/${args.itemId}/${args.face}-${Date.now()}.${ext}`;
    const { error } = await requireSupabase().storage.from(PHOTO_BUCKET).upload(path, args.file, {
      cacheControl: '3600',
      upsert: false,
      contentType: args.file.type || 'image/jpeg',
    });
    if (error) throw error;
    return { path };
  }

  async attachImages(
    itemId: string, userId: string,
    images: { path: string; face: InventoryImageRow['face']; sortOrder: number }[]
  ): Promise<void> {
    if (images.length === 0) return;
    const { error } = await requireSupabase().from('inventory_images').insert(
      images.map((i) => ({
        user_id: userId,
        inventory_item_id: itemId,
        storage_path: i.path,
        face: i.face,
        sort_order: i.sortOrder,
      }))
    );
    if (error) throw error;
  }

  async listImages(itemId: string): Promise<InventoryImageRow[]> {
    const { data, error } = await requireSupabase()
      .from('inventory_images').select('*')
      .eq('inventory_item_id', itemId).order('sort_order');
    if (error) throw error;
    return (data ?? []) as InventoryImageRow[];
  }

  async deleteImage(image: InventoryImageRow): Promise<void> {
    const sb = requireSupabase();
    await sb.storage.from(PHOTO_BUCKET).remove([image.storage_path]);
    await sb.from('inventory_images').delete().eq('id', image.id);
  }

  async discardUploads(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await requireSupabase().storage.from(PHOTO_BUCKET).remove(paths);
  }

  async signedUrls(paths: string[], expiresIn = 3600): Promise<Record<string, string>> {
    if (paths.length === 0) return {};
    const { data, error } = await requireSupabase()
      .storage.from(PHOTO_BUCKET).createSignedUrls(paths, expiresIn);
    if (error) throw error;
    const out: Record<string, string> = {};
    for (const entry of data ?? []) {
      if (entry.signedUrl && entry.path) out[entry.path] = entry.signedUrl;
    }
    return out;
  }

  // -- Pricing ------------------------------------------------------------

  async recordPriceObservations(
    claims: PriceClaim[],
    ctx: { userId: string; catalogCardId?: string | null; inventoryItemId?: string | null }
  ): Promise<void> {
    if (claims.length === 0) return;
    const { error } = await requireSupabase().from('price_observations').insert(
      claims.map((c) => ({
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
        status: c.status,
        notes: c.notes ?? null,
        raw: (c.raw ?? null) as Record<string, unknown> | null,
      }))
    );
    // A duplicate sold observation on refresh is expected, not an error.
    if (error && error.code !== '23505') throw error;
  }

  async getPriceObservations(args: {
    catalogCardId?: string | null; inventoryItemId?: string | null; limit?: number;
  }): Promise<PriceClaim[]> {
    const sb = requireSupabase();
    let q = sb.from('price_observations').select('*')
      .order('retrieved_at', { ascending: false })
      .limit(args.limit ?? 100);

    if (args.inventoryItemId) q = q.eq('inventory_item_id', args.inventoryItemId);
    else if (args.catalogCardId) q = q.eq('catalog_card_id', args.catalogCardId);
    else return [];

    const { data, error } = await q;
    if (error) throw error;

    return (data ?? []).map((r) => ({
      provider: r.provider,
      claimType: r.claim_type,
      priceCents: r.price_cents,
      currency: r.currency,
      condition: r.condition,
      gradingCompany: r.grading_company,
      grade: r.grade == null ? null : Number(r.grade),
      finish: r.finish,
      variant: r.variant,
      observedAt: r.observed_at,
      retrievedAt: r.retrieved_at,
      externalId: r.external_id,
      sourceUrl: r.source_url,
      status: r.status,
      notes: r.notes,
      raw: r.raw,
    })) as PriceClaim[];
  }

  async getPricingSettings(userId: string): Promise<PricingSettingsRow> {
    const sb = requireSupabase();
    const { data } = await sb.from('pricing_settings')
      .select('*').eq('user_id', userId).maybeSingle();
    if (data) return data as PricingSettingsRow;

    const { data: created, error } = await sb
      .from('pricing_settings').insert({ user_id: userId }).select().single();
    if (error) throw error;
    return created as PricingSettingsRow;
  }

  async updatePricingSettings(
    userId: string, patch: Partial<PricingSettingsRow>
  ): Promise<PricingSettingsRow> {
    validateSettings(patch);
    const { data, error } = await requireSupabase()
      .from('pricing_settings').update(patch).eq('user_id', userId).select().single();
    if (error) throw translate(error);
    return data as PricingSettingsRow;
  }

  // -- Aggregates ---------------------------------------------------------

  async dashboardTotals(): Promise<DashboardTotals> {
    const { data, error } = await requireSupabase()
      .from('inventory_items')
      .select(
        'quantity, quantity_available, status, condition, catalog_card_id, ' +
        'purchase_cost_cents, market_value_cents, market_value_override_cents'
      )
      .neq('status', 'removed')
      .overrideTypes<TotalsRow[]>();
    if (error) throw error;

    const t: DashboardTotals = {
      itemCount: 0, cardCount: 0, totalCostCents: 0, totalValueCents: 0,
      valuedItemCount: 0, listedCount: 0, soldCount: 0,
      needsIdentification: 0, needsConditionReview: 0,
    };

    for (const r of data ?? []) {
      t.itemCount += 1;
      t.cardCount += r.quantity ?? 0;
      t.totalCostCents += (r.purchase_cost_cents ?? 0) * (r.quantity ?? 1);

      const value = r.market_value_override_cents ?? r.market_value_cents;
      if (value != null) {
        t.totalValueCents += value * (r.quantity_available ?? r.quantity ?? 1);
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
    const sb = requireSupabase();
    const warnings: string[] = [];

    // 1. Pre-flight every line before writing anything. Postgres enforces all
    //    of this too, but checking first means a bad line produces a readable
    //    message instead of a half-written sale plus a constraint name.
    const { data: itemRows, error: itemError } = await sb
      .from('inventory_items')
      .select('id, kind, quantity, quantity_sold, quantity_allocated, status, purchase_cost_cents, sold_at')
      .in('id', input.items.map((i) => i.inventoryItemId));
    if (itemError) throw itemError;

    const byId = new Map((itemRows ?? []).map((r) => [r.id, r]));
    const priorTimes: string[] = [];

    for (const line of input.items) {
      const item = byId.get(line.inventoryItemId);
      if (!item) throw new RuleViolation('One of those cards no longer exists.');

      let alreadySold = false;
      if (isUniqueObject(item.kind)) {
        const { count } = await sb
          .from('sale_items')
          .select('id', { count: 'exact', head: true })
          .eq('inventory_item_id', item.id);
        alreadySold = (count ?? 0) > 0;
      }

      const blocked = saleBlockedReason(item, line.quantity, alreadySold);
      if (blocked) throw new RuleViolation(blocked);

      const { data: prior } = await sb
        .from('sale_items')
        .select('sales(sold_at)')
        .eq('inventory_item_id', item.id);
      for (const p of prior ?? []) {
        const sold = (p as { sales?: { sold_at?: string } }).sales?.sold_at;
        if (sold) priorTimes.push(sold);
      }
    }

    const conflict = conflictReason(input.soldAt, priorTimes);

    // 2. Insert the sale header.
    const { data: sale, error: saleError } = await sb.from('sales').insert({
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
    }).select().single();
    if (saleError) throw translate(saleError);
    if (conflict) warnings.push(conflict);

    // 3. Lines, with cost snapshot. is_unique_item is set by a database
    //    trigger, deliberately not by this client.
    const { error: linesError } = await sb.from('sale_items').insert(
      input.items.map((line) => ({
        user_id: userId,
        sale_id: sale.id,
        inventory_item_id: line.inventoryItemId,
        quantity: line.quantity,
        unit_cost_cents: byId.get(line.inventoryItemId)?.purchase_cost_cents ?? null,
        unit_price_cents: line.unitPriceCents ?? null,
      }))
    );
    if (linesError) {
      // Roll back the header so a failed sale does not leave an orphan.
      await sb.from('sales').delete().eq('id', sale.id);
      if (linesError.code === '23505') {
        throw new RuleViolation(
          'That graded slab has already been sold. The same physical slab cannot be sold twice.'
        );
      }
      throw translate(linesError);
    }

    // 4. Decrement the ledger. The generated column's CHECK is the real
    //    guarantee against overselling.
    for (const line of input.items) {
      const item = byId.get(line.inventoryItemId)!;
      const sold = item.quantity_sold + line.quantity;
      const stillAvailable = item.quantity - sold - item.quantity_allocated;

      const { error } = await sb.from('inventory_items').update({
        quantity_sold: sold,
        status: stillAvailable <= 0 ? 'sold' : item.status,
        sold_at: stillAvailable <= 0 ? input.soldAt : item.sold_at,
      }).eq('id', item.id);
      if (error) throw translate(error);

      await sb.from('inventory_movements').insert({
        user_id: userId,
        inventory_item_id: item.id,
        reason: 'sold',
        quantity_delta: -line.quantity,
        sale_id: sale.id,
        note: `Sold via ${input.channel}`,
      });
    }

    // 5. No publishing integration exists, so nothing can be ended for you.
    warnings.push(
      `If this card is listed anywhere else, end those listings yourself — ` +
      `no marketplace integration is connected, so nothing was ended automatically.`
    );

    return { sale: sale as SaleRow, warnings: [...new Set(warnings)] };
  }

  async listSales(
    filters: { from?: string; to?: string; limit?: number } = {}
  ): Promise<SaleFull[]> {
    const sb = requireSupabase();
    let q = sb
      .from('sales')
      .select('*, sale_items(*, inventory_items(kind, grading_company, grade, card_catalog(name, set_name, collector_number)))')
      .order('sold_at', { ascending: false })
      .limit(filters.limit ?? 500);
    if (filters.from) q = q.gte('sold_at', filters.from);
    if (filters.to) q = q.lte('sold_at', filters.to);

    const { data, error } = await q;
    if (error) throw error;

    return (data ?? []).map((row) => {
      const { sale_items: lines, ...sale } = row as Record<string, unknown> & {
        sale_items?: Record<string, unknown>[];
      };
      return {
        ...(sale as unknown as SaleRow),
        items: (lines ?? []).map((l) => {
          const item = l.inventory_items as {
            kind?: string; grading_company?: string | null; grade?: number | null;
            card_catalog?: { name?: string; set_name?: string; collector_number?: string };
          } | null;
          const { inventory_items: _drop, ...rest } = l;
          return {
            ...(rest as unknown as SaleItemRow),
            card_name: item?.card_catalog?.name ?? null,
            set_name: item?.card_catalog?.set_name ?? null,
            collector_number: item?.card_catalog?.collector_number ?? null,
            kind: (item?.kind ?? null) as SaleLine['kind'],
            grading_company: item?.grading_company ?? null,
            grade: item?.grade ?? null,
          } satisfies SaleLine;
        }),
      };
    });
  }

  async getSale(id: string): Promise<SaleFull | null> {
    const all = await this.listSales();
    return all.find((s) => s.id === id) ?? null;
  }

  async voidSale(id: string, userId: string): Promise<void> {
    const sb = requireSupabase();
    const { data: lines } = await sb
      .from('sale_items').select('*').eq('sale_id', id);

    for (const line of (lines ?? []) as SaleItemRow[]) {
      if (!line.inventory_item_id) continue;
      const { data: item } = await sb
        .from('inventory_items')
        .select('quantity_sold, status')
        .eq('id', line.inventory_item_id)
        .maybeSingle();
      if (!item) continue;

      await sb.from('inventory_items').update({
        quantity_sold: Math.max(0, item.quantity_sold - line.quantity),
        status: item.status === 'sold' ? 'in_stock' : item.status,
        sold_at: null,
      }).eq('id', line.inventory_item_id);

      // Appended, not erased: the movement ledger is a history.
      await sb.from('inventory_movements').insert({
        user_id: userId,
        inventory_item_id: line.inventory_item_id,
        reason: 'returned',
        quantity_delta: line.quantity,
        sale_id: id,
        note: 'Sale voided',
      });
    }

    // sale_items cascade on delete.
    const { error } = await sb.from('sales').delete().eq('id', id);
    if (error) throw error;
  }

  // -- Lots -----------------------------------------------------------------

  async createLot(input: NewLot, userId: string): Promise<LotRow> {
    if (!input.title.trim()) {
      throw new RuleViolation('Give the lot a title so you can find it later.', 'title');
    }
    const { data, error } = await requireSupabase().from('inventory_lots').insert({
      user_id: userId,
      title: input.title.trim(),
      description: input.description ?? null,
      game: input.game ?? null,
      currency: input.currency,
      asking_price_cents: input.askingPriceCents ?? null,
      minimum_price_cents: input.minimumPriceCents ?? null,
      card_count: input.cardCount ?? null,
      storage_location: input.storageLocation ?? null,
      notes: input.notes ?? null,
    }).select().single();
    if (error) throw translate(error);
    return data as LotRow;
  }

  private hydrateLot(row: Record<string, unknown>): LotFull {
    const { inventory_lot_items: lines, ...lot } = row as Record<string, unknown> & {
      inventory_lot_items?: Record<string, unknown>[];
    };

    let totalCostCents = 0;
    let costIncomplete = false;
    let allocatedCount = 0;

    const items: LotLine[] = (lines ?? []).map((l) => {
      const item = l.inventory_items as {
        condition?: CardCondition; kind?: ItemKind; purchase_cost_cents?: number | null;
        grading_company?: string | null; grade?: number | null;
        card_catalog?: { name?: string; set_name?: string; collector_number?: string };
      } | null;
      const { inventory_items: _drop, ...rest } = l;
      const line = rest as unknown as LotItemRow;

      const cost = item?.purchase_cost_cents ?? null;
      if (cost == null) costIncomplete = true;
      else totalCostCents += cost * line.quantity;
      allocatedCount += line.quantity;

      return {
        ...line,
        card_name: item?.card_catalog?.name ?? null,
        set_name: item?.card_catalog?.set_name ?? null,
        collector_number: item?.card_catalog?.collector_number ?? null,
        condition: item?.condition ?? null,
        kind: item?.kind ?? null,
        grading_company: item?.grading_company ?? null,
        grade: item?.grade ?? null,
        unit_cost_cents: cost,
      } satisfies LotLine;
    });

    return {
      ...(lot as unknown as LotRow),
      items, totalCostCents, costIncomplete, allocatedCount,
    };
  }

  async listLots(filters: { status?: InventoryStatus | 'all' } = {}): Promise<LotFull[]> {
    let q = requireSupabase()
      .from('inventory_lots')
      .select(
        '*, inventory_lot_items(*, inventory_items(condition, kind, purchase_cost_cents, ' +
        'grading_company, grade, card_catalog(name, set_name, collector_number)))'
      )
      .order('created_at', { ascending: false });

    if (filters.status === 'all') {
      // every status
    } else if (filters.status) {
      q = q.eq('status', filters.status);
    } else {
      q = q.neq('status', 'removed');
    }

    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []).map((r) => this.hydrateLot(r as unknown as Record<string, unknown>));
  }

  async getLot(id: string): Promise<LotFull | null> {
    const { data, error } = await requireSupabase()
      .from('inventory_lots')
      .select(
        '*, inventory_lot_items(*, inventory_items(condition, kind, purchase_cost_cents, ' +
        'grading_company, grade, card_catalog(name, set_name, collector_number)))'
      )
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    return data ? this.hydrateLot(data as unknown as Record<string, unknown>) : null;
  }

  async updateLot(id: string, patch: Partial<LotRow>): Promise<LotRow> {
    const { data, error } = await requireSupabase()
      .from('inventory_lots').update(patch).eq('id', id).select().single();
    if (error) throw translate(error);
    return data as LotRow;
  }

  async deleteLot(id: string, userId: string): Promise<void> {
    const sb = requireSupabase();
    const { data: lines } = await sb
      .from('inventory_lot_items').select('*').eq('lot_id', id);
    for (const line of (lines ?? []) as LotItemRow[]) {
      await this.releaseAllocation(line, userId, 'Lot deleted');
    }
    const { error } = await sb.from('inventory_lots').delete().eq('id', id);
    if (error) throw error;
  }

  private async releaseAllocation(
    line: LotItemRow, userId: string, note: string
  ): Promise<void> {
    const sb = requireSupabase();
    const { data: item } = await sb
      .from('inventory_items')
      .select('quantity_allocated, status')
      .eq('id', line.inventory_item_id)
      .maybeSingle();

    if (item) {
      await sb.from('inventory_items').update({
        quantity_allocated: Math.max(0, item.quantity_allocated - line.quantity),
        status: item.status === 'allocated_to_lot' ? 'in_stock' : item.status,
      }).eq('id', line.inventory_item_id);

      await sb.from('inventory_movements').insert({
        user_id: userId,
        inventory_item_id: line.inventory_item_id,
        reason: 'released_from_lot',
        quantity_delta: line.quantity,
        lot_id: line.lot_id,
        note,
      });
    }
    await sb.from('inventory_lot_items').delete().eq('id', line.id);
  }

  async addItemsToLot(
    lotId: string,
    items: { inventoryItemId: string; quantity: number }[],
    userId: string
  ): Promise<{ added: number; skipped: { label: string; reason: string }[] }> {
    const sb = requireSupabase();

    const { data: lot } = await sb
      .from('inventory_lots').select('title').eq('id', lotId).maybeSingle();
    if (!lot) throw new RuleViolation('That lot no longer exists.');

    const { data: existing } = await sb
      .from('inventory_lot_items').select('inventory_item_id').eq('lot_id', lotId);
    const alreadyIn = new Set((existing ?? []).map((l) => l.inventory_item_id));

    const { data: rows } = await sb
      .from('inventory_items')
      .select('id, quantity, quantity_sold, quantity_allocated, quantity_available, status')
      .in('id', items.map((i) => i.inventoryItemId));
    const byId = new Map((rows ?? []).map((r) => [r.id, r]));

    let added = 0;
    const skipped: { label: string; reason: string }[] = [];

    for (const entry of items) {
      const item = byId.get(entry.inventoryItemId);
      const label = entry.inventoryItemId;
      if (!item) { skipped.push({ label, reason: 'no longer exists' }); continue; }
      if (alreadyIn.has(item.id)) {
        skipped.push({ label, reason: 'already in this lot' });
        continue;
      }
      if (entry.quantity > item.quantity_available) {
        skipped.push({
          label,
          reason: item.quantity_available <= 0
            ? 'none available — it may already be in another lot or sold'
            : `only ${item.quantity_available} available`,
        });
        continue;
      }

      const { error: allocError } = await sb.from('inventory_items').update({
        quantity_allocated: item.quantity_allocated + entry.quantity,
        status: item.quantity_available - entry.quantity <= 0
          ? 'allocated_to_lot'
          : item.status,
      }).eq('id', item.id);
      if (allocError) {
        skipped.push({ label, reason: translate(allocError).message });
        continue;
      }

      const { error: lineError } = await sb.from('inventory_lot_items').insert({
        user_id: userId,
        lot_id: lotId,
        inventory_item_id: item.id,
        quantity: entry.quantity,
      });
      if (lineError) {
        // Undo the allocation so a failed insert cannot strand stock.
        await sb.from('inventory_items')
          .update({ quantity_allocated: item.quantity_allocated })
          .eq('id', item.id);
        skipped.push({ label, reason: 'could not be added' });
        continue;
      }

      await sb.from('inventory_movements').insert({
        user_id: userId,
        inventory_item_id: item.id,
        reason: 'allocated_to_lot',
        quantity_delta: -entry.quantity,
        lot_id: lotId,
        note: `Allocated to "${lot.title}"`,
      });
      added += 1;
    }

    return { added, skipped };
  }

  async removeItemFromLot(lotItemId: string, userId: string): Promise<void> {
    const { data: line } = await requireSupabase()
      .from('inventory_lot_items').select('*').eq('id', lotItemId).maybeSingle();
    if (!line) return;
    await this.releaseAllocation(line as LotItemRow, userId, 'Removed from lot');
  }

  async recordLotSale(
    lotId: string,
    input: Omit<NewSale, 'items'>,
    userId: string
  ): Promise<{ sale: SaleRow; warnings: string[] }> {
    const sb = requireSupabase();

    const lot = await this.getLot(lotId);
    if (!lot) throw new RuleViolation('That lot no longer exists.');
    if (lot.status === 'sold') throw new RuleViolation('This lot has already been sold.');
    if (lot.items.length === 0) {
      throw new RuleViolation('This lot has no cards allocated to it yet.');
    }
    validateSale({ ...input, items: lot.items.map((l) => ({ quantity: l.quantity })) });

    const { data: sale, error: saleError } = await sb.from('sales').insert({
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
    }).select().single();
    if (saleError) throw translate(saleError);

    const { error: lineError } = await sb.from('sale_items').insert({
      user_id: userId,
      sale_id: sale.id,
      lot_id: lotId,
      quantity: 1,
      unit_cost_cents: lot.totalCostCents,
      unit_price_cents: input.salePriceCents,
    });
    if (lineError) {
      await sb.from('sales').delete().eq('id', sale.id);
      throw translate(lineError);
    }

    for (const line of lot.items) {
      const { data: item } = await sb
        .from('inventory_items')
        .select('quantity, quantity_sold, quantity_allocated')
        .eq('id', line.inventory_item_id)
        .maybeSingle();
      if (!item) continue;

      const sold = item.quantity_sold + line.quantity;
      await sb.from('inventory_items').update({
        quantity_allocated: Math.max(0, item.quantity_allocated - line.quantity),
        quantity_sold: sold,
        status: item.quantity - sold <= 0 ? 'sold' : 'in_stock',
        sold_at: input.soldAt,
      }).eq('id', line.inventory_item_id);

      await sb.from('inventory_movements').insert({
        user_id: userId,
        inventory_item_id: line.inventory_item_id,
        reason: 'sold',
        quantity_delta: 0, // deducted at allocation; this reclassifies it
        sale_id: sale.id,
        lot_id: lotId,
        note: `Sold as part of "${lot.title}"`,
      });
    }

    await sb.from('inventory_lots').update({ status: 'sold' }).eq('id', lotId);

    return {
      sale: sale as SaleRow,
      warnings: [
        `If this lot is listed anywhere else, end those listings yourself — ` +
        `no marketplace integration is connected, so nothing was ended automatically.`,
      ],
    };
  }

  // -- Marketplace listings -------------------------------------------------

  async saveListing(input: NewListing, userId: string): Promise<MarketplaceListingRow> {
    const sb = requireSupabase();

    const { data: existing } = input.inventoryItemId
      ? await sb.from('marketplace_listings').select('*')
          .eq('inventory_item_id', input.inventoryItemId)
          .eq('marketplace', input.marketplace)
          .maybeSingle()
      : { data: null };

    const payload = {
      user_id: userId,
      inventory_item_id: input.inventoryItemId ?? null,
      lot_id: input.lotId ?? null,
      marketplace: input.marketplace,
      // A published listing keeps its status; regenerating copy must not
      // silently un-publish something that is live.
      status: existing?.status === 'published'
        ? 'published'
        : input.status ?? existing?.status ?? 'draft',
      title: input.title,
      description: input.description,
      category: input.category ?? null,
      condition_text: input.conditionText ?? null,
      keywords: input.keywords ?? null,
      shipping_notes: input.shippingNotes ?? null,
      currency: input.currency,
      price_cents: input.priceCents,
    };

    const q = existing
      ? sb.from('marketplace_listings').update(payload).eq('id', existing.id)
      : sb.from('marketplace_listings').insert(payload);

    const { data, error } = await q.select().single();
    if (error) throw translate(error);
    return data as MarketplaceListingRow;
  }

  async listListings(filters: {
    status?: ListingStatus | 'all';
    marketplace?: 'ebay' | 'facebook' | 'mercari';
    inventoryItemId?: string;
  } = {}): Promise<ListingFull[]> {
    let q = requireSupabase()
      .from('marketplace_listings')
      .select('*, inventory_items(card_catalog(name, set_name)), inventory_lots(title)')
      .order('updated_at', { ascending: false });

    if (filters.inventoryItemId) q = q.eq('inventory_item_id', filters.inventoryItemId);
    if (filters.marketplace) q = q.eq('marketplace', filters.marketplace);
    if (filters.status && filters.status !== 'all') q = q.eq('status', filters.status);

    const { data, error } = await q;
    if (error) throw error;

    return (data ?? []).map((row) => {
      const r = row as Record<string, unknown> & {
        inventory_items?: { card_catalog?: { name?: string; set_name?: string } } | null;
        inventory_lots?: { title?: string } | null;
      };
      const { inventory_items: item, inventory_lots: lot, ...rest } = r;
      return {
        ...(rest as unknown as MarketplaceListingRow),
        card_name: item?.card_catalog?.name ?? null,
        set_name: item?.card_catalog?.set_name ?? null,
        lot_title: lot?.title ?? null,
      };
    });
  }

  async updateListing(
    id: string, patch: Partial<MarketplaceListingRow>
  ): Promise<MarketplaceListingRow> {
    const { data, error } = await requireSupabase()
      .from('marketplace_listings').update(patch).eq('id', id).select().single();
    if (error) throw translate(error);
    return data as MarketplaceListingRow;
  }

  async deleteListing(id: string): Promise<void> {
    const { error } = await requireSupabase()
      .from('marketplace_listings').delete().eq('id', id);
    if (error) throw error;
  }

  // -- Expenses -------------------------------------------------------------

  async recordExpense(input: NewExpense, userId: string): Promise<ExpenseRow> {
    validateExpense(input);
    const { data, error } = await requireSupabase().from('expenses').insert({
      user_id: userId,
      incurred_on: input.incurredOn,
      category: input.category,
      description: input.description ?? null,
      currency: input.currency,
      amount_cents: input.amountCents,
    }).select().single();
    if (error) throw translate(error);
    return data as ExpenseRow;
  }

  async listExpenses(filters: { from?: string; to?: string } = {}): Promise<ExpenseRow[]> {
    let q = requireSupabase().from('expenses').select('*')
      .order('incurred_on', { ascending: false });
    if (filters.from) q = q.gte('incurred_on', filters.from);
    if (filters.to) q = q.lte('incurred_on', filters.to);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as ExpenseRow[];
  }

  async deleteExpense(id: string): Promise<void> {
    const { error } = await requireSupabase().from('expenses').delete().eq('id', id);
    if (error) throw error;
  }

  async listMovements(inventoryItemId: string): Promise<InventoryMovementRow[]> {
    const { data, error } = await requireSupabase()
      .from('inventory_movements').select('*')
      .eq('inventory_item_id', inventoryItemId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []) as InventoryMovementRow[];
  }

  async salesSummary(range: { from?: string; to?: string } = {}): Promise<SalesSummary> {
    const sb = requireSupabase();
    const [sales, items, settings] = await Promise.all([
      this.listSales(range),
      sb.from('inventory_items')
        .select('id, acquisition_date, created_at, card_catalog(game)'),
      this.getPricingSettings(await this.currentUserId()),
    ]);

    const acquiredAt = new Map<string, string | null>();
    const gameOf = new Map<string, string | null>();
    for (const i of (items.data ?? []) as {
      id: string; acquisition_date: string | null; created_at: string;
      card_catalog?: { game?: string } | null;
    }[]) {
      acquiredAt.set(i.id, i.acquisition_date ?? i.created_at);
      gameOf.set(i.id, i.card_catalog?.game ?? null);
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
    const sb = requireSupabase();
    const [catalog, identifiers, items, images, observations, settings,
           sales, saleItems, expenses] = await Promise.all([
      sb.from('card_catalog').select('*'),
      sb.from('catalog_identifiers').select('*'),
      sb.from('inventory_items').select('*'),
      sb.from('inventory_images').select('*'),
      sb.from('price_observations').select('*'),
      sb.from('pricing_settings').select('*').maybeSingle(),
      sb.from('sales').select('*'),
      sb.from('sale_items').select('*'),
      sb.from('expenses').select('*'),
    ]);

    const photos: Record<string, string> = {};
    if (opts.includePhotos !== false) {
      for (const img of (images.data ?? []) as InventoryImageRow[]) {
        const { data } = await sb.storage.from(PHOTO_BUCKET).download(img.storage_path);
        if (data) photos[img.storage_path] = await blobToDataUrl(data);
      }
    }

    return {
      format: 'cardvault-backup',
      version: 2,
      exportedAt: new Date().toISOString(),
      catalog: (catalog.data ?? []) as CatalogCardRow[],
      identifiers: (identifiers.data ?? []) as BackupBundle['identifiers'],
      items: (items.data ?? []) as InventoryItemRow[],
      images: (images.data ?? []) as InventoryImageRow[],
      photos,
      observations: (observations.data ?? []) as Record<string, unknown>[],
      settings: (settings.data ?? null) as PricingSettingsRow | null,
      sales: (sales.data ?? []) as SaleRow[],
      saleItems: (saleItems.data ?? []) as SaleItemRow[],
      expenses: (expenses.data ?? []) as ExpenseRow[],
    };
  }

  /**
   * Import a backup, typically one exported from local mode.
   *
   * Ids are preserved so photos, images and observations stay linked, but
   * every user_id is rewritten to the signed-in account -- a local export
   * carries a synthetic local user id that means nothing here.
   */
  async importAll(
    bundle: BackupBundle, userId: string
  ): Promise<{ imported: number; skipped: number }> {
    const sb = requireSupabase();
    let imported = 0;
    let skipped = 0;

    const push = async (table: string, rows: Record<string, unknown>[]) => {
      if (rows.length === 0) return;
      const { error } = await sb.from(table).upsert(
        rows.map((r) => ({ ...r, user_id: userId })),
        { onConflict: 'id', ignoreDuplicates: true }
      );
      if (error) skipped += rows.length;
      else imported += rows.length;
    };

    await push('card_catalog', bundle.catalog as unknown as Record<string, unknown>[]);
    await push('catalog_identifiers', bundle.identifiers as unknown as Record<string, unknown>[]);

    // quantity_available is a generated column; Postgres rejects any attempt
    // to write it, so it is stripped before upload.
    await push(
      'inventory_items',
      (bundle.items as unknown as Record<string, unknown>[]).map(
        ({ quantity_available: _drop, ...rest }) => rest
      )
    );

    for (const [path, dataUrl] of Object.entries(bundle.photos ?? {})) {
      try {
        const blob = await (await fetch(dataUrl)).blob();
        // Rewrite the leading user-id segment so storage policies match.
        const rest = path.split('/').slice(1).join('/');
        const { error } = await sb.storage
          .from(PHOTO_BUCKET).upload(`${userId}/${rest}`, blob, { upsert: true });
        if (error) skipped += 1;
      } catch { skipped += 1; }
    }

    await push(
      'inventory_images',
      (bundle.images as unknown as Record<string, unknown>[]).map((img) => ({
        ...img,
        storage_path: `${userId}/${String(img.storage_path).split('/').slice(1).join('/')}`,
      }))
    );
    await push('price_observations', bundle.observations);

    // Sales must land before their lines, and is_unique_item is recomputed by
    // the database trigger rather than trusted from the file.
    await push('sales', (bundle.sales ?? []) as unknown as Record<string, unknown>[]);
    await push(
      'sale_items',
      ((bundle.saleItems ?? []) as unknown as Record<string, unknown>[]).map(
        ({ is_unique_item: _drop, ...rest }) => rest
      )
    );
    await push('expenses', (bundle.expenses ?? []) as unknown as Record<string, unknown>[]);

    if (bundle.settings) {
      await sb.from('pricing_settings')
        .update({ ...bundle.settings, user_id: userId })
        .eq('user_id', userId);
    }
    return { imported, skipped };
  }
}

/** Turn a Postgres constraint name into something a human can act on. */
function translate(error: { code?: string; message?: string }): Error {
  const msg = error.message ?? '';
  if (/inventory_grade_consistency/.test(msg)) {
    return new RuleViolation('A graded slab needs a grading company and a grade; a raw card must have neither.');
  }
  if (/inventory_unique_items_single/.test(msg)) {
    return new RuleViolation('A graded slab is a unique object, so its quantity must be 1.');
  }
  if (/inventory_min_le_ask/.test(msg)) {
    return new RuleViolation('The minimum acceptable price cannot exceed the asking price.');
  }
  if (/inventory_available_nonneg/.test(msg)) {
    return new RuleViolation('That would leave fewer than zero copies available.');
  }
  if (/inventory_items_cert_uniq/.test(msg)) {
    return new RuleViolation('A slab with that certification number is already in your inventory.');
  }
  if (/listing_published_needs_proof/.test(msg)) {
    return new RuleViolation(
      'A listing cannot be marked Published without a real listing id from the platform.'
    );
  }
  if (/pricing_condition_adjustments_sane/.test(msg)) {
    return new RuleViolation('Condition adjustments must be whole percentages between 1 and 100.');
  }
  return error as Error;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export const supabaseStore = new SupabaseStore();
