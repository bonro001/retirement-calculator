import { describe, expect, it } from 'vitest';
import { initialSeedData } from './data';
import { buildNorthStarBudgetFromPath } from './north-star-budget';
import type { SeedData } from './types';
import { buildPathResults } from './utils';
import { getDefaultVerificationAssumptions } from './verification-harness';

const ASSUMPTIONS = {
  ...getDefaultVerificationAssumptions(),
  simulationRuns: 80,
  simulationSeed: 246810,
  assumptionsVersion: 'north-star-golden-v1',
};

interface NorthStarGoldenScenario {
  id: string;
  mutateData?: (data: SeedData) => void;
  expected: {
    totalAnnualBudget: number;
    totalMonthlyBudget: number;
    spendAndHealthAnnual: number;
    federalTaxAnnual: number;
    lifestyleAnnual: number;
    legacyTarget: number;
    medianEndingWealth: number;
    successRate: number;
  };
}

const scenarios: NorthStarGoldenScenario[] = [
  {
    id: 'baseline-current-plan',
    expected: {
      totalAnnualBudget: 148694,
      totalMonthlyBudget: 12391.166666666666,
      spendAndHealthAnnual: 126279,
      federalTaxAnnual: 22415,
      lifestyleAnnual: 140587,
      legacyTarget: 1000000,
      medianEndingWealth: 2134368.7114177025,
      successRate: 0.825,
    },
  },
  {
    id: 'lower-spend-current-plan',
    mutateData: (data) => {
      data.spending.optionalMonthly = 3000;
    },
    expected: {
      totalAnnualBudget: 131462,
      totalMonthlyBudget: 10955.166666666666,
      spendAndHealthAnnual: 109047,
      federalTaxAnnual: 22415,
      lifestyleAnnual: 119047,
      legacyTarget: 1000000,
      medianEndingWealth: 4107215.6153828944,
      successRate: 0.9625,
    },
  },
];

describe('north-star golden scenarios', () => {
  for (const scenario of scenarios) {
    it(`${scenario.id} pins current-plan budget semantics`, () => {
      const data = structuredClone(initialSeedData);
      scenario.mutateData?.(data);
      const path = buildPathResults(data, ASSUMPTIONS, [], [], {
        pathMode: 'selected_only',
        strategyMode: 'planner_enhanced',
      })[0];
      const budget = buildNorthStarBudgetFromPath({
        path,
        year: 2026,
        spendingPath: null,
        fallbackCoreAnnual:
          data.spending.essentialMonthly * 12 +
          data.spending.optionalMonthly * 12 +
          data.spending.annualTaxesInsurance,
        fallbackTravelAnnual: data.spending.travelEarlyRetirementAnnual,
        inflation: ASSUMPTIONS.inflation,
        legacyTarget: data.goals?.legacyTargetTodayDollars ?? 1_000_000,
      });

      expect(budget.source).toBe('path_trace');
      expect(budget.year).toBe(2026);
      expect(budget.totalAnnualBudget).toBeCloseTo(
        scenario.expected.totalAnnualBudget,
        6,
      );
      expect(budget.totalMonthlyBudget).toBeCloseTo(
        scenario.expected.totalMonthlyBudget,
        6,
      );
      expect(budget.spendAndHealthAnnual).toBeCloseTo(
        scenario.expected.spendAndHealthAnnual,
        6,
      );
      expect(budget.federalTaxAnnual).toBeCloseTo(
        scenario.expected.federalTaxAnnual,
        6,
      );
      expect(budget.lifestyleAnnual).toBeCloseTo(
        scenario.expected.lifestyleAnnual,
        6,
      );
      expect(budget.legacyTarget).toBe(scenario.expected.legacyTarget);
      expect(budget.medianEndingWealth).toBeCloseTo(
        scenario.expected.medianEndingWealth,
        6,
      );
      expect(path.successRate).toBe(scenario.expected.successRate);
      expect(budget.medianEndingWealth ?? 0).toBeGreaterThan(
        budget.legacyTarget,
      );
      expect((budget.totalMonthlyBudget ?? 0) * 12).toBeCloseTo(
        budget.totalAnnualBudget ?? 0,
        6,
      );
    });
  }
});
