import { describe, it, expect } from 'vitest';
import { recommendCombinedPass2 } from './combined-pass2-analyzer';
import type { PolicyEvaluation, Policy } from './policy-miner-types';
import type { SeedData } from './types';
import seedFixture from '../seed-data.json';

function makeEval(
  policy: Partial<Policy>,
  bequestAttainmentRate: number,
  solventSuccessRate = 0.95,
): PolicyEvaluation {
  return {
    id: `pol_${Math.random().toString(16).slice(2, 10)}`,
    baselineFingerprint: 'fp',
    engineVersion: 'eng',
    evaluatedByNodeId: 'node',
    evaluatedAtIso: '2026-05-03T00:00:00Z',
    policy: {
      annualSpendTodayDollars: 100_000,
      primarySocialSecurityClaimAge: 67,
      spouseSocialSecurityClaimAge: 67,
      rothConversionAnnualCeiling: 40_000,
      withdrawalRule: 'tax_bracket_waterfall',
      ...policy,
    },
    outcome: {
      solventSuccessRate,
      bequestAttainmentRate,
      p10EndingWealthTodayDollars: 0,
      p25EndingWealthTodayDollars: 0,
      p50EndingWealthTodayDollars: 0,
      p75EndingWealthTodayDollars: 0,
      p90EndingWealthTodayDollars: 0,
      medianLifetimeSpendTodayDollars: 0,
      medianSpendVolatility: 0,
      medianLifetimeFederalTaxTodayDollars: 0,
      irmaaExposureRate: 0,
    },
    evaluationDurationMs: 100,
  };
}

