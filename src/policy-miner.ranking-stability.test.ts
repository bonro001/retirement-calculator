/**
 * Policy mining ranking stability under varying trial count.
 *
 * Justifies (or blocks) trial-count reductions for `POLICY_MINING_TRIAL_COUNT`.
 * The engine itself is unchanged across trial counts; what changes is the
 * Monte Carlo standard error of every per-policy outcome metric. For
 * decision-quality, what matters isn't the absolute success-rate value
 * — it's whether the *ranking* of policies remains stable. If top-K
 * overlap and Spearman correlation hold up at lower N, we can lower N.
 *
 * If this test fails after lowering N: the noise floor crossed the
 * margin between top candidates. Either keep N where it was, or address
 * the variance differently (more diverse axes, dedupe near-equivalent
 * policies, etc.).
 */
import { describe, expect, it } from 'vitest';
import { evaluatePolicy } from './policy-miner-eval';
import { initialSeedData } from './data';
import type { MarketAssumptions, SeedData } from './types';
import type { Policy, PolicyEvaluation } from './policy-miner-types';

const cloneSeedData = (data: SeedData): SeedData =>
  JSON.parse(JSON.stringify(data)) as SeedData;

const BASE_ASSUMPTIONS: Omit<MarketAssumptions, 'simulationRuns'> = {
  equityMean: 0.074,
  equityVolatility: 0.16,
  internationalEquityMean: 0.074,
  internationalEquityVolatility: 0.18,
  bondMean: 0.038,
  bondVolatility: 0.07,
  cashMean: 0.02,
  cashVolatility: 0.01,
  inflation: 0.028,
  inflationVolatility: 0.01,
  irmaaThreshold: 200000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 18,
  guardrailCutPercent: 0.2,
  robPlanningEndAge: 90,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260504,
  assumptionsVersion: 'mining-stability-test',
};

function buildPolicyGrid(): Policy[] {
  // 4 × 3 × 2 = 24 policies — small enough for a reasonable test runtime
  // (~10-20s in TS), large enough that a top-10 cut is meaningful.
  const out: Policy[] = [];
  for (const spend of [80_000, 110_000, 140_000, 170_000]) {
    for (const ssAge of [62, 67, 70]) {
      for (const roth of [0, 80_000]) {
        out.push({
          annualSpendTodayDollars: spend,
          primarySocialSecurityClaimAge: ssAge,
          spouseSocialSecurityClaimAge: ssAge,
          rothConversionAnnualCeiling: roth,
        });
      }
    }
  }
  return out;
}

async function runMineAtTrials(
  policies: Policy[],
  trials: number,
): Promise<PolicyEvaluation[]> {
  // Sidesteps `runMiningSession`'s IndexedDB persistence (saveEvaluationsBatch,
  // saveMiningStats) which doesn't exist in a node test env. Same per-policy
  // engine path; we just don't write the corpus.
  const baseline = cloneSeedData(initialSeedData);
  const assumptions: MarketAssumptions = {
    ...BASE_ASSUMPTIONS,
    simulationRuns: trials,
  };
  const captured: PolicyEvaluation[] = [];
  for (const policy of policies) {
    const evaluation = await evaluatePolicy(
      policy,
      baseline,
      assumptions,
      'stability-test-fixed-fp',
      'stability-test-v1',
      'stability-test',
      cloneSeedData,
      1_000_000,
    );
    captured.push(evaluation);
  }
  return captured;
}

function rankByBequest(evals: PolicyEvaluation[]): Map<string, number> {
  const sorted = [...evals].sort(
    (a, b) =>
      b.outcome.bequestAttainmentRate - a.outcome.bequestAttainmentRate,
  );
  return new Map(sorted.map((e, i) => [e.id, i]));
}

function spearmanRho(
  rankA: Map<string, number>,
  rankB: Map<string, number>,
): number {
  const common = [...rankA.keys()].filter((id) => rankB.has(id));
  const n = common.length;
  if (n < 2) return 1;
  let sumDsq = 0;
  for (const id of common) {
    const d = (rankA.get(id) ?? 0) - (rankB.get(id) ?? 0);
    sumDsq += d * d;
  }
  return 1 - (6 * sumDsq) / (n * (n * n - 1));
}

interface StabilityReport {
  trialsHigh: number;
  trialsLow: number;
  topK: number;
  topKOverlap: number;
  spearmanRho: number;
  topPolicySame: boolean;
  countHigh: number;
  countLow: number;
}

function compareRankings(
  high: PolicyEvaluation[],
  low: PolicyEvaluation[],
  trialsHigh: number,
  trialsLow: number,
  topK: number,
): StabilityReport {
  const sortedHigh = [...high].sort(
    (a, b) =>
      b.outcome.bequestAttainmentRate - a.outcome.bequestAttainmentRate,
  );
  const sortedLow = [...low].sort(
    (a, b) =>
      b.outcome.bequestAttainmentRate - a.outcome.bequestAttainmentRate,
  );
  const topHigh = sortedHigh.slice(0, topK).map((r) => r.id);
  const topLow = sortedLow.slice(0, topK).map((r) => r.id);
  const topKOverlap = topHigh.filter((id) => topLow.includes(id)).length;
  const rankHigh = rankByBequest(high);
  const rankLow = rankByBequest(low);
  return {
    trialsHigh,
    trialsLow,
    topK,
    topKOverlap,
    spearmanRho: spearmanRho(rankHigh, rankLow),
    topPolicySame: topHigh[0] === topLow[0],
    countHigh: high.length,
    countLow: low.length,
  };
}

describe('policy mining ranking stability under reduced trial count', () => {
  it(
    'top-10 ranking is largely preserved at trial count 2000 vs 1000',
    { timeout: 120_000 },
    async () => {
      const policies = buildPolicyGrid();
      const high = await runMineAtTrials(policies, 2000);
      const low = await runMineAtTrials(policies, 1000);

      const report = compareRankings(high, low, 2000, 1000, 10);
      // eslint-disable-next-line no-console
      console.log('[stability 2000 vs 1000]', JSON.stringify(report));

      expect(report.countHigh).toBeGreaterThan(0);
      expect(report.countLow).toBeGreaterThan(0);
      // Top-10 overlap: at minimum 8 of 10 (80%) should still be in the top
      // 10 at half the trials. Calibrated empirically; tighten if observed
      // overlap is consistently higher.
      expect(report.topKOverlap).toBeGreaterThanOrEqual(8);
      // Spearman across all policies: rank correlation ≥ 0.85.
      expect(report.spearmanRho).toBeGreaterThanOrEqual(0.85);
    },
  );

  it(
    'top-10 ranking is largely preserved at trial count 2000 vs 500',
    { timeout: 120_000 },
    async () => {
      const policies = buildPolicyGrid();
      const high = await runMineAtTrials(policies, 2000);
      const low = await runMineAtTrials(policies, 500);

      const report = compareRankings(high, low, 2000, 500, 10);
      // eslint-disable-next-line no-console
      console.log('[stability 2000 vs 500]', JSON.stringify(report));

      // At 1/4 the trials, expect more drift. Allow looser bounds and
      // log the actual numbers so we can tighten if the data warrants.
      expect(report.topKOverlap).toBeGreaterThanOrEqual(7);
      expect(report.spearmanRho).toBeGreaterThanOrEqual(0.75);
    },
  );
});
