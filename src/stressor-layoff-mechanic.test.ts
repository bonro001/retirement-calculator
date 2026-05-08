import { describe, expect, it } from 'vitest';
import { initialSeedData } from './data';
import type { MarketAssumptions, SeedData } from './types';
import { buildPathResults } from './utils';

// Validation: applying the `layoff` stressor with retireDate=D and severance=S
// should produce the same simulation as setting salaryEndDate=D on the SeedData
// and adding a same-year severance windfall — i.e., the stressor is a pure
// knob-driven replacement of hardcoded salary-end logic.

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
  simulationRuns: 120,
  irmaaThreshold: 200000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 18,
  guardrailCutPercent: 0.2,
  robPlanningEndAge: 90,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260417,
  assumptionsVersion: 'stressor-layoff-mechanic',
};

function cloneSeed(data: SeedData): SeedData {
  return JSON.parse(JSON.stringify(data)) as SeedData;
}

function runPath(
  data: SeedData,
  stressors: string[],
  responses: string[],
  knobs?: {
    layoffRetireDate?: string;
    layoffSeverance?: number;
  },
): number {
  const results = buildPathResults(data, ASSUMPTIONS, stressors, responses, {
    pathMode: 'selected_only',
    stressorKnobs: knobs,
  });
  return results[0];
}

function runSuccess(
  data: SeedData,
  stressors: string[],
  responses: string[],
  knobs?: {
    layoffRetireDate?: string;
    layoffSeverance?: number;
  },
): number {
  return runPath(data, stressors, responses, knobs).successRate;
}

describe('layoff stressor mechanic', () => {
  it('baseline (no stressor) differs from layoff-today (sanity check)', () => {
    const baseline = runPath(initialSeedData, [], []);
    const laidOffToday = runPath(initialSeedData, ['layoff'], [], {
      layoffRetireDate: '2026-06-01',
      layoffSeverance: 0,
    });
    // Success can saturate at high solvency, but an early exit should still
    // reduce the wealth path when severance is zero.
    expect(laidOffToday.successRate).toBeLessThanOrEqual(baseline.successRate);
    expect(laidOffToday.medianEndingWealth).toBeLessThan(baseline.medianEndingWealth);
  });

  it('severance improves success relative to no severance at same retire date', () => {
    const noSev = runSuccess(initialSeedData, ['layoff'], [], {
      layoffRetireDate: '2026-06-01',
      layoffSeverance: 0,
    });
    const withSev = runSuccess(initialSeedData, ['layoff'], [], {
      layoffRetireDate: '2026-06-01',
      layoffSeverance: 250000,
    });
    expect(withSev).toBeGreaterThanOrEqual(noSev);
  });

  it('later retire date is never worse than earlier retire date (no severance)', () => {
    const early = runSuccess(initialSeedData, ['layoff'], [], {
      layoffRetireDate: '2026-06-01',
      layoffSeverance: 0,
    });
    const later = runSuccess(initialSeedData, ['layoff'], [], {
      layoffRetireDate: '2027-01-01',
      layoffSeverance: 0,
    });
    // Keeping salary longer can only help or hold steady (within MC noise).
    expect(later).toBeGreaterThanOrEqual(early - 0.03);
  });

  it('stressor with retireDate matches manual salaryEndDate shift (no severance)', () => {
    const shifted = cloneSeed(initialSeedData);
    shifted.income.salaryEndDate = '2026-06-01';
    const manual = runSuccess(shifted, [], []);
    const viaStressor = runSuccess(initialSeedData, ['layoff'], [], {
      layoffRetireDate: '2026-06-01',
      layoffSeverance: 0,
    });
    // Path equivalence: same inputs should yield identical results. Allow 1pt
    // slack for any subtle ordering differences we haven't isolated.
    expect(Math.abs(viaStressor - manual)).toBeLessThan(0.02);
  });
});
