import type { PathResult, SimulationParityReport } from './types';
import type { SolvedSpendProfile } from './simulation-worker-types';

const DB_NAME = 'retirement-sim-cache';
const DB_VERSION = 1;
const STORE_NAME = 'simulation-result';
const RECORD_KEY = 'latest';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// Bump when the cached payload shape changes so older entries are ignored.
const CACHE_SCHEMA_VERSION = 2;

interface CachedSimulationResult {
  schemaVersion?: number;
  fingerprint: string;
  computedAtIso: string;
  pathResults: PathResult[];
  parityReport: SimulationParityReport;
  solvedSpendProfile?: SolvedSpendProfile | null;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveSimulationResultToCache(
  fingerprint: string,
  pathResults: PathResult[],
  parityReport: SimulationParityReport,
  solvedSpendProfile: SolvedSpendProfile | null = null,
): Promise<void> {
  try {
    const db = await openDb();
    const entry: CachedSimulationResult = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      fingerprint,
      computedAtIso: new Date().toISOString(),
      pathResults,
      parityReport,
      solvedSpendProfile,
    };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(entry, RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    console.log('[sim-cache] saved to IndexedDB');
  } catch (e) {
    console.warn('[sim-cache] save failed:', e);
  }
}

export async function loadSimulationResultFromCache(
  fingerprint: string,
): Promise<{
  pathResults: PathResult[];
  parityReport: SimulationParityReport;
  solvedSpendProfile: SolvedSpendProfile | null;
} | null> {
  try {
    const db = await openDb();
    const entry = await new Promise<CachedSimulationResult | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(RECORD_KEY);
      req.onsuccess = () => resolve(req.result as CachedSimulationResult | undefined);
      req.onerror = () => reject(req.error);
    });
    if (!entry) {
      console.log('[sim-cache] miss: nothing saved');
      return null;
    }
    if ((entry.schemaVersion ?? 1) !== CACHE_SCHEMA_VERSION) {
      console.log(
        '[sim-cache] miss: schema version mismatch',
        entry.schemaVersion ?? 1,
        '!=',
        CACHE_SCHEMA_VERSION,
      );
      return null;
    }
    if (entry.fingerprint !== fingerprint) {
      console.log('[sim-cache] miss: fingerprint mismatch');
      return null;
    }
    const ageMs = Date.now() - new Date(entry.computedAtIso).getTime();
    if (ageMs > MAX_AGE_MS) {
      console.log('[sim-cache] miss: expired', (ageMs / 86400000).toFixed(1), 'days old');
      return null;
    }
    console.log('[sim-cache] hit,', (ageMs / 60000).toFixed(0), 'min old');
    return {
      pathResults: entry.pathResults,
      parityReport: entry.parityReport,
      solvedSpendProfile: entry.solvedSpendProfile ?? null,
    };
  } catch (e) {
    console.warn('[sim-cache] load failed:', e);
    return null;
  }
}