describe('combined pass-2 analyzer', () => {
  it('hasRecommendation=false on an empty corpus', () => {
    const result = recommendCombinedPass2([], seedFixture as SeedData);
    expect(result.hasRecommendation).toBe(false);
    expect(result.estimatedPass2Candidates).toBe(0);
  });

  it('emits all four withdrawal rules when contenders exist', () => {
    const evaluations = [
      makeEval({ annualSpendTodayDollars: 130_000 }, 0.92),
      makeEval({ annualSpendTodayDollars: 125_000 }, 0.88),
    ];
    const result = recommendCombinedPass2(evaluations, seedFixture as SeedData);
    expect(result.hasRecommendation).toBe(true);
    expect(result.axes.withdrawalRule).toEqual([
      'tax_bracket_waterfall',
      'proportional',
      'reverse_waterfall',
      'guyton_klinger',
    ]);
  });

  it('uses cliff $1k spend resolution when a cliff is detected', () => {
    // Build a corpus with a clear cliff between $115k (clears 85%) and
    // $120k (drops below). $1k cliff bracket should be [115k..120k].
    const evaluations: PolicyEvaluation[] = [];
    for (let spend = 100_000; spend <= 130_000; spend += 5_000) {
      // Above-cliff side: solid 90%; below-cliff side: 50%.
      const f = spend <= 115_000 ? 0.90 : 0.50;
      evaluations.push(makeEval({ annualSpendTodayDollars: spend }, f));
    }
    const result = recommendCombinedPass2(evaluations, seedFixture as SeedData);
    expect(result.hasRecommendation).toBe(true);
    expect(result.hasCliff).toBe(true);
    expect(result.axes.annualSpendTodayDollars).toEqual([
      115_000, 116_000, 117_000, 118_000, 119_000, 120_000,
    ]);
  });

  it('includes the solvency cliff when solvency is the binding table gate', () => {
    const evaluations: PolicyEvaluation[] = [];
    for (let spend = 100_000; spend <= 130_000; spend += 5_000) {
      const legacy = 0.92;
      const solvency = spend <= 110_000 ? 0.90 : 0.70;
      evaluations.push(makeEval({ annualSpendTodayDollars: spend }, legacy, solvency));
    }
    const result = recommendCombinedPass2(
      evaluations,
      seedFixture as SeedData,
      0.85,
      'legacy',
      0.85,
    );
    expect(result.hasRecommendation).toBe(true);
    expect(result.hasCliff).toBe(true);
    expect(result.axes.annualSpendTodayDollars).toEqual([
      110_000, 111_000, 112_000, 113_000, 114_000, 115_000,
    ]);
  });

  it('does not fill dead spend space between separate risk cliffs', () => {
    const evaluations: PolicyEvaluation[] = [];
    for (let spend = 100_000; spend <= 160_000; spend += 5_000) {
      const legacy = spend <= 155_000 ? 0.90 : 0.70;
      const solvency = spend <= 115_000 ? 0.90 : 0.70;
      evaluations.push(makeEval({ annualSpendTodayDollars: spend }, legacy, solvency));
    }
    const result = recommendCombinedPass2(
      evaluations,
      seedFixture as SeedData,
      0.85,
      'legacy',
      0.85,
    );
    expect(result.hasRecommendation).toBe(true);
    expect(result.hasCliff).toBe(true);
    expect(result.axes.annualSpendTodayDollars).toEqual([
      115_000, 116_000, 117_000, 118_000, 119_000, 120_000,
      155_000, 156_000, 157_000, 158_000, 159_000, 160_000,
    ]);
    expect(result.axes.annualSpendTodayDollars).not.toContain(130_000);
  });

  it("falls back to contenders' spend bounding box when no cliff present", () => {
    // All-feasible corpus → no cliff. Pass-2 uses the contenders'
    // spend range instead of $1k zoom.
    const evaluations = [
      makeEval({ annualSpendTodayDollars: 100_000 }, 0.92),
      makeEval({ annualSpendTodayDollars: 110_000 }, 0.91),
      makeEval({ annualSpendTodayDollars: 120_000 }, 0.90),
    ];
    const result = recommendCombinedPass2(evaluations, seedFixture as SeedData);
    expect(result.hasRecommendation).toBe(true);
    expect(result.hasCliff).toBe(false);
    // Spends should match contender set, not be $1k-spaced.
    expect(result.axes.annualSpendTodayDollars).toEqual([
      100_000, 110_000, 120_000,
    ]);
  });

  it('narrows SS / Roth axes to the contender bounding box', () => {
    const evaluations = [
      makeEval(
        {
          annualSpendTodayDollars: 130_000,
          primarySocialSecurityClaimAge: 67,
          spouseSocialSecurityClaimAge: 67,
          rothConversionAnnualCeiling: 40_000,
        },
        0.92,
      ),
      makeEval(
        {
          annualSpendTodayDollars: 125_000,
          primarySocialSecurityClaimAge: 70,
          spouseSocialSecurityClaimAge: 67,
          rothConversionAnnualCeiling: 80_000,
        },
        0.88,
      ),
      // Far-from-leader; should NOT be in pass-2 bounding box.
      makeEval(
        {
          annualSpendTodayDollars: 80_000,
          primarySocialSecurityClaimAge: 65,
          spouseSocialSecurityClaimAge: 65,
          rothConversionAnnualCeiling: 200_000,
        },
        0.20,
      ),
    ];
    const result = recommendCombinedPass2(evaluations, seedFixture as SeedData);
    expect(result.axes.primarySocialSecurityClaimAge).toEqual([67, 70]);
    expect(result.axes.spouseSocialSecurityClaimAge).toEqual([67]);
    expect(result.axes.rothConversionAnnualCeiling).toEqual([40_000, 80_000]);
  });

  it('reports estimated candidate count = spend × primary × spouse × roth × 4 rules', () => {
    const evaluations = [
      makeEval(
        {
          annualSpendTodayDollars: 130_000,
          primarySocialSecurityClaimAge: 67,
          spouseSocialSecurityClaimAge: 67,
          rothConversionAnnualCeiling: 40_000,
        },
        0.92,
      ),
      makeEval(
        {
          annualSpendTodayDollars: 135_000,
          primarySocialSecurityClaimAge: 70,
          spouseSocialSecurityClaimAge: 67,
          rothConversionAnnualCeiling: 80_000,
        },
        0.88,
      ),
    ];
    const result = recommendCombinedPass2(evaluations, seedFixture as SeedData);
    // No cliff detected (only 2 tiers), so spends = contender bounding
    // box = [130k, 135k] = 2. Primary SS [67, 70] = 2. Spouse SS [67]
    // = 1. Roth [40k, 80k] = 2. Rules = 4. Total = 2*2*1*2*4 = 32.
    expect(result.estimatedPass2Candidates).toBe(32);
  });

  it('rationale mentions the contender count and rule comparison', () => {
    const evaluations = [
      makeEval({ annualSpendTodayDollars: 130_000 }, 0.92),
      makeEval({ annualSpendTodayDollars: 125_000 }, 0.88),
    ];
    const result = recommendCombinedPass2(evaluations, seedFixture as SeedData);
    expect(result.rationale).toMatch(/contender/);
    expect(result.rationale).toMatch(/four withdrawal rules/);
  });
});
