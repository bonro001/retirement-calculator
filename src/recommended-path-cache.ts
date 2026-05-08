import type { MarketAssumptions, PathResult, SeedData } from './types';
import type { PolicyEvaluation } from './policy-miner-types';
import { evaluatePolicyFullTrace } from './policy-miner-eval';

export const RECOMMENDED_PATH_LS_KEY =
  'retirement-calc:recommended-path-cache:v1';

export interface RecommendedPathCacheEntry {
  key: string;
  forwardLooking: PathResult | null;
  historical: PathResult | null;
  cachedAtIso: string;
}

export interface RecommendedPathCacheInput {
  data: SeedData;
  assumptions: MarketAssumptions;
  recommendation: PolicyEvaluation;
  selectedStressors: string[];
  selectedResponses: string[];
}

export function buildRecommendedPathCacheKey({
  data,
  assumptions,
  recommendation,
  selectedStressors,
  selectedResponses,
}: RecommendedPathCacheInput): string {
  return JSON.stringify({
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
  });
}

export function readRecommendedPathCache(): RecommendedPathCacheEntry | null {
  try {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage?.getItem(RECOMMENDED_PATH_LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RecommendedPathCacheEntry;
    if (!parsed?.key) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeRecommendedPathCache(
  entry: RecommendedPathCacheEntry | null,
): void {
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

export function computeRecommendedPathCacheEntry(
  input: RecommendedPathCacheInput,
): RecommendedPathCacheEntry {
  const buildOne = (useHistoricalBootstrap: boolean): PathResult | null => {
    try {
      return evaluatePolicyFullTrace(
        input.recommendation.policy,
        input.data,
        input.assumptions,
        structuredCloneSafe,
        {
          selectedStressors: input.selectedStressors,
          selectedResponses: input.selectedResponses,
          useHistoricalBootstrap,
        },
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[recommended-path-cache] build failed:', err);
      return null;
    }
  };

  return {
    key: buildRecommendedPathCacheKey(input),
    forwardLooking: buildOne(false),
    historical: buildOne(true),
    cachedAtIso: new Date().toISOString(),
  };
}

export function primeRecommendedPathCache(
  input: RecommendedPathCacheInput,
): RecommendedPathCacheEntry {
  const entry = computeRecommendedPathCacheEntry(input);
  writeRecommendedPathCache(entry);
  return entry;
}
