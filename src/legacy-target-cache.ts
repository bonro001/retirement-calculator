/**
 * Persistence for the household's North Star (`data.goals.legacyTargetTodayDollars`).
 *
 * Lives in `localStorage` rather than `sessionStorage` because the
 * household sets this value once and expects it to survive across browser
 * sessions — the previous behavior (in-memory only) silently dropped it
 * on every refresh, which felt broken.
 *
 * Schema is intentionally trivial: a single number-or-null. We don't
 * version this because there's no migration risk for a scalar value.
 * If the stored payload is corrupt we treat it as "no target set" and
 * the household re-enters; no failure modes worth modeling.
 */

const CACHE_KEY = 'retirement-plan:legacy-target-v1';

export function saveLegacyTargetToCache(value: number | undefined): void {
  try {
    if (value === undefined || value === null || Number.isNaN(value)) {
      localStorage.removeItem(CACHE_KEY);
      return;
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(value));
  } catch {
    // QuotaExceededError or storage disabled — silently ignore. The
    // value lives in memory for the session either way.
  }
}

export function loadLegacyTargetFromCache(): number | undefined {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < 0) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}
