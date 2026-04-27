import { describe, it, expect, vi } from 'vitest';

// Stub the IndexedDB-backed corpus layer before importing the miner.
// Vitest hoists vi.mock() above import statements, so this runs before
// `runMiningSession` is loaded and bound to the real corpus functions.
vi.mock('./policy-mining-corpus', () => ({
  saveEvaluationsBatch: vi.fn().mockResolvedValue(undefined),
  saveMiningStats: vi.fn().mockResolvedValue(undefined),
  loadEvaluationsForBaseline: vi.fn().mockResolvedValue([]),
  clearBaseline: vi.fn().mockResolvedValue(undefined),
}));

import { runMiningSession, isBetterFeasibleCandidate } from './policy-miner';
import { initialSeedData } from './data';
import type { MarketAssumptions, SeedData } from './types';
import type { Policy, PolicyEvaluation, PolicyMiningSessionConfig } from './policy-miner-types';
import { policyId } from './policy-axis-enumerator';

/**
 * Phase 2.C two-stage screening — correctness tests.
 *
 * Goal: confirm that the two-stage flow (a) produces the same TOP
 * survivor as a full-trial-count run on the same policy list, (b) only
 * fine-pass evaluations stream through the persistence callback (no
 * coarse pollution), and (c) the coarseEvaluated / coarseScreenedOut
 * counters are populated correctly.
 *
 * We capture the persisted batches via `onBatchPersisted` rather than
 * actually writing to IndexedDB. The miner attempts a `saveEvaluationsBatch`
 * call which will throw without IDB, so we catch it at the test boundary
 * by inspecting only the in-memory captures and the final stats — both
 * are populated regardless of whether the underlying persistence
 * succeeds (the throw goes to the donePromise rejection but our test
 * only awaits intentionally caught failures).
 */

const ASSUMPTIONS: MarketAssumptions = {
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
  simulationRuns: 200,
  irmaaThreshold: 200000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 18,
  guardrailCutPercent: 0.2,
  robPlanningEndAge: 90,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260417,
  assumptionsVersion: 'two-stage-test',
};

function cloneSeedData(data: SeedData): SeedData {
  return JSON.parse(JSON.stringify(data)) as SeedData;
}

function buildSmallPolicySet(): Policy[] {
  // Spend levels span easy-feasible to obviously-aggressive on the household
  // baseline. The mid-range should survive screening; extreme-high should be
  // screened out by a moderately-tight feasibility threshold.
  const out: Policy[] = [];
  for (const spend of [50_000, 75_000, 100_000, 150_000, 250_000]) {
    out.push({
      annualSpendTodayDollars: spend,
      primarySocialSecurityClaimAge: 67,
      spouseSocialSecurityClaimAge: 67,
      rothConversionAnnualCeiling: 0,
    });
  }
  return out;
}

const FINGERPRINT = 'two-stage-test:fp';

/**
 * Run a mining session and capture all persisted evaluations into an
 * in-memory array via the `onBatchPersisted` callback. Swallows any
 * persistence failure (we don't have IndexedDB in this test env) so
 * the test asserts only on the in-memory captures and final stats —
 * both of which are populated synchronously before persistence is
 * attempted.
 */
async function runAndCapture(
  config: PolicyMiningSessionConfig,
  policies: Policy[],
): Promise<{ captured: PolicyEvaluation[]; finalStats: ReturnType<ReturnType<typeof runMiningSession>['readStats']> }> {
  const captured: PolicyEvaluation[] = [];
  const handle = runMiningSession({
    config,
    baseline: cloneSeedData(initialSeedData),
    assumptions: ASSUMPTIONS,
    policies,
    cloner: cloneSeedData,
    evaluatedByNodeId: 'test-host',
    legacyTargetTodayDollars: 1_000_000,
    onBatchPersisted: (batch) => {
      captured.push(...batch);
    },
  });
  // Persistence will throw because there's no IDB — that's fine, we
  // only care about what got captured.
  await handle.donePromise.catch(() => undefined);
  return { captured, finalStats: handle.readStats() };
}

