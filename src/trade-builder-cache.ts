const DB_NAME = 'retirement-trade-builder-cache';
const DB_VERSION = 1;
const STORE_NAME = 'trade-builder-result';
const MAX_ENTRIES = 8;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface CachedTradeBuilderResult<TValue> {
  fingerprint: string;
  computedAtIso: string;
  value: TValue;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveTradeBuilderToCache<TValue>(
  fingerprint: string,
  value: TValue,
): Promise<void> {
  try {
    const db = await openDb();
    const entry: CachedTradeBuilderResult<TValue> = {
      fingerprint,
      computedAtIso: new Date().toISOString(),
      value,
    };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(entry, fingerprint);
      // prune oldest if over cap
      const keysReq = store.getAllKeys();
      keysReq.onsuccess = () => {
        const keys = keysReq.result as string[];
        if (keys.length > MAX_ENTRIES) {
          const getAllReq = store.getAll();
          getAllReq.onsuccess = () => {
            const all = getAllReq.result as CachedTradeBuilderResult<TValue>[];
            const sorted = all
              .map((e, i) => ({ key: keys[i], computedAtIso: e.computedAtIso }))
              .sort((a, b) => a.computedAtIso.localeCompare(b.computedAtIso));
            const toRemove = sorted.slice(0, sorted.length - MAX_ENTRIES);
            for (const item of toRemove) {
              store.delete(item.key);
            }
          };
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    console.log('[trade-builder-cache] saved to IndexedDB');
  } catch (e) {
    console.warn('[trade-builder-cache] save failed:', e);
  }
}

export async function loadTradeBuilderFromCache<TValue>(
  fingerprint: string,
): Promise<TValue | null> {
  try {
    const db = await openDb();
    const entry = await new Promise<CachedTradeBuilderResult<TValue> | undefined>(
      (resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(fingerprint);
        req.onsuccess = () => resolve(req.result as CachedTradeBuilderResult<TValue> | undefined);
        req.onerror = () => reject(req.error);
      },
    );
    if (!entry) {
      console.log('[trade-builder-cache] miss');
      return null;
    }
    const ageMs = Date.now() - new Date(entry.computedAtIso).getTime();
    if (ageMs > MAX_AGE_MS) {
      console.log('[trade-builder-cache] expired');
      return null;
    }
    console.log('[trade-builder-cache] hit,', (ageMs / 60000).toFixed(0), 'min old');
    return entry.value;
  } catch (e) {
    console.warn('[trade-builder-cache] load failed:', e);
    return null;
  }
}
