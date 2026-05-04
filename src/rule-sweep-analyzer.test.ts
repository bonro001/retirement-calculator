import { describe, it, expect } from 'vitest';
import { recommendRuleSweep } from './rule-sweep-analyzer';
import type { PolicyEvaluation, Policy } from './policy-miner-types';
import type { SeedData } from './types';
import seedFixture from '../seed-data.json';

function makeEval(
  policy: Partial<Policy>,
  bequestAttainmentRate: number,
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
      solventSuccessRate: 0.95,
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

describe('rule-sweep-analyzer', () => {
  it('returns hasRecommendation=false for an empty corpus', () => {
    const result = recommendRuleSweep([], seedFixture as SeedData);
    expect(result.hasRecommendation).toBe(false);
    expect(result.contenderCount).toBe(0);
    expect(result.estimatedPass2Candidates).toBe(0);
  });

  it('picks contenders within the attainment margin of the top record', () => {
    const evaluations = [
      makeEval({ annualSpendTodayDollars: 130_000 }, 0.92),
      makeEval({ annualSpendTodayDollars: 125_000 }, 0.88),
      makeEval({ annualSpendTodayDollars: 120_000 }, 0.85),
      // Below the 0.10 margin from 0.92 → cut at 0.82
      makeEval({ annualSpendTodayDollars: 100_000 }, 0.50),
      makeEval({ annualSpendTodayDollars: 90_000 }, 0.30),
    ];
    const result = recommendRuleSweep(evaluations, seedFixture as SeedData);
    expect(result.hasRecommendation).toBe(true);
    expect(result.contenderCount).toBe(3);
    expect(result.legacyAttainmentFloor).toBeCloseTo(0.82, 5);
  });

  it("emits the three non-default rules in pass-2 axes", () => {
    const evaluations = [
      makeEval({ annualSpendTodayDollars: 130_000 }, 0.90),
    ];
    const result = recommendRuleSweep(evaluations, seedFixture as SeedData);
    expect(result.axes.withdrawalRule).toEqual([
      'proportional',
      'reverse_waterfall',
      'guyton_klinger',
    ]);
  });

  it("pass-2 spend axis covers the contenders' bounding box only", () => {
    const evaluations = [
      makeEval({ annualSpendTodayDollars: 115_000 }, 0.90),
      makeEval({ annualSpendTodayDollars: 120_000 }, 0.88),
      makeEval({ annualSpendTodayDollars: 125_000 }, 0.86),
      // Far-from-leader candidate — should be excluded
      makeEval({ annualSpendTodayDollars: 80_000 }, 0.20),
    ];
    const result = recommendRuleSweep(evaluations, seedFixture as SeedData);
    expect(result.axes.annualSpendTodayDollars).toEqual([
      115_000, 120_000, 125_000,
    ]);
    expect(result.axes.annualSpendTodayDollars).not.toContain(80_000);
  });

  it('estimated pass-2 candidate count = bounding box × 3 rules', () => {
    const evaluations = [
      makeEval(
        {
          annualSpendTodayDollars: 130_000,
          primarySocialSecurityClaimAge: 67,
          spouseSocialSecurityClaimAge: 67,
          rothConversionAnnualCeiling: 40_000,
        },
        0.90,
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
    const result = recommendRuleSweep(evaluations, seedFixture as SeedData);
    // spends: [130k, 135k] = 2; primary SS: [67, 70] = 2; spouse SS:
    // [67] = 1; Roth: [40k, 80k] = 2; rules: 3. Total = 2*2*1*2*3 = 24.
    expect(result.estimatedPass2Candidates).toBe(24);
  });

  it('respects maxContenders cap when corpus has many leaders within margin', () => {
    const evaluations: PolicyEvaluation[] = [];
    for (let i = 0; i < 500; i += 1) {
      evaluations.push(
        makeEval(
          { annualSpendTodayDollars: 80_000 + i * 100 },
          0.85 + Math.random() * 0.05,
        ),
      );
    }
    const result = recommendRuleSweep(evaluations, seedFixture as SeedData, {
      maxContenders: 50,
    });
    expect(result.contenderCount).toBe(50);
  });

  it('handles single-earner households (spouseSS = null)', () => {
    const evaluations = [
      makeEval(
        {
          annualSpendTodayDollars: 100_000,
          spouseSocialSecurityClaimAge: null,
        },
        0.90,
      ),
    ];
    const result = recommendRuleSweep(evaluations, seedFixture as SeedData);
    expect(result.axes.spouseSocialSecurityClaimAge).toBeNull();
  });

  it('rationale mentions the 3 non-default rules by name', () => {
    const evaluations = [
      makeEval({ annualSpendTodayDollars: 130_000 }, 0.90),
    ];
    const result = recommendRuleSweep(evaluations, seedFixture as SeedData);
    expect(result.rationale).toContain('proportional');
    expect(result.rationale).toContain('reverse waterfall');
    expect(result.rationale).toContain('guyton klinger');
  });
});
