/**
 * A small promise wrapper over IndexedDB.
 *
 * Deliberately dependency-free: the whole surface this app needs is get, put,
 * delete, getAll and a couple of index reads, which is less code than the
 * wrapper libraries that would otherwise be pulled in.
 *
 * IndexedDB is used rather than localStorage because photographs are Blobs.
 * localStorage only stores strings, so photos would have to be base64-encoded,
 * inflating them by a third and colliding with its ~5 MB ceiling after a
 * handful of cards.
 */

export const DB_NAME = 'cardvault';
/** v2: sales/expenses. v3: lots. v4: marketplace listings. */
export const DB_VERSION = 4;

export const STORES = {
  catalog: 'catalog',
  identifiers: 'identifiers',
  items: 'items',
  images: 'images',
  photos: 'photos',
  observations: 'observations',
  movements: 'movements',
  settings: 'settings',
  sales: 'sales',
  saleItems: 'sale_items',
  expenses: 'expenses',
  lots: 'lots',
  lotItems: 'lot_items',
  listings: 'listings',
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains(STORES.catalog)) {
        const s = db.createObjectStore(STORES.catalog, { keyPath: 'id' });
        // Enforces card_catalog_identity_uniq. `unique` means a duplicate
        // printing fails the write rather than creating a second entry.
        s.createIndex('identity', 'identity_key', { unique: true });
      }
      if (!db.objectStoreNames.contains(STORES.identifiers)) {
        const s = db.createObjectStore(STORES.identifiers, { keyPath: 'id' });
        s.createIndex('card_provider', ['catalog_card_id', 'provider'], { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.items)) {
        const s = db.createObjectStore(STORES.items, { keyPath: 'id' });
        s.createIndex('status', 'status', { unique: false });
        // Mirrors inventory_items_cert_uniq. Sparse by nature: records with
        // no cert_key are simply absent from the index, so many raw singles
        // coexist happily.
        s.createIndex('cert_key', 'cert_key', { unique: true });
      }
      if (!db.objectStoreNames.contains(STORES.images)) {
        const s = db.createObjectStore(STORES.images, { keyPath: 'id' });
        s.createIndex('item', 'inventory_item_id', { unique: false });
        s.createIndex('path', 'storage_path', { unique: true });
      }
      if (!db.objectStoreNames.contains(STORES.photos)) {
        db.createObjectStore(STORES.photos, { keyPath: 'path' });
      }
      if (!db.objectStoreNames.contains(STORES.observations)) {
        const s = db.createObjectStore(STORES.observations, { keyPath: 'id' });
        s.createIndex('item', 'inventory_item_id', { unique: false });
        s.createIndex('card', 'catalog_card_id', { unique: false });
        s.createIndex('dedupe', 'dedupe_key', { unique: true });
      }
      if (!db.objectStoreNames.contains(STORES.movements)) {
        const s = db.createObjectStore(STORES.movements, { keyPath: 'id' });
        s.createIndex('item', 'inventory_item_id', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.settings)) {
        db.createObjectStore(STORES.settings, { keyPath: 'user_id' });
      }

      // --- v2 ---
      // Guarded by contains() rather than by oldVersion, so a database at any
      // earlier version upgrades correctly and existing data is untouched.
      if (!db.objectStoreNames.contains(STORES.sales)) {
        const s = db.createObjectStore(STORES.sales, { keyPath: 'id' });
        s.createIndex('sold_at', 'sold_at', { unique: false });
        s.createIndex('channel', 'channel', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.saleItems)) {
        const s = db.createObjectStore(STORES.saleItems, { keyPath: 'id' });
        s.createIndex('sale', 'sale_id', { unique: false });
        s.createIndex('item', 'inventory_item_id', { unique: false });
        // Mirrors sale_items_unique_object_once. The key is only present on
        // lines selling a unique object (a graded slab), so the index is
        // sparse and fungible stock can be sold repeatedly.
        s.createIndex('unique_object', 'unique_object_key', { unique: true });
      }
      if (!db.objectStoreNames.contains(STORES.expenses)) {
        const s = db.createObjectStore(STORES.expenses, { keyPath: 'id' });
        s.createIndex('incurred_on', 'incurred_on', { unique: false });
      }

      // --- v3 ---
      if (!db.objectStoreNames.contains(STORES.lots)) {
        const s = db.createObjectStore(STORES.lots, { keyPath: 'id' });
        s.createIndex('status', 'status', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.lotItems)) {
        const s = db.createObjectStore(STORES.lotItems, { keyPath: 'id' });
        s.createIndex('lot', 'lot_id', { unique: false });
        s.createIndex('item', 'inventory_item_id', { unique: false });
        // Mirrors inventory_lot_items_uniq: one line per item per lot.
        s.createIndex('lot_item', ['lot_id', 'inventory_item_id'], { unique: true });
      }

      // --- v4 ---
      if (!db.objectStoreNames.contains(STORES.listings)) {
        const s = db.createObjectStore(STORES.listings, { keyPath: 'id' });
        s.createIndex('item', 'inventory_item_id', { unique: false });
        s.createIndex('marketplace', 'marketplace', { unique: false });
        s.createIndex('status', 'status', { unique: false });
        // Mirrors marketplace_listings_item_uniq: one listing per item per
        // marketplace, so regenerating replaces rather than duplicates.
        s.createIndex('item_marketplace', ['inventory_item_id', 'marketplace'], {
          unique: true,
        });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open the local database.'));
    req.onblocked = () =>
      reject(new Error('Another tab is holding the database open. Close it and reload.'));
  });

  // Clear the cache on failure so a later call can retry rather than being
  // permanently stuck behind one rejected promise.
  dbPromise = opening.catch((e: unknown) => {
    dbPromise = null;
    throw e;
  });

  return dbPromise;
}

