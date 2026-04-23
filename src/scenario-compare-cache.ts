const DB_NAME = 'retirement-scenario-compare-cache';
const DB_VERSION = 1;
const STORE_NAME = 'scenario-compare-result';
const MAX_ENTRIES = 6;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface CachedScenarioCompareResult<TReport> {
  fingerprint: string;
  computedAtIso: string;
  report: TReport;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveScenarioCompareToCache<TReport>(
  fingerprint: string,
  report: TReport,
): Promise<void> {
  try {
    const db = await openDb();
    const entry: CachedScenarioCompareResult<TReport> = {
      fingerprint,
      computedAtIso: new Date().toISOString(),
      report,
    };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(entry, fingerprint);
      const keysReq = store.getAllKeys();
      keysReq.onsuccess = () => {
        const keys = keysReq.result as string[];
        if (keys.length > MAX_ENTRIES) {
          const getAllReq = store.getAll();
          getAllReq.onsuccess = () => {
            const all = getAllReq.result as CachedScenarioCompareResult<TReport>[];
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
    console.log('[scenario-compare-cache] saved to IndexedDB');
  } catch (e) {
    console.warn('[scenario-compare-cache] save failed:', e);
  }
}

export async function loadScenarioCompareFromCache<TReport>(
  fingerprint: string,
): Promise<TReport | null> {
  try {
    const db = await openDb();
    const entry = await new Promise<CachedScenarioCompareResult<TReport> | undefined>(
      (resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(fingerprint);
        req.onsuccess = () => resolve(req.result as CachedScenarioCompareResult<TReport> | undefined);
        req.onerror = () => reject(req.error);
      },
    );
    if (!entry) {
      console.log('[scenario-compare-cache] miss');
      return null;
    }
    const ageMs = Date.now() - new Date(entry.computedAtIso).getTime();
    if (ageMs > MAX_AGE_MS) {
      console.log('[scenario-compare-cache] expired');
      return null;
    }
    console.log('[scenario-compare-cache] hit,', (ageMs / 60000).toFixed(0), 'min old');
    return entry.report;
  } catch (e) {
    console.warn('[scenario-compare-cache] load failed:', e);
    return null;
  }
}
