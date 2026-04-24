import type { PlanningStateExport, PlanningStateSummary } from './planning-export';

const DB_NAME = 'retirement-export-payload-cache';
const DB_VERSION = 1;
const STORE_NAME = 'export-payload';
const LEGACY_STORAGE_KEY = 'retirement-export-payload-v1';
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
// Keep a small number of fingerprint-keyed entries to avoid unbounded growth.
// The payload is ~900KB on this user's machine, so even 4 entries is ~3.5MB.
const MAX_ENTRIES = 4;

interface CachedExportEntry {
  dataFingerprint: string;
  exportMode: string;
  cacheVersion: string;
  computedAtIso: string;
  payload: PlanningStateExport;
}

function entryKey(
  dataFingerprint: string,
  exportMode: string,
  cacheVersion: string,
): string {
  return `${cacheVersion}::${exportMode}::${dataFingerprint}`;
}

function summaryKey(
  dataFingerprint: string,
  exportMode: string,
  cacheVersion: string,
): string {
  return `summary::${cacheVersion}::${exportMode}::${dataFingerprint}`;
}

interface CachedSummaryEntry {
  dataFingerprint: string;
  exportMode: string;
  cacheVersion: string;
  computedAtIso: string;
  summary: PlanningStateSummary;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveExportPayloadToCache(
  dataFingerprint: string,
  exportMode: string,
  cacheVersion: string,
  payload: PlanningStateExport,
): Promise<void> {
  try {
    const entry: CachedExportEntry = {
      dataFingerprint,
      exportMode,
      cacheVersion,
      computedAtIso: new Date().toISOString(),
      payload,
    };
    const key = entryKey(dataFingerprint, exportMode, cacheVersion);
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(entry, key);
      // Evict oldest if we're over the cap.
      const keysReq = store.getAllKeys();
      keysReq.onsuccess = () => {
        const keys = keysReq.result as IDBValidKey[];
        if (keys.length <= MAX_ENTRIES) return;
        const rowsReq = store.getAll();
        rowsReq.onsuccess = () => {
          const rows = rowsReq.result as CachedExportEntry[];
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
    console.log('[export-cache] saved to IndexedDB');
  } catch (e) {
    console.warn('[export-cache] save failed:', e);
  }
}

export async function loadExportPayloadFromCache(
  dataFingerprint: string,
  exportMode: string,
  cacheVersion: string,
): Promise<PlanningStateExport | null> {
  try {
    const key = entryKey(dataFingerprint, exportMode, cacheVersion);
    const db = await openDb();
    const entry = await new Promise<CachedExportEntry | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result as CachedExportEntry | undefined);
      req.onerror = () => reject(req.error);
    });
    if (!entry) {
      console.log('[export-cache] miss: no entry for fingerprint');
      return null;
    }
    if (entry.cacheVersion !== cacheVersion) {
      console.log('[export-cache] miss: version mismatch');
      return null;
    }
    if (entry.exportMode !== exportMode) {
      console.log('[export-cache] miss: mode mismatch');
      return null;
    }
    if (entry.dataFingerprint !== dataFingerprint) {
      console.log('[export-cache] miss: fingerprint mismatch');
      return null;
    }
    const ageMs = Date.now() - new Date(entry.computedAtIso).getTime();
    if (ageMs > MAX_AGE_MS) {
      console.log('[export-cache] miss: expired', (ageMs / 3600000).toFixed(1), 'h old');
      return null;
    }
    console.log('[export-cache] hit:', (ageMs / 60000).toFixed(0), 'min old');
    return entry.payload;
  } catch (e) {
    console.warn('[export-cache] load failed:', e);
    return null;
  }
}

export async function saveExportSummaryToCache(
  dataFingerprint: string,
  exportMode: string,
  cacheVersion: string,
  summary: PlanningStateSummary,
): Promise<void> {
  try {
    const entry: CachedSummaryEntry = {
      dataFingerprint,
      exportMode,
      cacheVersion,
      computedAtIso: new Date().toISOString(),
      summary,
    };
    const key = summaryKey(dataFingerprint, exportMode, cacheVersion);
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(entry, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn('[export-cache] summary save failed:', e);
  }
}

export async function loadExportSummaryFromCache(
  dataFingerprint: string,
  exportMode: string,
  cacheVersion: string,
): Promise<PlanningStateSummary | null> {
  try {
    const key = summaryKey(dataFingerprint, exportMode, cacheVersion);
    const db = await openDb();
    const entry = await new Promise<CachedSummaryEntry | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result as CachedSummaryEntry | undefined);
      req.onerror = () => reject(req.error);
    });
    if (!entry) return null;
    if (
      entry.cacheVersion !== cacheVersion ||
      entry.exportMode !== exportMode ||
      entry.dataFingerprint !== dataFingerprint
    ) {
      return null;
    }
    const ageMs = Date.now() - new Date(entry.computedAtIso).getTime();
    if (ageMs > MAX_AGE_MS) return null;
    console.log('[export-cache] summary hit:', (ageMs / 60000).toFixed(0), 'min old');
    return entry.summary;
  } catch (e) {
    console.warn('[export-cache] summary load failed:', e);
    return null;
  }
}

export async function clearExportPayloadCache(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // ignore
  }
  // Also wipe the legacy localStorage key so we don't re-surface stale data.
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // ignore
  }
}

// One-shot: clear the old localStorage blob on module load so users
// migrating from the sync-localStorage version reclaim the ~900KB.
try {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  }
} catch {
  // ignore (e.g. disabled storage)
}
