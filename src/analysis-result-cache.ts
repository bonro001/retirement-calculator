import type { PlanEvaluation } from './plan-evaluation';

const DB_NAME = 'retirement-analysis-cache';
const DB_VERSION = 1;
const STORE_NAME = 'analysis-result';
const RECORD_KEY = 'latest';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface CachedAnalysisResult {
  fingerprint: string;
  computedAtIso: string;
  evaluation: PlanEvaluation;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveAnalysisResultToCache(
  fingerprint: string,
  evaluation: PlanEvaluation,
): Promise<void> {
  try {
    const db = await openDb();
    const entry: CachedAnalysisResult = {
      fingerprint,
      computedAtIso: new Date().toISOString(),
      evaluation,
    };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(entry, RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    console.log('[analysis-cache] saved to IndexedDB');
  } catch (e) {
    console.warn('[analysis-cache] save failed:', e);
  }
}

export async function loadAnalysisResultFromCache(
  fingerprint: string,
): Promise<PlanEvaluation | null> {
  try {
    const db = await openDb();
    const entry = await new Promise<CachedAnalysisResult | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(RECORD_KEY);
      req.onsuccess = () => resolve(req.result as CachedAnalysisResult | undefined);
      req.onerror = () => reject(req.error);
    });
    if (!entry) {
      console.log('[analysis-cache] miss: nothing saved');
      return null;
    }
    if (entry.fingerprint !== fingerprint) {
      console.log('[analysis-cache] miss: fingerprint mismatch');
      return null;
    }
    const ageMs = Date.now() - new Date(entry.computedAtIso).getTime();
    if (ageMs > MAX_AGE_MS) {
      console.log('[analysis-cache] miss: expired', (ageMs / 86400000).toFixed(1), 'days old');
      return null;
    }
    console.log('[analysis-cache] hit,', (ageMs / 60000).toFixed(0), 'min old');
    return entry.evaluation;
  } catch (e) {
    console.warn('[analysis-cache] load failed:', e);
    return null;
  }
}
