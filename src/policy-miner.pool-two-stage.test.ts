import { describe, it, expect, vi } from 'vitest';

/**
 * Phase 2.C extension — pool-path two-stage screening.
 *
 * The cluster host workers call `runMiningSessionWithPool` (not the
 * serial `runMiningSession`). This test verifies the same two-stage
 * contract holds on the pool path: coarse evaluations are NOT persisted,
 * only survivors get fine-evaluated, top survivor matches single-pass,
 * and the coarseEvaluated/coarseScreenedOut counters are populated.
 *
 * We mock both the corpus persistence AND the pool's worker dispatch
 * — `runPolicyBatch` is replaced with a stub that synchronously
 * computes a deterministic outcome from policy + assumptions. This
 * tests the orchestration logic without spinning up real worker_threads.
 */

vi.mock('./policy-mining-corpus', () => ({
  saveEvaluationsBatch: vi.fn().mockResolvedValue(undefined),
  saveMiningStats: vi.fn().mockResolvedValue(undefined),
  loadEvaluationsForBaseline: vi.fn().mockResolvedValue([]),
  clearBaseline: vi.fn().mockResolvedValue(undefined),
}));

// State bag the pool mock reads to know which trial count it's running
// (so coarse vs fine produce identifiably-different evaluations).
const poolState = {
  primedSessions: new Map<string, { trialCount: number; baselineFingerprint: string; engineVersion: string }>(),
  cancelled: false,
};

vi.mock('./policy-miner-pool', () => ({
  getMinerPoolSize: () => 4,
  getFreeMinerSlotCount: () => 4,
  describeMinerPoolSizing: () => ({ size: 4, source: 'mock' }),
  primeMinerSession: vi.fn((args: { sessionId: string; assumptions: { simulationRuns: number }; baselineFingerprint: string; engineVersion: string }) => {
    poolState.primedSessions.set(args.sessionId, {
      trialCount: args.assumptions.simulationRuns,
      baselineFingerprint: args.baselineFingerprint,
      engineVersion: args.engineVersion,
    });
  }),
  unprimeMinerSession: vi.fn((sessionId: string) => {
    poolState.primedSessions.delete(sessionId);
  }),
  cancelMinerSession: vi.fn(() => {
    poolState.cancelled = true;
  }),
  // Mock dispatch: returns a synthetic PolicyEvaluation per policy whose
  // bequestAttainmentRate = a function of (annualSpend, trialCount).
  // High spend → low attainment; low spend → high attainment. This lets
  // us deterministically control which policies survive coarse cuts.
  // The trialCount lookup proves coarse vs fine were primed correctly.
  runPolicyBatch: vi.fn(async (sessionId: string, batch: Array<{
    annualSpendTodayDollars: number;
    primarySocialSecurityClaimAge: number;
    spouseSocialSecurityClaimAge: number | null;
    rothConversionAnnualCeiling: number;
  }>) => {
    const session = poolState.primedSessions.get(sessionId);
    if (!session) throw new Error(`runPolicyBatch: session ${sessionId} not primed`);
    return batch.map((policy) => {
      // Synthetic deterministic outcome: attainment rate decreases
      // linearly as spend increases. At $50k → 0.95, at $250k → 0.0.
      const attainment = Math.max(0, Math.min(1, 1 - (policy.annualSpendTodayDollars - 50_000) / 200_000));
      return {
        id: `pol-${policy.annualSpendTodayDollars}`,
        baselineFingerprint: session.baselineFingerprint,
        engineVersion: session.engineVersion,
        evaluatedByNodeId: 'mock',
        evaluatedAtIso: new Date().toISOString(),
        policy: { ...policy },
        outcome: {
          solventSuccessRate: attainment,
          bequestAttainmentRate: attainment,
          p10EndingWealthTodayDollars: 0,
          p25EndingWealthTodayDollars: 0,
          p50EndingWealthTodayDollars: attainment * 1_000_000,
          p75EndingWealthTodayDollars: 0,
          p90EndingWealthTodayDollars: 0,
          medianLifetimeSpendTodayDollars: 0,
          medianSpendVolatility: 0,
          medianLifetimeFederalTaxTodayDollars: 0,
          irmaaExposureRate: 0,
        },
        evaluationDurationMs: session.trialCount, // marker: duration == trial count
      };
    });
  }),
}));

import { runMiningSessionWithPool, isBetterFeasibleCandidate } from './policy-miner';
import { initialSeedData } from './data';
import type { MarketAssumptions } from './types';
import type { Policy, PolicyEvaluation, PolicyMiningSessionConfig } from './policy-miner-types';

const ASSUMPTIONS: MarketAssumptions = {
  equityMean: 0.074, equityVolatility: 0.16,
  internationalEquityMean: 0.074, internationalEquityVolatility: 0.18,
  bondMean: 0.038, bondVolatility: 0.07,
  cashMean: 0.02, cashVolatility: 0.01,
  inflation: 0.028, inflationVolatility: 0.01,
  simulationRuns: 2000,
  irmaaThreshold: 200000, guardrailFloorYears: 12, guardrailCeilingYears: 18,
  guardrailCutPercent: 0.2, robPlanningEndAge: 90, debbiePlanningEndAge: 95,
  travelPhaseYears: 10, simulationSeed: 20260417,
  assumptionsVersion: 'pool-two-stage-test',
};

