import { describe, expect, it } from 'vitest';
import type {
  MonthlyReviewCertification,
  MonthlyReviewSpendingPathMetrics,
} from './monthly-review';
import type { PathResult } from './types';
import {
  buildNorthStarBudgetFromCertification,
  buildNorthStarBudgetFromPath,
  buildNorthStarBudgetSeriesFromPath,
} from './north-star-budget';

const spendingPath: MonthlyReviewSpendingPathMetrics = {
  valueBasis: 'today_dollars',
  scalarMeaning: 'core_annual_spend',
  policySpendScalarTodayDollars: 90_000,
  firstScheduleYear: 2027,
  retirementYear: 2027,
  firstModeledYearAnnualSpendTodayDollars: 104_000,
  firstRetirementYearAnnualSpendTodayDollars: 104_000,
  peakGoGoAnnualSpendTodayDollars: 104_000,
  peakGoGoYear: 2027,
  age75AnnualSpendTodayDollars: 95_000,
  age80AnnualSpendTodayDollars: 95_000,
  age85AnnualSpendTodayDollars: 95_000,
  lifetimeAverageAnnualSpendTodayDollars: 97_000,
  scheduleLifetimeSpendTodayDollars: 3_300_000,
  medianLifetimeSpendTodayDollars: 3_390_000,
  annualSpendRows: [
    {
      year: 2027,
      householdAge: 67,
      multiplier: 1,
      coreAnnualSpendTodayDollars: 90_000,
      travelAnnualSpendTodayDollars: 14_000,
      annualSpendTodayDollars: 104_000,
    },
  ],
};

function certWithRows(
  yearlyRows: Array<{ year: number; medianSpending: number; medianFederalTax: number }>,
): MonthlyReviewCertification {
  return {
    strategyId: 'current_faithful',
    verdict: 'green',
    certifiedAtIso: '2026-05-16T00:00:00.000Z',
    evaluation: {
      id: 'pol_test',
      policy: {
        annualSpendTodayDollars: 90_000,
        primarySocialSecurityClaimAge: 68,
        spouseSocialSecurityClaimAge: 67,
        rothConversionAnnualCeiling: 160_000,
        withdrawalRule: 'tax_bracket_waterfall',
      },
      outcome: {
        p50EndingWealthTodayDollars: 2_700_000,
      },
    },
    pack: {
      selectedPathEvidence: {
        outcome: {
          p50EndingWealthTodayDollars: 2_770_000,
        },
        yearlyRows,
      },
    },
  } as unknown as MonthlyReviewCertification;
}

