/**
 * Baseline-path cache shared by the Cockpit and Mining screens.
 *
 * Both screens need a single 5000-trial Monte Carlo over the household's
 * current plan to drive their headline tiles. Without persistence, every
 * navigation between them (or any page refresh) ran the engine again on
 * the main thread for ~3-5s per pass — and the Cockpit runs it twice
 * (forward-looking + historical bootstrap), pushing past Chrome's 5s
 * Page-Unresponsive threshold.
 *
 * This module gives them a single in-memory + localStorage cache keyed
 * on a cheap fingerprint of the dials that materially change the path.
 * One compute populates both screens; refreshes hit localStorage and
 * skip the engine entirely.
 *
 * Single-entry by design — the household sees one baseline at a time
 * and we don't want stale entries piling up in storage. Bump the LS
 * key suffix when the PathResult shape changes.
 */
import { buildPathResults } from './utils';
import type { MarketAssumptions, PathResult, SeedData } from './types';

export interface BaselinePathBoth {
  forwardLooking: PathResult | null;
  historical: PathResult | null;
}

const BASELINE_PATH_LS_KEY = 'retirement-calc:baseline-path-cache:v1';

let cache: { key: string; paths: BaselinePathBoth } | null = (() => {
  try {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage?.getItem(BASELINE_PATH_LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      key: string;
      paths: BaselinePathBoth;
    };
    if (!parsed?.key || !parsed?.paths) return null;
    return parsed;
  } catch {
    return null;
  }
})();

function persist(entry: { key: string; paths: BaselinePathBoth } | null): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (!entry) {
      window.localStorage.removeItem(BASELINE_PATH_LS_KEY);
      return;
    }
    window.localStorage.setItem(BASELINE_PATH_LS_KEY, JSON.stringify(entry));
  } catch {
    // Quota exceeded / private browsing / disabled storage — non-fatal.
  }
}

function fingerprint(
  data: SeedData,
  assumptions: MarketAssumptions,
  stressors: string[],
  responses: string[],
): string {
  return JSON.stringify({
    spending: data.spending,
    income: {
      salaryAnnual: data.income?.salaryAnnual,
      salaryEndDate: data.income?.salaryEndDate,
      socialSecurity: data.income?.socialSecurity,
      windfalls: data.income?.windfalls,
    },
    accounts: {
      pretax: data.accounts?.pretax?.balance,
      roth: data.accounts?.roth?.balance,
      taxable: data.accounts?.taxable?.balance,
      cash: data.accounts?.cash?.balance,
    },
    rules: {
      rothPolicy: data.rules?.rothConversionPolicy,
      ltc: data.rules?.ltcAssumptions,
    },
    asm: {
      simulationRuns: assumptions.simulationRuns,
      equityMean: assumptions.equityMean,
      inflation: assumptions.inflation,
      version: assumptions.assumptionsVersion,
    },
    s: stressors,
    r: responses,
  });
}

export function getCachedBaselinePathBoth(
  data: SeedData,
  assumptions: MarketAssumptions,
  stressors: string[],
  responses: string[],
): BaselinePathBoth {
  const key = fingerprint(data, assumptions, stressors, responses);
  if (cache && cache.key === key) return cache.paths;
  const safeBuild = (asm: MarketAssumptions): PathResult | null => {
    try {
      const paths = buildPathResults(data, asm, stressors, responses, {
        pathMode: 'selected_only',
      });
      return paths[0] ?? null;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[baseline-path-cache] build failed:', err);
      return null;
    }
  };
  const forwardLooking = safeBuild(assumptions);
  const historical = safeBuild({ ...assumptions, useHistoricalBootstrap: true });
  const paths: BaselinePathBoth = { forwardLooking, historical };
  cache = { key, paths };
  persist(cache);
  return paths;
}

/**
 * Forward-looking-only convenience for callers that don't need the
 * historical bootstrap. Hits the same cache, so the Mining screen and
 * Cockpit share one compute.
 */
export function getCachedBaselinePath(
  data: SeedData,
  assumptions: MarketAssumptions,
  stressors: string[],
  responses: string[],
): PathResult | null {
  return getCachedBaselinePathBoth(data, assumptions, stressors, responses)
    .forwardLooking;
}
