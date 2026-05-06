/**
 * `useRecommendedPath` — run the engine against the seed-with-recommended-
 * policy-applied to produce the year-by-year `PathResult` the Cockpit
 * needs for its trajectory chart, per-year tiles, and detail rows.
 *
 * The mining corpus stores aggregate metrics (cemetery percentiles,
 * solvency, legacy attainment) but NOT full year-by-year trajectories —
 * those would balloon the corpus from ~50KB/record to ~50MB/record.
 * So the cockpit needs a single fresh engine run on the recommended
 * policy to populate the per-year visualizations.
 *
 * Cost: ONE Monte Carlo pass with 5000 trials, ~3-5s on the main thread
 * (vs the legacy bisection chain's ~30s). Cached by
 * (planFingerprint, recommendedPolicyId) in localStorage so refresh
 * hydrates instantly. Replaces `usePlanOptimization` from CockpitScreen.
 */

import { useEffect, useState } from 'react';
import type { MarketAssumptions, PathResult, SeedData } from './types';
import type { PolicyEvaluation } from './policy-miner-types';
import { evaluatePolicyFullTrace } from './policy-miner-eval';

const RECOMMENDED_PATH_LS_KEY = 'retirement-calc:recommended-path-cache:v1';

interface CachedEntry {
  key: string;
  forwardLooking: PathResult | null;
  historical: PathResult | null;
  cachedAtIso: string;
}

function readCache(): CachedEntry | null {
  try {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage?.getItem(RECOMMENDED_PATH_LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedEntry;
    if (!parsed?.key) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(entry: CachedEntry | null): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (!entry) {
      window.localStorage.removeItem(RECOMMENDED_PATH_LS_KEY);
      return;
    }
    window.localStorage.setItem(RECOMMENDED_PATH_LS_KEY, JSON.stringify(entry));
  } catch {
    // localStorage quota / private browsing — non-fatal.
  }
}

function structuredCloneSafe<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface RecommendedPath {
  /** Forward-looking parametric path. Null when the corpus has no
   *  recommendation yet, or while the engine is still running. */
  forwardLooking: PathResult | null;
  /** Historical-bootstrap path for the dual-view comparison. */
  historical: PathResult | null;
  /** True while the engine is computing. UI uses this for loading
   *  shimmer / progress copy. */
  computing: boolean;
}

export interface RecommendedPathOptions {
  /**
   * Run the expensive full-trace projection when no cache exists. Keep this
   * opt-in: the full trace is synchronous engine work and can freeze the tab
   * long enough that Cockpit navigation appears dead.
   */
  autoCompute?: boolean;
}

/**
 * Run the engine against the recommended policy and return the
 * resulting forward-looking + historical paths. Cached by the
 * (plan + policy) pair so navigation in/out of the cockpit is free
 * after the first compute.
 */
export function useRecommendedPath(
  data: SeedData | null,
  assumptions: MarketAssumptions | null,
  recommendation: PolicyEvaluation | null,
  selectedStressors: string[],
  selectedResponses: string[],
  options: RecommendedPathOptions = {},
): RecommendedPath {
  const autoCompute = options.autoCompute ?? true;
  const cacheKey =
    data && assumptions && recommendation
      ? JSON.stringify({
          policyId: recommendation.id,
          plan: {
            spending: data.spending,
            income: {
              salaryAnnual: data.income?.salaryAnnual,
              salaryEndDate: data.income?.salaryEndDate,
              windfalls: data.income?.windfalls,
            },
            accounts: {
              pretax: data.accounts?.pretax?.balance,
              roth: data.accounts?.roth?.balance,
              taxable: data.accounts?.taxable?.balance,
              cash: data.accounts?.cash?.balance,
            },
            asm: {
              equityMean: assumptions.equityMean,
              inflation: assumptions.inflation,
              version: assumptions.assumptionsVersion,
              runs: assumptions.simulationRuns,
            },
            stress: selectedStressors,
            response: selectedResponses,
          },
        })
      : null;

  const [cached, setCached] = useState<CachedEntry | null>(() => {
    if (!cacheKey) return null;
    const c = readCache();
    return c && c.key === cacheKey ? c : null;
  });
  const [computing, setComputing] = useState<boolean>(false);

  useEffect(() => {
    if (!data || !assumptions || !recommendation || !cacheKey) {
      setCached(null);
      return;
    }
    if (cached?.key === cacheKey) return;
    if (!autoCompute) {
      setComputing(false);
      return;
    }

    let cancelled = false;
    setComputing(true);
    // Defer the synchronous engine work to the next macrotask so React
    // can paint the "computing..." state first. Without this the
    // useEffect blocks the main thread before any UI shows.
    const handle = setTimeout(() => {
      try {
        const buildOne = (useHistoricalBootstrap: boolean): PathResult | null => {
          try {
            return evaluatePolicyFullTrace(
              recommendation.policy,
              data,
              assumptions,
              structuredCloneSafe,
              {
                selectedStressors,
                selectedResponses,
                useHistoricalBootstrap,
              },
            );
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn('[useRecommendedPath] build failed:', err);
            return null;
          }
        };

        const forwardLooking = buildOne(false);
        const historical = buildOne(true);

        if (cancelled) return;
        const entry: CachedEntry = {
          key: cacheKey,
          forwardLooking,
          historical,
          cachedAtIso: new Date().toISOString(),
        };
        setCached(entry);
        writeCache(entry);
      } finally {
        if (!cancelled) setComputing(false);
      }
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(handle);
      setComputing(false);
    };
  }, [
    autoCompute,
    cacheKey,
    cached?.key,
    data,
    assumptions,
    recommendation,
    selectedStressors,
    selectedResponses,
  ]);

  if (!cached || cached.key !== cacheKey) {
    return { forwardLooking: null, historical: null, computing };
  }
  return {
    forwardLooking: cached.forwardLooking,
    historical: cached.historical,
    computing,
  };
}
