/**
 * Windfall growth model: when a `WindfallEntry` carries
 * `presentValueGrowthRate`, the engine should compound the entered
 * (today's-dollar) amount up to the year of arrival before crediting,
 * to model funds that are invested elsewhere while waiting to land.
 */
import { describe, expect, it } from 'vitest';
import { buildPathResults } from './utils';
import type { MarketAssumptions, SeedData, WindfallEntry } from './types';
import { initialSeedData } from './data';

const TEST_ASSUMPTIONS: MarketAssumptions = {
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
  simulationRuns: 80,
  irmaaThreshold: 200000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 18,
  guardrailCutPercent: 0.2,
  robPlanningEndAge: 90,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260504,
  assumptionsVersion: 'windfall-growth-test',
};

const cloneSeed = (seed: SeedData): SeedData =>
  JSON.parse(JSON.stringify(seed)) as SeedData;

function buildSeed(extraWindfall: WindfallEntry): SeedData {
  const base = cloneSeed(initialSeedData);
  base.income.windfalls = [extraWindfall];
  return base;
}

describe('windfall growth model', () => {
  it('engine credits a non-grown amount when presentValueGrowthRate is undefined', () => {
    const targetYear = new Date().getFullYear() + 5;
    const data = buildSeed({
      name: 'gift_no_growth',
      year: targetYear,
      amount: 20_000,
      taxTreatment: 'cash_non_taxable',
    });
    const [path] = buildPathResults(data, TEST_ASSUMPTIONS, [], []);
    const yearEntry = path.yearlySeries.find(
      (entry) => entry.year === targetYear,
    );
    expect(yearEntry).toBeDefined();
    expect(yearEntry!.medianWindfallCashInflow).toBeCloseTo(20_000, -2);
  });

  it('engine compounds amount by (1 + rate)^years when growth rate is set', () => {
    const yearsAhead = 5;
    const targetYear = new Date().getFullYear() + yearsAhead;
    const rate = 0.04;
    const expected = 20_000 * (1 + rate) ** yearsAhead;
    const data = buildSeed({
      name: 'gift_with_growth',
      year: targetYear,
      amount: 20_000,
      taxTreatment: 'cash_non_taxable',
      presentValueGrowthRate: rate,
    });
    const [path] = buildPathResults(data, TEST_ASSUMPTIONS, [], []);
    const yearEntry = path.yearlySeries.find(
      (entry) => entry.year === targetYear,
    );
    expect(yearEntry).toBeDefined();
    // Loose tolerance — windfall cash flows through trial-aggregation
    // (median across runs); for a single deterministic windfall in the
    // year it lands the median should equal the grown amount within
    // floating-point noise.
    expect(yearEntry!.medianWindfallCashInflow).toBeCloseTo(expected, -2);
  });

  it('zero growth rate is equivalent to undefined (no compounding)', () => {
    const targetYear = new Date().getFullYear() + 5;
    const data = buildSeed({
      name: 'gift_zero_growth',
      year: targetYear,
      amount: 20_000,
      taxTreatment: 'cash_non_taxable',
      presentValueGrowthRate: 0,
    });
    const [path] = buildPathResults(data, TEST_ASSUMPTIONS, [], []);
    const yearEntry = path.yearlySeries.find(
      (entry) => entry.year === targetYear,
    );
    expect(yearEntry).toBeDefined();
    expect(yearEntry!.medianWindfallCashInflow).toBeCloseTo(20_000, -2);
  });
});