describe('north star budget contract', () => {
  it('promotes total annual budget as the household-facing number', () => {
    const budget = buildNorthStarBudgetFromCertification({
      cert: certWithRows([
        { year: 2026, medianSpending: 97_000, medianFederalTax: 22_000 },
        { year: 2027, medianSpending: 126_000, medianFederalTax: 12_000 },
      ]),
      spendingPath,
      retirementYear: 2027,
      inflation: 0,
      legacyTarget: 1_000_000,
      fallbackTravelAnnual: 14_000,
    });

    expect(budget.totalAnnualBudget).toBe(138_000);
    expect(budget.totalMonthlyBudget).toBe(11_500);
    expect(budget.lifestyleAnnual).toBe(104_000);
    expect(budget.coreAnnual).toBe(90_000);
    expect(budget.travelAnnual).toBe(14_000);
    expect(budget.spendAndHealthAnnual).toBe(126_000);
    expect(budget.healthcareAndOtherAnnual).toBe(22_000);
    expect(budget.federalTaxAnnual).toBe(12_000);
    expect(budget.medianEndingWealth).toBe(2_770_000);
    expect(budget.protectedReserve).toMatchObject({
      targetTodayDollars: 1_000_000,
      purpose: 'care_first_legacy_if_unused',
      availableFor: 'late_life_care_or_health_shocks',
      normalLifestyleSpendable: false,
    });
  });

  it('keeps budget pending when certification has not produced trace rows', () => {
    const budget = buildNorthStarBudgetFromCertification({
      cert: certWithRows([]),
      spendingPath,
      retirementYear: 2027,
      inflation: 0,
      legacyTarget: 1_000_000,
      fallbackTravelAnnual: 14_000,
    });

    expect(budget.source).toBe('target_only');
    expect(budget.totalAnnualBudget).toBeNull();
    expect(budget.lifestyleAnnual).toBe(104_000);
  });

  it('builds the current-plan budget from a yearly engine path row', () => {
    const path = {
      medianEndingWealth: 2_500_000,
      yearlySeries: [
        {
          year: 2026,
          medianSpending: 95_000,
          medianFederalTax: 21_000,
          medianTotalCashOutflow: 116_000,
        },
        {
          year: 2027,
          medianSpending: 126_000,
          medianFederalTax: 12_000,
          medianTotalCashOutflow: 138_000,
        },
      ],
    } as unknown as PathResult;

    const budget = buildNorthStarBudgetFromPath({
      path,
      year: 2027,
      spendingPath: null,
      fallbackCoreAnnual: 90_000,
      fallbackTravelAnnual: 14_000,
      inflation: 0,
      legacyTarget: 1_000_000,
    });

    expect(budget.source).toBe('path_trace');
    expect(budget.year).toBe(2027);
    expect(budget.totalAnnualBudget).toBe(138_000);
    expect(budget.spendAndHealthAnnual).toBe(126_000);
    expect(budget.federalTaxAnnual).toBe(12_000);
    expect(budget.lifestyleAnnual).toBe(104_000);
    expect(budget.medianEndingWealth).toBe(2_500_000);
  });

  it('keeps current-plan and selected-policy traces on the same budget concept', () => {
    const certBudget = buildNorthStarBudgetFromCertification({
      cert: certWithRows([
        { year: 2027, medianSpending: 126_000, medianFederalTax: 12_000 },
      ]),
      spendingPath,
      retirementYear: 2027,
      inflation: 0,
      legacyTarget: 1_000_000,
      fallbackTravelAnnual: 14_000,
    });
    const pathBudget = buildNorthStarBudgetFromPath({
      path: {
        medianEndingWealth: 2_770_000,
        yearlySeries: [
          {
            year: 2027,
            medianSpending: 126_000,
            medianFederalTax: 12_000,
            medianTotalCashOutflow: 138_000,
          },
        ],
      } as unknown as PathResult,
      year: 2027,
      spendingPath,
      fallbackCoreAnnual: 90_000,
      fallbackTravelAnnual: 14_000,
      inflation: 0,
      legacyTarget: 1_000_000,
    });

    expect(certBudget.source).toBe('certification_trace');
    expect(pathBudget.source).toBe('path_trace');
    expect(certBudget.totalAnnualBudget).toBe(pathBudget.totalAnnualBudget);
    expect(certBudget.totalMonthlyBudget).toBe(pathBudget.totalMonthlyBudget);
    expect((certBudget.totalMonthlyBudget ?? 0) * 12).toBe(
      certBudget.totalAnnualBudget,
    );
    expect(certBudget.legacyTarget).toBe(1_000_000);
    expect(pathBudget.legacyTarget).toBe(1_000_000);
    expect(certBudget.protectedReserve.targetTodayDollars).toBe(1_000_000);
    expect(pathBudget.protectedReserve.targetTodayDollars).toBe(1_000_000);
    expect(certBudget.protectedReserve.purpose).toBe(
      'care_first_legacy_if_unused',
    );
    expect(certBudget.medianEndingWealth).toBeGreaterThan(
      certBudget.legacyTarget,
    );
    expect(pathBudget.medianEndingWealth).toBeGreaterThan(pathBudget.legacyTarget);
  });

  it('filters pre-target zero rows out of the spending curve series', () => {
    const path = {
      yearlySeries: [
        {
          year: 2026,
          medianSpending: 0,
          medianFederalTax: 0,
          medianTotalCashOutflow: 0,
        },
        {
          year: 2027,
          medianSpending: 126_000,
          medianFederalTax: 12_000,
          medianTotalCashOutflow: 138_000,
        },
      ],
    } as unknown as PathResult;

    const series = buildNorthStarBudgetSeriesFromPath({
      path,
      spendingPath,
      inflation: 0,
      legacyTarget: 1_000_000,
      medianEndingWealth: 2_770_000,
    });

    expect(series.map((row) => row.year)).toEqual([2027]);
    expect(series[0]?.totalAnnualBudget).toBe(138_000);
    expect(series[0]?.lifestyleAnnual).toBe(104_000);
  });
});
