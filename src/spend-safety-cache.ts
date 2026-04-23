const DB_NAME = 'retirement-spend-safety-cache';
const DB_VERSION = 1;
const STORE_NAME = 'spend-safety-result';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Keep at most this many fingerprints resident to avoid unbounded growth.
const MAX_ENTRIES = 8;

interface CachedSpendSafetyResult<TPoint> {
  fingerprint: string;
  computedAtIso: string;
  points: TPoint[];
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveSpendSafetyToCache<TPoint>(
  fingerprint: string,
  points: TPoint[],
): Promise<void> {
  try {
    const db = await openDb();
    const entry: CachedSpendSafetyResult<TPoint> = {
      fingerprint,
      computedAtIso: new Date().toISOString(),
      points,
    };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      // Put this fingerprint's entry.
      store.put(entry, fingerprint);
      // Evict the oldest entries if we're over the cap.
      const allReq = store.getAllKeys();
      allReq.onsuccess = () => {
        const keys = allReq.result as IDBValidKey[];
        if (keys.length <= MAX_ENTRIES) return;
        // Fetch all entries to find oldest.
        const entriesReq = store.getAll();
        entriesReq.onsuccess = () => {
          const rows = entriesReq.result as CachedSpendSafetyResult<TPoint>[];
          const keyed = keys.map((k, i) => ({ key: k, entry: rows[i] }));
          keyed.sort(
            (a, b) =>
              new Date(a.entry.computedAtIso).getTime() -
              new Date(b.entry.computedAtIso).getTime(),
          );
          const toEvict = keyed.slice(0, keyed.length - MAX_ENTRIES);
          for (const row of toEvict) store.delete(row.key);
        };
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    console.log('[spend-safety-cache] saved to IndexedDB (fingerprint-keyed)');
  } catch (e) {
    console.warn('[spend-safety-cache] save failed:', e);
  }
}

export async function loadSpendSafetyFromCache<TPoint>(
  fingerprint: string,
): Promise<TPoint[] | null> {
  try {
    const db = await openDb();
    const entry = await new Promise<CachedSpendSafetyResult<TPoint> | undefined>(
      (resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(fingerprint);
        req.onsuccess = () => resolve(req.result as CachedSpendSafetyResult<TPoint> | undefined);
        req.onerror = () => reject(req.error);
      },
    );
    if (!entry) {
      console.log('[spend-safety-cache] miss: no entry for fingerprint');
      return null;
    }
    // Sanity: fingerprint is the key, but guard against corruption.
    if (entry.fingerprint !== fingerprint) {
      console.log('[spend-safety-cache] miss: fingerprint mismatch');
      return null;
    }
    const ageMs = Date.now() - new Date(entry.computedAtIso).getTime();
    if (ageMs > MAX_AGE_MS) {
      console.log('[spend-safety-cache] miss: expired', (ageMs / 86400000).toFixed(1), 'days old');
      return null;
    }
    console.log('[spend-safety-cache] hit,', (ageMs / 60000).toFixed(0), 'min old');
    return entry.points;
  } catch (e) {
    console.warn('[spend-safety-cache] load failed:', e);
    return null;
  }
}
