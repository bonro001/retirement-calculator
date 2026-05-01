/**
 * Baseline-path cache shared by the Cockpit and Mining screens.
 *
 * Both screens can use a single cached Monte Carlo over the household's
 * current plan to drive their headline tiles. Cold-building that result
 * on the main thread is not safe: every page refresh used to run two
 * full engine passes before navigation could respond, which produced
 * browser "wait" prompts on slower WebKit/Chrome sessions.
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
  return { forwardLooking: null, historical: null };
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
