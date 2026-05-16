import { describe, expect, it } from 'vitest';
import { buildNorthStarBudgetFromPath } from './north-star-budget';
import type { PathResult } from './types';

function pathWithRows(
  rows: Array<{
    year: number;
    medianSpending: number;
    medianFederalTax: number;
    medianTotalCashOutflow: number;
  }>,
  medianEndingWealth = 2_500_000,
) {
  return {
    medianEndingWealth,
    yearlySeries: rows,
  } as unknown as PathResult;
}

function budgetFor(input: {
  path: PathResult;
  year: number;
  inflation?: number;
  legacyTarget?: number;
}) {
  return buildNorthStarBudgetFromPath({
    path: input.path,
    year: input.year,
    spendingPath: null,
    fallbackCoreAnnual: 90_000,
    fallbackTravelAnnual: 10_000,
    inflation: input.inflation ?? 0,
    legacyTarget: input.legacyTarget ?? 1_000_000,
  });
}

describe('north-star budget metamorphic properties', () => {
  it('higher future inflation does not increase the same nominal future budget in real terms', () => {
    const path = pathWithRows([
      {
        year: 2026,
        medianSpending: 100_000,
        medianFederalTax: 20_000,
        medianTotalCashOutflow: 120_000,
      },
      {
        year: 2030,
        medianSpending: 130_000,
        medianFederalTax: 30_000,
        medianTotalCashOutflow: 160_000,
      },
    ]);

    const lowInflation = budgetFor({ path, year: 2030, inflation: 0.02 });
    const highInflation = budgetFor({ path, year: 2030, inflation: 0.05 });

    expect(highInflation.totalAnnualBudget ?? 0).toBeLessThan(
      lowInflation.totalAnnualBudget ?? 0,
    );
    expect(highInflation.spendAndHealthAnnual ?? 0).toBeLessThan(
      lowInflation.spendAndHealthAnnual ?? 0,
    );
    expect(highInflation.federalTaxAnnual ?? 0).toBeLessThan(
      lowInflation.federalTaxAnnual ?? 0,
    );
  });

  it('higher trace cash outflow increases the north-star budget', () => {
    const lower = budgetFor({
      path: pathWithRows([
        {
          year: 2026,
          medianSpending: 100_000,
          medianFederalTax: 20_000,
          medianTotalCashOutflow: 120_000,
        },
      ]),
      year: 2026,
    });
    const higher = budgetFor({
      path: pathWithRows([
        {
          year: 2026,
          medianSpending: 115_000,
          medianFederalTax: 25_000,
          medianTotalCashOutflow: 140_000,
        },
      ]),
      year: 2026,
    });

    expect(higher.totalAnnualBudget ?? 0).toBeGreaterThan(
      lower.totalAnnualBudget ?? 0,
    );
    expect(higher.totalMonthlyBudget ?? 0).toBeGreaterThan(
      lower.totalMonthlyBudget ?? 0,
    );
  });

  it('changing the legacy target does not rewrite trace-derived spending evidence', () => {
    const path = pathWithRows([
      {
        year: 2026,
        medianSpending: 100_000,
        medianFederalTax: 20_000,
        medianTotalCashOutflow: 120_000,
      },
    ]);
    const lowerTarget = budgetFor({ path, year: 2026, legacyTarget: 500_000 });
    const higherTarget = budgetFor({ path, year: 2026, legacyTarget: 1_500_000 });

    expect(higherTarget.legacyTarget).toBe(1_500_000);
    expect(lowerTarget.totalAnnualBudget).toBe(higherTarget.totalAnnualBudget);
    expect(lowerTarget.totalMonthlyBudget).toBe(higherTarget.totalMonthlyBudget);
    expect(lowerTarget.medianEndingWealth).toBe(higherTarget.medianEndingWealth);
  });

  it('keeps annual and monthly budget values equivalent', () => {
    const budget = budgetFor({
      path: pathWithRows([
        {
          year: 2026,
          medianSpending: 100_000,
          medianFederalTax: 20_000,
          medianTotalCashOutflow: 120_000,
        },
      ]),
      year: 2026,
    });

    expect((budget.totalMonthlyBudget ?? 0) * 12).toBeCloseTo(
      budget.totalAnnualBudget ?? 0,
      6,
    );
  });
});
