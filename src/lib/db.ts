/**
 * Data access facade.
 *
 * Pages import only from here. Which backend answers is decided once, at
 * module load, by whether Supabase credentials exist:
 *
 *   credentials present -> hosted Postgres, multi-device, authenticated
 *   credentials absent  -> IndexedDB in this browser, no account
 *
 * Adding the credentials later switches the whole app over with no code
 * change. Existing local data does not move automatically -- Settings has an
 * explicit export/import for that, because silently uploading a local
 * inventory to a new cloud account should be a decision, not a side effect.
 */

import { isSupabaseConfigured } from './supabase';
import { localStore } from './store/local';
import { supabaseStore } from './store/supabase';
import type { DataStore } from './store/types';

export const store: DataStore = isSupabaseConfigured ? supabaseStore : localStore;

/** 'local' | 'supabase'. Surfaced in the UI so the mode is never ambiguous. */
export const storageMode = store.kind;

export type {
  AgingBucket, BackupBundle, CatalogCardRow, DashboardTotals, DataStore, ExpenseRow,
  InventoryFilters, InventoryImageRow, InventoryItemFull, InventoryItemRow,
  InventoryMovementRow, InventoryStatus, ItemKind, NewExpense, NewInventoryItem,
  ListingFull, ListingStatus, LotFull, LotItemRow, LotLine, LotRow, MarketplaceListingRow,
  NewListing, NewLot, NewSale, PricingSettingsRow, SaleChannel,
  SaleFull, SaleItemRow, SaleLine, SaleRow, SalesSummary,
} from './store/types';

export { SALE_CHANNELS, EXPENSE_CATEGORIES, LISTING_STATUS_LABELS } from './store/types';

export { RuleViolation } from './store/rules';
export { assertBundle } from './store/local';
export { storageEstimate, idbAvailable } from './store/idb';

// --- Delegating API --------------------------------------------------------
// Bound as standalone functions so existing call sites read unchanged.

export const currentUserId: DataStore['currentUserId'] = () => store.currentUserId();

export const ensureCatalogCard: DataStore['ensureCatalogCard'] = (c, u) =>
  store.ensureCatalogCard(c, u);
export const externalIdFor: DataStore['externalIdFor'] = (id, p) => store.externalIdFor(id, p);

export const createInventoryItem: DataStore['createInventoryItem'] = (i, u) =>
  store.createInventoryItem(i, u);
export const listInventory: DataStore['listInventory'] = (f) => store.listInventory(f);
export const getInventoryItem: DataStore['getInventoryItem'] = (id) => store.getInventoryItem(id);
export const updateInventoryItem: DataStore['updateInventoryItem'] = (id, p) =>
  store.updateInventoryItem(id, p);
export const removeInventoryItem: DataStore['removeInventoryItem'] = (id, hard) =>
  store.removeInventoryItem(id, hard);

export const uploadPhoto: DataStore['uploadPhoto'] = (a) => store.uploadPhoto(a);
export const attachImages: DataStore['attachImages'] = (i, u, imgs) =>
  store.attachImages(i, u, imgs);
export const listImages: DataStore['listImages'] = (id) => store.listImages(id);
export const deleteImage: DataStore['deleteImage'] = (img) => store.deleteImage(img);
export const discardUploads: DataStore['discardUploads'] = (p) => store.discardUploads(p);
export const signedUrls: DataStore['signedUrls'] = (p, e) => store.signedUrls(p, e);

export const recordPriceObservations: DataStore['recordPriceObservations'] = (c, ctx) =>
  store.recordPriceObservations(c, ctx);
export const getPriceObservations: DataStore['getPriceObservations'] = (a) =>
  store.getPriceObservations(a);

export const getPricingSettings: DataStore['getPricingSettings'] = (u) =>
  store.getPricingSettings(u);
export const updatePricingSettings: DataStore['updatePricingSettings'] = (u, p) =>
  store.updatePricingSettings(u, p);

export const dashboardTotals: DataStore['dashboardTotals'] = () => store.dashboardTotals();

export const recordSale: DataStore['recordSale'] = (s, u) => store.recordSale(s, u);
export const listSales: DataStore['listSales'] = (f) => store.listSales(f);
export const getSale: DataStore['getSale'] = (id) => store.getSale(id);
export const voidSale: DataStore['voidSale'] = (id, u) => store.voidSale(id, u);

export const createLot: DataStore['createLot'] = (l, u) => store.createLot(l, u);
export const listLots: DataStore['listLots'] = (f) => store.listLots(f);
export const getLot: DataStore['getLot'] = (id) => store.getLot(id);
export const updateLot: DataStore['updateLot'] = (id, p) => store.updateLot(id, p);
export const deleteLot: DataStore['deleteLot'] = (id, u) => store.deleteLot(id, u);
export const addItemsToLot: DataStore['addItemsToLot'] = (l, i, u) =>
  store.addItemsToLot(l, i, u);
export const removeItemFromLot: DataStore['removeItemFromLot'] = (id, u) =>
  store.removeItemFromLot(id, u);
export const recordLotSale: DataStore['recordLotSale'] = (l, i, u) =>
  store.recordLotSale(l, i, u);

export const saveListing: DataStore['saveListing'] = (l, u) => store.saveListing(l, u);
export const listListings: DataStore['listListings'] = (f) => store.listListings(f);
export const updateListing: DataStore['updateListing'] = (id, p) => store.updateListing(id, p);
export const deleteListing: DataStore['deleteListing'] = (id) => store.deleteListing(id);

export const recordExpense: DataStore['recordExpense'] = (e, u) => store.recordExpense(e, u);
export const listExpenses: DataStore['listExpenses'] = (f) => store.listExpenses(f);
export const deleteExpense: DataStore['deleteExpense'] = (id) => store.deleteExpense(id);

export const listMovements: DataStore['listMovements'] = (id) => store.listMovements(id);
export const salesSummary: DataStore['salesSummary'] = (r) => store.salesSummary(r);
export const inventoryAging: DataStore['inventoryAging'] = () => store.inventoryAging();

export const exportAll: DataStore['exportAll'] = (o) => store.exportAll(o);
export const importAll: DataStore['importAll'] = (b, u) => store.importAll(b, u);
