import { describe, it, expect } from 'vitest';
import { recommendCliffRefinement } from './cliff-refinement-analyzer';
import type { PolicyEvaluation } from './policy-miner-types';
import type { SeedData } from './types';
import seedFixture from '../seed-data.json';

function ev(spend: number, attainment: number, idSuffix = ''): PolicyEvaluation {
  return {
    id: `pol_${spend}_${attainment.toFixed(2)}${idSuffix}`,
    evaluatedByNodeId: 'test',
    baselineFingerprint: 'fp',
    engineVersion: 'v',
    evaluatedAtIso: new Date().toISOString(),
    policy: {
      annualSpendTodayDollars: spend,
      primarySocialSecurityClaimAge: 67,
      spouseSocialSecurityClaimAge: 67,
      rothConversionAnnualCeiling: 0,
      withdrawalRule: 'tax_bracket_waterfall',
    },
    outcome: {
      solventSuccessRate: 1,
      bequestAttainmentRate: attainment,
      p10EndingWealthTodayDollars: 0,
      p25EndingWealthTodayDollars: 0,
      p50EndingWealthTodayDollars: 0,
      p75EndingWealthTodayDollars: 0,
      p90EndingWealthTodayDollars: 0,
      medianLifetimeSpendTodayDollars: 0,
      medianSpendVolatility: 0,
      medianLifetimeFederalTaxTodayDollars: 0,
      irmaaTrialFraction: 0,
      irmaaTier3PlusTrialFraction: 0,
      medianMaxIrmaaTier: 0,
      medianYearsAboveIrmaaThreshold: 0,
      medianRothConversionsTodayDollars: 0,
      medianRothConversionsYearCount: 0,
      acaSubsidyTrialFraction: 0,
    },
  } as PolicyEvaluation;
}

describe('cliff refinement analyzer', () => {
  it('detects the cliff and recommends $1k axis around it', () => {
    // Mock corpus: $110k = 0.99, $115k = 0.88, $120k = 0.81 (at the
    // 85% gate this is the cliff between $115k and $120k).
    const evaluations = [
      ev(110_000, 0.99),
      ev(115_000, 0.88),
      ev(120_000, 0.81),
      ev(125_000, 0.72),
    ];
    const result = recommendCliffRefinement(
      evaluations,
      seedFixture as SeedData,
      0.85,
    );
    expect(result.hasRecommendation).toBe(true);
    expect(result.cliffLowerSpend).toBe(115_000);
    expect(result.cliffUpperSpend).toBe(120_000);
    expect(result.axes.annualSpendTodayDollars).toEqual([
      115_000, 116_000, 117_000, 118_000, 119_000, 120_000,
    ]);
    expect(result.rationale).toContain('$115,000');
    expect(result.rationale).toContain('$120,000');
  });

  it('refines around different cliffs as the feasibility curve shifts', () => {
    // Cliff between $130k and $135k now (different plan, different
    // feasibility curve).
    const evaluations = [
      ev(125_000, 0.95),
      ev(130_000, 0.87),
      ev(135_000, 0.78),
      ev(140_000, 0.62),
    ];
    const result = recommendCliffRefinement(
      evaluations,
      seedFixture as SeedData,
      0.85,
    );
    expect(result.hasRecommendation).toBe(true);
    expect(result.cliffLowerSpend).toBe(130_000);
    expect(result.cliffUpperSpend).toBe(135_000);
    expect(result.axes.annualSpendTodayDollars).toEqual([
      130_000, 131_000, 132_000, 133_000, 134_000, 135_000,
    ]);
  });

  it('respects a non-default feasibility threshold (e.g. 0.95 strict)', () => {
    const evaluations = [
      ev(100_000, 0.99),
      ev(110_000, 0.96),
      ev(120_000, 0.92),
      ev(130_000, 0.81),
    ];
    const result = recommendCliffRefinement(
      evaluations,
      seedFixture as SeedData,
      0.95, // tighter floor — cliff moves down
    );
    expect(result.hasRecommendation).toBe(true);
    expect(result.cliffLowerSpend).toBe(110_000);
    expect(result.cliffUpperSpend).toBe(120_000);
  });

  it('returns no recommendation when every tier clears the floor', () => {
    const evaluations = [
      ev(100_000, 0.99),
      ev(110_000, 0.97),
      ev(120_000, 0.95),
    ];
    const result = recommendCliffRefinement(
      evaluations,
      seedFixture as SeedData,
      0.85,
    );
    expect(result.hasRecommendation).toBe(false);
    expect(result.rationale).toContain('slack');
  });

  it('returns no recommendation when no tier clears the floor', () => {
    const evaluations = [
      ev(100_000, 0.7),
      ev(110_000, 0.6),
      ev(120_000, 0.5),
    ];
    const result = recommendCliffRefinement(
      evaluations,
      seedFixture as SeedData,
      0.85,
    );
    expect(result.hasRecommendation).toBe(false);
    expect(result.rationale).toContain("can't support");
  });

  it('handles multiple records per spend tier (uses max feasibility)', () => {
    // 432 records per tier in production; the max across (SS × Roth ×
    // withdrawal) combos is what defines the cliff.
    const evaluations = [
      ev(110_000, 0.85, '-a'),
      ev(110_000, 0.95, '-b'), // max for $110k tier
      ev(110_000, 0.99, '-c'),
      ev(115_000, 0.78, '-a'),
      ev(115_000, 0.88, '-b'), // max for $115k tier — clears 85%
      ev(120_000, 0.65, '-a'),
      ev(120_000, 0.81, '-b'), // max for $120k tier — fails 85%
    ];
    const result = recommendCliffRefinement(
      evaluations,
      seedFixture as SeedData,
      0.85,
    );
    expect(result.hasRecommendation).toBe(true);
    expect(result.cliffLowerSpend).toBe(115_000);
    expect(result.cliffUpperSpend).toBe(120_000);
  });
});
