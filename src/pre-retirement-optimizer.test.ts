import { describe, it, expect } from 'vitest';
import { initialSeedData } from './data';
import type { SeedData } from './types';
import { buildPreRetirementOptimizerRecommendation } from './pre-retirement-optimizer';

function cloneSeed(overrides: Partial<SeedData['income']> = {}): SeedData {
  const seed = JSON.parse(JSON.stringify(initialSeedData)) as SeedData;
  seed.income = { ...seed.income, ...overrides };
  return seed;
}

// Reference "as-of" date inside Rob's working window (salary ends 2027-07-01).
const AS_OF = new Date('2026-04-23T00:00:00Z');

describe('pre-retirement optimizer', () => {
  it('flags HSA shortfall when contribution rate is well below the limit', () => {
    const seed = cloneSeed(); // default: HSA at 1.59% of salary
    const rec = buildPreRetirementOptimizerRecommendation({ seedData: seed }, AS_OF);
    expect(rec.applicable).toBe(true);
    const hsa = rec.shortfalls.find((s) => s.bucket === 'hsa');
    expect(hsa).toBeDefined();
    expect(hsa!.shortfallAnnual).toBeGreaterThan(1_000);
    expect(hsa!.shortfallPct).toBeLessThan(0.5);
  });

  it('produces a headline that names a concrete dollar impact when shortfalls exist', () => {
    const rec = buildPreRetirementOptimizerRecommendation(
      { seedData: cloneSeed() },
      AS_OF,
    );
    expect(rec.headline).toMatch(/\$[\d,]+/); // contains a dollar figure
    expect(rec.actionSteps.length).toBeGreaterThan(0);
  });

  it('marks both-recommendations-compatible true when surplus is positive', () => {
    const rec = buildPreRetirementOptimizerRecommendation(
      { seedData: cloneSeed() },
      AS_OF,
    );
    // Rob's $210k salary easily supports maxed 401k + HSA + $108k lifestyle
    // → positive surplus expected.
    expect(rec.bothRecommendationsCompatible).toBe(true);
    expect(rec.bridge.estimatedAnnualSurplus).toBeGreaterThan(0);
  });

  it('marks both-recommendations-compatible false when surplus is exhausted', () => {
    // Force spending above take-home by ballooning essential monthly.
    const seed = cloneSeed();
    seed.spending = { ...seed.spending, essentialMonthly: 20_000 };
    const rec = buildPreRetirementOptimizerRecommendation({ seedData: seed }, AS_OF);
    expect(rec.bothRecommendationsCompatible).toBe(false);
    expect(rec.bridge.estimatedAnnualSurplus).toBe(0);
  });

  it('bridge target reflects years until Medicare and current spend', () => {
    const rec = buildPreRetirementOptimizerRecommendation(
      { seedData: cloneSeed() },
      AS_OF,
    );
    // Rob is 61 at AS_OF, retires ~62.5, Medicare at 65 → ~2.5 bridge years.
    expect(rec.bridge.bridgeYearsCovered).toBeGreaterThan(1);
    expect(rec.bridge.bridgeYearsCovered).toBeLessThan(4);
    // Target is spend × bridge years.
    const expectedTarget =
      rec.bridge.estimatedAnnualLifestyleSpend * rec.bridge.bridgeYearsCovered;
    expect(rec.bridge.bridgeTargetBalance).toBeCloseTo(expectedTarget, 0);
  });

  it('tax-savings estimate uses the configured marginal rate', () => {
    const at22 = buildPreRetirementOptimizerRecommendation(
      { seedData: cloneSeed(), marginalFederalRate: 0.22 },
      AS_OF,
    );
    const at32 = buildPreRetirementOptimizerRecommendation(
      { seedData: cloneSeed(), marginalFederalRate: 0.32 },
      AS_OF,
    );
    const hsaAt22 = at22.shortfalls.find((s) => s.bucket === 'hsa')!;
    const hsaAt32 = at32.shortfalls.find((s) => s.bucket === 'hsa')!;
    // Same shortfall, higher marginal rate → higher estimated savings.
    expect(hsaAt22.shortfallAnnual).toBe(hsaAt32.shortfallAnnual);
    expect(hsaAt32.estimatedMarginalFederalTaxSavedPerYear).toBeGreaterThan(
      hsaAt22.estimatedMarginalFederalTaxSavedPerYear,
    );
  });

  it('returns a non-applicable result for already-retired households', () => {
    const seed = cloneSeed({ salaryAnnual: 0 });
    const rec = buildPreRetirementOptimizerRecommendation({ seedData: seed }, AS_OF);
    expect(rec.applicable).toBe(false);
    expect(rec.reason).toContain('retired');
  });

  it('returns a non-applicable result when salary end date has passed', () => {
    const seed = cloneSeed({ salaryEndDate: '2020-01-01' });
    const rec = buildPreRetirementOptimizerRecommendation({ seedData: seed }, AS_OF);
    expect(rec.applicable).toBe(false);
  });

  it('headline changes when plan is fully optimized', () => {
    // Set both contribution rates high enough to meet the limits.
    const seed = cloneSeed({
      preRetirementContributions: {
        employee401kPreTaxAnnualAmount: 31_500,
        employee401kRothPercentOfSalary: 0,
        hsaAnnualAmount: 9_550,
        hsaCoverageType: 'family',
      },
    });
    const rec = buildPreRetirementOptimizerRecommendation({ seedData: seed }, AS_OF);
    // No 401k / HSA shortfall action steps expected.
    const buckets = rec.actionSteps.map((step) => step.action);
    expect(buckets.every((action) => !action.includes('401(k) contribution'))).toBe(
      true,
    );
    expect(buckets.every((action) => !action.includes('HSA contribution'))).toBe(
      true,
    );
  });
});
