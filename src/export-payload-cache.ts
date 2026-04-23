import type { PlanningStateExport } from './planning-export';

const STORAGE_KEY = 'retirement-export-payload-v1';
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CachedExportEntry {
  dataFingerprint: string;
  exportMode: string;
  cacheVersion: string;
  computedAtIso: string;
  payload: PlanningStateExport;
}

export function saveExportPayloadToCache(
  dataFingerprint: string,
  exportMode: string,
  cacheVersion: string,
  payload: PlanningStateExport,
): void {
  try {
    const entry: CachedExportEntry = {
      dataFingerprint,
      exportMode,
      cacheVersion,
      computedAtIso: new Date().toISOString(),
      payload,
    };
    const serialized = JSON.stringify(entry);
    console.log(`[export-cache] saving ${(serialized.length / 1024).toFixed(0)}KB to localStorage`);
    localStorage.setItem(STORAGE_KEY, serialized);
    console.log('[export-cache] save succeeded');
  } catch (e) {
    console.warn('[export-cache] save failed:', e);
  }
}

export function loadExportPayloadFromCache(
  dataFingerprint: string,
  exportMode: string,
  cacheVersion: string,
): PlanningStateExport | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      console.log('[export-cache] miss: nothing in localStorage');
      return null;
    }
    const entry = JSON.parse(raw) as CachedExportEntry;
    if (entry.cacheVersion !== cacheVersion) {
      console.log('[export-cache] miss: version mismatch', entry.cacheVersion, '!=', cacheVersion);
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
    console.log('[export-cache] hit:', (raw.length / 1024).toFixed(0), 'KB,', (ageMs / 60000).toFixed(0), 'min old');
    return entry.payload;
  } catch (e) {
    console.warn('[export-cache] load failed:', e);
    return null;
  }
}

export function clearExportPayloadCache(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