describe('Phase 2.C — two-stage screening', () => {
  it('top survivor matches single-pass run on the same policies', async () => {
    const policies = buildSmallPolicySet();

    const baselineConfig: PolicyMiningSessionConfig = {
      baselineFingerprint: FINGERPRINT,
      engineVersion: 'test-v1',
      axes: { annualSpendTodayDollars: [], primarySocialSecurityClaimAge: [], spouseSocialSecurityClaimAge: null, rothConversionAnnualCeiling: [] },
      feasibilityThreshold: 0.50,
      maxPoliciesPerSession: policies.length,
    };
    const twoStageConfig: PolicyMiningSessionConfig = {
      ...baselineConfig,
      coarseStage: { trialCount: 50, feasibilityBuffer: 0.20 },
    };

    const { captured: baselineEvals } = await runAndCapture(baselineConfig, policies);
    const { captured: twoStageEvals } = await runAndCapture(twoStageConfig, policies);

    const findBest = (evals: PolicyEvaluation[]): PolicyEvaluation | null => {
      let best: PolicyEvaluation | null = null;
      for (const ev of evals) {
        if (ev.outcome.bequestAttainmentRate < 0.50) continue;
        if (isBetterFeasibleCandidate(ev, best)) best = ev;
      }
      return best;
    };
    const baselineBest = findBest(baselineEvals);
    const twoStageBest = findBest(twoStageEvals);

    expect(baselineBest).not.toBeNull();
    expect(twoStageBest).not.toBeNull();
    // Top survivor should be the SAME policy id — two-stage didn't kill the winner.
    expect(twoStageBest!.id).toBe(baselineBest!.id);
    // Fine-pass eval of the survivor is byte-identical to baseline eval
    // (same trial count, same seed, same assumptions).
    expect(twoStageBest!.outcome.solventSuccessRate).toBe(
      baselineBest!.outcome.solventSuccessRate,
    );
    expect(twoStageBest!.outcome.bequestAttainmentRate).toBe(
      baselineBest!.outcome.bequestAttainmentRate,
    );
  }, 60_000);

  it('only fine-pass evaluations stream through the persist callback', async () => {
    const policies = buildSmallPolicySet();
    const config: PolicyMiningSessionConfig = {
      baselineFingerprint: FINGERPRINT,
      engineVersion: 'test-v1',
      axes: { annualSpendTodayDollars: [], primarySocialSecurityClaimAge: [], spouseSocialSecurityClaimAge: null, rothConversionAnnualCeiling: [] },
      feasibilityThreshold: 0.50,
      maxPoliciesPerSession: policies.length,
      coarseStage: { trialCount: 50, feasibilityBuffer: 0.20 },
    };

    const { captured, finalStats } = await runAndCapture(config, policies);

    // Captured count = survivor count, NOT total policies. (If coarse
    // evals were leaking through the callback, captured.length would
    // equal policies.length.)
    expect(captured.length).toBeLessThanOrEqual(policies.length);
    expect(captured.length).toBe(policies.length - finalStats.coarseScreenedOut);

    // Coarse counters were populated.
    expect(finalStats.coarseEvaluated).toBe(policies.length);
    expect(finalStats.coarseScreenedOut).toBeGreaterThanOrEqual(0);
    expect(finalStats.coarseScreenedOut).toBeLessThanOrEqual(policies.length);

    // Captured evals carry the input policies' ids and shapes.
    const inputSpends = new Set(policies.map((p) => p.annualSpendTodayDollars));
    for (const ev of captured) {
      const expectedId = policyId(ev.policy, FINGERPRINT, 'test-v1');
      expect(ev.id).toBe(expectedId);
      expect(inputSpends.has(ev.policy.annualSpendTodayDollars)).toBe(true);
    }
  }, 60_000);

  it('extreme-aggressive policies get screened out (coarseScreenedOut > 0)', async () => {
    const aggressivePolicies: Policy[] = [
      { annualSpendTodayDollars: 200_000, primarySocialSecurityClaimAge: 62, spouseSocialSecurityClaimAge: 62, rothConversionAnnualCeiling: 0 },
      { annualSpendTodayDollars: 250_000, primarySocialSecurityClaimAge: 62, spouseSocialSecurityClaimAge: 62, rothConversionAnnualCeiling: 0 },
      { annualSpendTodayDollars: 300_000, primarySocialSecurityClaimAge: 62, spouseSocialSecurityClaimAge: 62, rothConversionAnnualCeiling: 0 },
      { annualSpendTodayDollars: 60_000, primarySocialSecurityClaimAge: 67, spouseSocialSecurityClaimAge: 67, rothConversionAnnualCeiling: 0 },
    ];
    const config: PolicyMiningSessionConfig = {
      baselineFingerprint: FINGERPRINT,
      engineVersion: 'test-v1',
      axes: { annualSpendTodayDollars: [], primarySocialSecurityClaimAge: [], spouseSocialSecurityClaimAge: null, rothConversionAnnualCeiling: [] },
      feasibilityThreshold: 0.70, // tight
      maxPoliciesPerSession: aggressivePolicies.length,
      coarseStage: { trialCount: 50, feasibilityBuffer: 0.15 },
    };

    const { finalStats } = await runAndCapture(config, aggressivePolicies);

    expect(finalStats.coarseEvaluated).toBe(aggressivePolicies.length);
    expect(finalStats.coarseScreenedOut).toBeGreaterThan(0);
  }, 60_000);
});