function run<T>(
  stores: StoreName[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T> | T
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(stores, mode);
        let result: T;
        let settled = false;

        // Capture the FAILING REQUEST's error, not the transaction's.
        //
        // An error event bubbles from the request up to the transaction, and
        // the transaction's handler runs synchronously while the promise
        // rejection from `wrap` is only a microtask. The transaction
        // therefore settles first, and `tx.error` is frequently null -- which
        // loses the DOMException name ("ConstraintError") that callers need
        // to tell a duplicate key apart from a real failure.
        let firstError: DOMException | null = null;
        tx.addEventListener('error', (event) => {
          const target = event.target as IDBRequest | null;
          if (!firstError) {
            firstError = (target && 'error' in target ? target.error : null) ?? tx.error;
          }
        });

        const failure = () =>
          firstError ?? tx.error ?? new Error('The write was rolled back.');

        tx.oncomplete = () => { if (!settled) { settled = true; resolve(result); } };
        tx.onerror = () => { if (!settled) { settled = true; reject(failure()); } };
        tx.onabort = () => { if (!settled) { settled = true; reject(failure()); } };

        Promise.resolve(fn(tx))
          .then((r) => { result = r; })
          .catch((e) => {
            settled = true;
            try { tx.abort(); } catch { /* already finishing */ }
            reject(e);
          });
      })
  );
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const idb = {
  run,
  wrap,

  get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
    return run([store], 'readonly', (tx) => wrap<T>(tx.objectStore(store).get(key)));
  },

  getAll<T>(store: StoreName): Promise<T[]> {
    return run([store], 'readonly', (tx) => wrap<T[]>(tx.objectStore(store).getAll()));
  },

  getAllByIndex<T>(store: StoreName, index: string, value: IDBValidKey): Promise<T[]> {
    return run([store], 'readonly', (tx) =>
      wrap<T[]>(tx.objectStore(store).index(index).getAll(value))
    );
  },

  put<T>(store: StoreName, value: T): Promise<void> {
    return run([store], 'readwrite', async (tx) => {
      await wrap(tx.objectStore(store).put(value));
    });
  },

  putMany<T>(store: StoreName, values: T[]): Promise<void> {
    if (values.length === 0) return Promise.resolve();
    return run([store], 'readwrite', async (tx) => {
      const os = tx.objectStore(store);
      for (const v of values) await wrap(os.put(v));
    });
  },

  delete(store: StoreName, key: IDBValidKey): Promise<void> {
    return run([store], 'readwrite', async (tx) => {
      await wrap(tx.objectStore(store).delete(key));
    });
  },
};

/** True when IndexedDB is usable (it is absent in some private modes). */
export function idbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

/** How much space the browser has granted and how much is used. */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const e = await navigator.storage.estimate();
  return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
}

/**
 * Ask the browser to make storage persistent.
 *
 * Without this, a browser under disk pressure may evict the whole database
 * without warning -- which for this app means losing the inventory. Chrome
 * generally grants it silently for installed or frequently-used sites.
 */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted?.()) return true;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