function buildPolicies(): Policy[] {
  // Spread of spend levels — at our synthetic attainment function, this
  // gives a known mix of "feasible" (low spend) and "screened out"
  // (high spend) candidates.
  const out: Policy[] = [];
  for (const spend of [50_000, 75_000, 100_000, 150_000, 200_000, 250_000]) {
    out.push({
      annualSpendTodayDollars: spend,
      primarySocialSecurityClaimAge: 67,
      spouseSocialSecurityClaimAge: 67,
      rothConversionAnnualCeiling: 0,
    });
  }
  return out;
}

const FINGERPRINT = 'pool-two-stage-test:fp';

async function runPool(
  config: PolicyMiningSessionConfig,
  policies: Policy[],
): Promise<{ captured: PolicyEvaluation[]; finalStats: ReturnType<ReturnType<typeof runMiningSessionWithPool>['readStats']> }> {
  const captured: PolicyEvaluation[] = [];
  const handle = runMiningSessionWithPool({
    config,
    baseline: initialSeedData,
    assumptions: ASSUMPTIONS,
    policies,
    evaluatedByNodeId: 'pool-test',
    legacyTargetTodayDollars: 1_000_000,
    onBatchPersisted: (batch) => { captured.push(...batch); },
    policiesPerBatch: 2,
    batchesPerWorker: 1,
  });
  await handle.donePromise.catch(() => undefined);
  return { captured, finalStats: handle.readStats() };
}

describe('Phase 2.C — pool-path two-stage screening', () => {
  it('top survivor matches single-pass run on the same policies', async () => {
    poolState.primedSessions.clear();
    poolState.cancelled = false;
    const policies = buildPolicies();

    const baseConfig: PolicyMiningSessionConfig = {
      baselineFingerprint: FINGERPRINT,
      engineVersion: 'test-v1',
      axes: { annualSpendTodayDollars: [], primarySocialSecurityClaimAge: [], spouseSocialSecurityClaimAge: null, rothConversionAnnualCeiling: [] },
      feasibilityThreshold: 0.50,
      maxPoliciesPerSession: policies.length,
    };

    const { captured: baselineEvals } = await runPool(baseConfig, policies);
    const { captured: twoStageEvals, finalStats } = await runPool(
      { ...baseConfig, coarseStage: { trialCount: 200, feasibilityBuffer: 0.10 } },
      policies,
    );

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
    expect(twoStageBest!.id).toBe(baselineBest!.id);
    expect(finalStats.coarseEvaluated).toBe(policies.length);
    expect(finalStats.coarseScreenedOut).toBeGreaterThan(0);
  });

  it('only fine-pass evaluations stream through the persist callback', async () => {
    poolState.primedSessions.clear();
    poolState.cancelled = false;
    const policies = buildPolicies();
    const config: PolicyMiningSessionConfig = {
      baselineFingerprint: FINGERPRINT,
      engineVersion: 'test-v1',
      axes: { annualSpendTodayDollars: [], primarySocialSecurityClaimAge: [], spouseSocialSecurityClaimAge: null, rothConversionAnnualCeiling: [] },
      feasibilityThreshold: 0.50,
      maxPoliciesPerSession: policies.length,
      coarseStage: { trialCount: 200, feasibilityBuffer: 0.10 },
    };

    const { captured, finalStats } = await runPool(config, policies);

    // Captured = survivors only.
    expect(captured.length).toBe(policies.length - finalStats.coarseScreenedOut);

    // Each captured eval's evaluationDurationMs (mock marker) equals the
    // FINE trial count (2000), proving these are fine-pass results not
    // coarse pollution. If coarse evals leaked through, they'd carry the
    // coarse trial count (200).
    for (const ev of captured) {
      expect(ev.evaluationDurationMs).toBe(2000);
    }
  });

  it('coarse and fine sessions both prime and unprime the worker pool', async () => {
    poolState.primedSessions.clear();
    poolState.cancelled = false;
    const policies = buildPolicies();
    const config: PolicyMiningSessionConfig = {
      baselineFingerprint: FINGERPRINT,
      engineVersion: 'test-v1',
      axes: { annualSpendTodayDollars: [], primarySocialSecurityClaimAge: [], spouseSocialSecurityClaimAge: null, rothConversionAnnualCeiling: [] },
      feasibilityThreshold: 0.50,
      maxPoliciesPerSession: policies.length,
      coarseStage: { trialCount: 200, feasibilityBuffer: 0.10 },
    };

    await runPool(config, policies);

    // After the session completes, both sessions should be unprimed —
    // worker memory is released. (Mock tracks live primed sessions.)
    expect(poolState.primedSessions.size).toBe(0);
  });
});
