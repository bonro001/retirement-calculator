const DB_NAME = 'retirement-time-as-safety-cache';
const DB_VERSION = 1;
const STORE_NAME = 'time-as-safety-result';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 6;

interface CachedTimeAsSafetyResult<TPoint> {
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

export async function saveTimeAsSafetyToCache<TPoint>(
  fingerprint: string,
  points: TPoint[],
): Promise<void> {
  try {
    const db = await openDb();
    const entry: CachedTimeAsSafetyResult<TPoint> = {
      fingerprint,
      computedAtIso: new Date().toISOString(),
      points,
    };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(entry, fingerprint);
      const allReq = store.getAllKeys();
      allReq.onsuccess = () => {
        const keys = allReq.result as IDBValidKey[];
        if (keys.length <= MAX_ENTRIES) return;
        const rowsReq = store.getAll();
        rowsReq.onsuccess = () => {
          const rows = rowsReq.result as CachedTimeAsSafetyResult<TPoint>[];
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
    console.log('[time-as-safety-cache] saved to IndexedDB');
  } catch (e) {
    console.warn('[time-as-safety-cache] save failed:', e);
  }
}

export async function loadTimeAsSafetyFromCache<TPoint>(
  fingerprint: string,
): Promise<TPoint[] | null> {
  try {
    const db = await openDb();
    const entry = await new Promise<CachedTimeAsSafetyResult<TPoint> | undefined>(
      (resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(fingerprint);
        req.onsuccess = () => resolve(req.result as CachedTimeAsSafetyResult<TPoint> | undefined);
        req.onerror = () => reject(req.error);
      },
    );
    if (!entry) {
      console.log('[time-as-safety-cache] miss: no entry for fingerprint');
      return null;
    }
    if (entry.fingerprint !== fingerprint) {
      console.log('[time-as-safety-cache] miss: fingerprint mismatch');
      return null;
    }
    const ageMs = Date.now() - new Date(entry.computedAtIso).getTime();
    if (ageMs > MAX_AGE_MS) {
      console.log('[time-as-safety-cache] miss: expired');
      return null;
    }
    console.log('[time-as-safety-cache] hit,', (ageMs / 60000).toFixed(0), 'min old');
    return entry.points;
  } catch (e) {
    console.warn('[time-as-safety-cache] load failed:', e);
    return null;
  }
}
