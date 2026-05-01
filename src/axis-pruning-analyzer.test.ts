import { describe, it, expect } from 'vitest';
import type { Policy, PolicyAxes, PolicyEvaluation } from './policy-miner-types';
import { analyzeAxisPruning, summarizeAxisPruning } from './axis-pruning-analyzer';

/**
 * Tests for `analyzeAxisPruning`.
 *
 * The analyzer is a pure function over a corpus of `PolicyEvaluation`
 * records. We don't run the engine here — we hand-craft small corpora
 * that exercise specific feasibility patterns:
 *
 *   1. Single-axis pruning: bottom spend level always infeasible
 *   2. Multi-axis pruning
 *   3. No-pruning case: every value contributes feasibility
 *   4. All-infeasible case: pruning is meaningless
 *   5. Empty bucket: axis value never observed in corpus
 *   6. Spouse-axis collapse: null spouse SS axis
 *   7. Summary text reflects what was dropped
 */

function buildEval(
  policy: Policy,
  outcome: { solvent: number; legacy: number; p50: number },
): PolicyEvaluation {
  return {
    evaluatedByNodeId: 'test',
    id: `pol_${Math.random().toString(36).slice(2, 10)}`,
    baselineFingerprint: 'test-fp',
    engineVersion: 'test-v1',
    evaluatedAtIso: new Date().toISOString(),
    policy,
    outcome: {
      solventSuccessRate: outcome.solvent,
      bequestAttainmentRate: outcome.legacy,
      p10EndingWealthTodayDollars: outcome.p50 * 0.5,
      p25EndingWealthTodayDollars: outcome.p50 * 0.75,
      p50EndingWealthTodayDollars: outcome.p50,
      p75EndingWealthTodayDollars: outcome.p50 * 1.25,
      p90EndingWealthTodayDollars: outcome.p50 * 1.5,
      medianLifetimeSpendTodayDollars: 0,
      medianSpendVolatility: 0,
      medianLifetimeFederalTaxTodayDollars: 0,
      irmaaExposureRate: 0,
    },
    evaluationDurationMs: 1,
  };
}

function makePolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    annualSpendTodayDollars: 100_000,
    primarySocialSecurityClaimAge: 67,
    spouseSocialSecurityClaimAge: 67,
    rothConversionAnnualCeiling: 0,
    ...overrides,
  };
}

