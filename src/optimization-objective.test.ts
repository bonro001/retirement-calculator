import { describe, expect, it } from 'vitest';
import { initialSeedData } from './data';
import {
  computeTimeWeightedSpendingUtility,
  getAgeBandWeight,
  DEFAULT_TIME_PREFERENCE_WEIGHTS,
  scoreUtilityWithLegacyTarget,
} from './optimization-objective';
import { buildRetirementPlan } from './retirement-plan';
import type { MarketAssumptions } from './types';

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
  simulationSeed: 20260417,
  assumptionsVersion: 'objective-test',
};

describe('optimization objective helpers', () => {
  it('resolves age-band weights correctly', () => {
    expect(getAgeBandWeight(64, DEFAULT_TIME_PREFERENCE_WEIGHTS)).toBe(1.3);
    expect(getAgeBandWeight(74, DEFAULT_TIME_PREFERENCE_WEIGHTS)).toBe(1);
    expect(getAgeBandWeight(84, DEFAULT_TIME_PREFERENCE_WEIGHTS)).toBe(0.65);
  });

  it('gives higher utility to earlier spending when nominal dollars are equal', () => {
    const earlier = computeTimeWeightedSpendingUtility({
      agesByYear: [62, 63, 64],
      spendingByYear: [50_000, 50_000, 50_000],
      weights: DEFAULT_TIME_PREFERENCE_WEIGHTS,
    });
    const later = computeTimeWeightedSpendingUtility({
      agesByYear: [82, 83, 84],
      spendingByYear: [50_000, 50_000, 50_000],
      weights: DEFAULT_TIME_PREFERENCE_WEIGHTS,
    });

    expect(earlier).toBeGreaterThan(later);
  });

  it('round-trips optimization objective and weights through plan config/state', () => {
    const plan = buildRetirementPlan({
      data: initialSeedData,
      assumptions: TEST_ASSUMPTIONS,
      selectedStressors: [],
      selectedResponses: [],
      constraints: {
        doNotRetireLater: false,
        doNotSellHouse: false,
      },
      autopilotPolicy: {},
      withdrawalPolicy: {},
      targets: {
        optimizationObjective: 'maximize_time_weighted_spending',
        timePreferenceWeights: {
          goGo: 1.4,
          slowGo: 1.05,
          late: 0.6,
        },
      },
      irmaaPolicy: {},
    });

    expect(plan.targets.optimizationObjective).toBe('maximize_time_weighted_spending');
    expect(plan.targets.timePreferenceWeights).toEqual({
      goGo: 1.4,
      slowGo: 1.05,
      late: 0.6,
    });
  });

  it('scores ending wealth near legacy target better than far over target', () => {
    const nearTarget = scoreUtilityWithLegacyTarget({
      baseUtility: 1_000_000,
      legacyTargetTodayDollars: 1_000_000,
      projectedEndingWealthTodayDollars: 1_050_000,
    });
    const farOverTarget = scoreUtilityWithLegacyTarget({
      baseUtility: 1_000_000,
      legacyTargetTodayDollars: 1_000_000,
      projectedEndingWealthTodayDollars: 2_145_000,
    });

    expect(nearTarget.compositeScore).toBeGreaterThan(farOverTarget.compositeScore);
    expect(farOverTarget.overReservedAmount).toBeGreaterThan(nearTarget.overReservedAmount);
    expect(farOverTarget.overTargetPenalty).toBeGreaterThan(nearTarget.overTargetPenalty);
  });

  it('penalizes large over-target outcomes meaningfully', () => {
    const slightlyOver = scoreUtilityWithLegacyTarget({
      baseUtility: 100_000,
      legacyTargetTodayDollars: 1_000_000,
      projectedEndingWealthTodayDollars: 1_120_000,
    });
    const veryOver = scoreUtilityWithLegacyTarget({
      baseUtility: 100_000,
      legacyTargetTodayDollars: 1_000_000,
      projectedEndingWealthTodayDollars: 2_000_000,
    });

    expect(veryOver.overTargetPenalty).toBeGreaterThan(slightlyOver.overTargetPenalty);
    expect(veryOver.compositeScore).toBeLessThan(slightlyOver.compositeScore);
  });
});