describe('analyzeAxisPruning — contract', () => {
  it('flags a spend level as alwaysInfeasible when every candidate at that value fails', () => {
    const axes: PolicyAxes = {
      annualSpendTodayDollars: [80_000, 100_000, 120_000],
      primarySocialSecurityClaimAge: [67, 70],
      spouseSocialSecurityClaimAge: [67, 70],
      rothConversionAnnualCeiling: [0, 80_000],
    };
    // Every $80k candidate fails (solvent < 0.85). Every $100k+ candidate passes.
    const evaluations: PolicyEvaluation[] = [];
    for (const spend of axes.annualSpendTodayDollars) {
      for (const ss of axes.primarySocialSecurityClaimAge) {
        for (const spSs of axes.spouseSocialSecurityClaimAge!) {
          for (const roth of axes.rothConversionAnnualCeiling) {
            const policy = makePolicy({
              annualSpendTodayDollars: spend,
              primarySocialSecurityClaimAge: ss,
              spouseSocialSecurityClaimAge: spSs,
              rothConversionAnnualCeiling: roth,
            });
            const solvent = spend === 80_000 ? 0.40 : 0.95;
            const legacy = spend === 80_000 ? 0.30 : 0.90;
            evaluations.push(buildEval(policy, { solvent, legacy, p50: 1_000_000 }));
          }
        }
      }
    }

    const result = analyzeAxisPruning(evaluations, axes);

    const spendAxis = result.axes.annualSpendTodayDollars;
    expect(spendAxis.shouldPrune).toBe(true);
    const eightyK = spendAxis.values.find((v) => v.value === 80_000);
    expect(eightyK?.alwaysInfeasible).toBe(true);
    expect(spendAxis.recommendedValues).toEqual([100_000, 120_000]);
    // SS / Roth axes have feasibility everywhere → no pruning.
    expect(result.axes.primarySocialSecurityClaimAge.shouldPrune).toBe(false);
    expect(result.axes.rothConversionAnnualCeiling.shouldPrune).toBe(false);
    expect(result.hasRecommendation).toBe(true);
    expect(result.corpusHasFeasibleCandidates).toBe(true);
    expect(result.recommendedAxes.annualSpendTodayDollars).toEqual([100_000, 120_000]);
    // Original 3×2×2×2=24, recommended 2×2×2×2=16.
    expect(result.originalGridSize).toBe(24);
    expect(result.recommendedGridSize).toBe(16);
  });

  it('does not prune when every axis value contributes at least one feasible candidate', () => {
    const axes: PolicyAxes = {
      annualSpendTodayDollars: [100_000, 120_000],
      primarySocialSecurityClaimAge: [67, 70],
      spouseSocialSecurityClaimAge: null,
      rothConversionAnnualCeiling: [0, 80_000],
    };
    const evaluations: PolicyEvaluation[] = [];
    for (const spend of axes.annualSpendTodayDollars) {
      for (const ss of axes.primarySocialSecurityClaimAge) {
        for (const roth of axes.rothConversionAnnualCeiling) {
          const policy = makePolicy({
            annualSpendTodayDollars: spend,
            primarySocialSecurityClaimAge: ss,
            spouseSocialSecurityClaimAge: null,
            rothConversionAnnualCeiling: roth,
          });
          evaluations.push(
            buildEval(policy, { solvent: 0.95, legacy: 0.90, p50: 1_000_000 }),
          );
        }
      }
    }
    const result = analyzeAxisPruning(evaluations, axes);
    expect(result.hasRecommendation).toBe(false);
    expect(result.recommendedGridSize).toBe(result.originalGridSize);
  });

  it('does not prune when the entire corpus is infeasible (deeper problem)', () => {
    const axes: PolicyAxes = {
      annualSpendTodayDollars: [200_000, 250_000],
      primarySocialSecurityClaimAge: [67, 70],
      spouseSocialSecurityClaimAge: null,
      rothConversionAnnualCeiling: [0],
    };
    const evaluations: PolicyEvaluation[] = [];
    for (const spend of axes.annualSpendTodayDollars) {
      for (const ss of axes.primarySocialSecurityClaimAge) {
        const policy = makePolicy({
          annualSpendTodayDollars: spend,
          primarySocialSecurityClaimAge: ss,
          spouseSocialSecurityClaimAge: null,
          rothConversionAnnualCeiling: 0,
        });
        evaluations.push(
          buildEval(policy, { solvent: 0.30, legacy: 0.10, p50: 100_000 }),
        );
      }
    }
    const result = analyzeAxisPruning(evaluations, axes);
    expect(result.corpusHasFeasibleCandidates).toBe(false);
    // Every axis would be alwaysInfeasible, so shouldPrune=false on all
    // (since "all" infeasible → don't prune; deeper problem).
    expect(result.axes.annualSpendTodayDollars.shouldPrune).toBe(false);
    expect(result.hasRecommendation).toBe(false);
  });

  it('handles spouse-axis collapse (null spouse SS)', () => {
    const axes: PolicyAxes = {
      annualSpendTodayDollars: [100_000],
      primarySocialSecurityClaimAge: [67, 70],
      spouseSocialSecurityClaimAge: null,
      rothConversionAnnualCeiling: [0],
    };
    const evaluations = axes.primarySocialSecurityClaimAge.map((ss) =>
      buildEval(
        makePolicy({
          primarySocialSecurityClaimAge: ss,
          spouseSocialSecurityClaimAge: null,
        }),
        { solvent: 0.95, legacy: 0.90, p50: 1_000_000 },
      ),
    );
    const result = analyzeAxisPruning(evaluations, axes);
    expect(result.axes.spouseSocialSecurityClaimAge.values).toHaveLength(0);
    expect(result.recommendedAxes.spouseSocialSecurityClaimAge).toBeNull();
  });

  it('treats unobserved axis values as not-flagged (empty bucket safe)', () => {
    const axes: PolicyAxes = {
      annualSpendTodayDollars: [100_000, 120_000],
      primarySocialSecurityClaimAge: [67],
      spouseSocialSecurityClaimAge: null,
      rothConversionAnnualCeiling: [0],
    };
    // Only $100k spend has any evaluation; $120k is unobserved.
    const evaluations = [
      buildEval(makePolicy({ annualSpendTodayDollars: 100_000 }), {
        solvent: 0.95,
        legacy: 0.9,
        p50: 1_000_000,
      }),
    ];
    const result = analyzeAxisPruning(evaluations, axes);
    const spendAxis = result.axes.annualSpendTodayDollars;
    const oneTwenty = spendAxis.values.find((v) => v.value === 120_000);
    // Unobserved → totalCandidates = 0 → alwaysInfeasible = false (we
    // require at least one observed candidate to flag a value).
    expect(oneTwenty?.totalCandidates).toBe(0);
    expect(oneTwenty?.alwaysInfeasible).toBe(false);
  });
});

describe('summarizeAxisPruning', () => {
  it('describes which axis values get dropped', () => {
    const axes: PolicyAxes = {
      annualSpendTodayDollars: [80_000, 100_000, 120_000],
      primarySocialSecurityClaimAge: [67],
      spouseSocialSecurityClaimAge: null,
      rothConversionAnnualCeiling: [0],
    };
    const evaluations = axes.annualSpendTodayDollars.map((spend) =>
      buildEval(
        makePolicy({
          annualSpendTodayDollars: spend,
          spouseSocialSecurityClaimAge: null,
        }),
        spend === 80_000
          ? { solvent: 0.4, legacy: 0.3, p50: 100_000 }
          : { solvent: 0.95, legacy: 0.9, p50: 1_000_000 },
      ),
    );
    const result = analyzeAxisPruning(evaluations, axes);
    const summary = summarizeAxisPruning(result);
    expect(summary).toContain('spend levels');
    expect(summary).toContain('80000');
    expect(summary).toContain('Grid shrinks');
  });

  it('flags the all-infeasible corpus with a different message', () => {
    const axes: PolicyAxes = {
      annualSpendTodayDollars: [200_000],
      primarySocialSecurityClaimAge: [67],
      spouseSocialSecurityClaimAge: null,
      rothConversionAnnualCeiling: [0],
    };
    const evaluations = [
      buildEval(makePolicy({ annualSpendTodayDollars: 200_000 }), {
        solvent: 0.3,
        legacy: 0.1,
        p50: 100_000,
      }),
    ];
    const result = analyzeAxisPruning(evaluations, axes);
    const summary = summarizeAxisPruning(result);
    expect(summary).toContain('No candidate');
  });
});
