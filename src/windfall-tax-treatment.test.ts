import { describe, expect, it } from 'vitest';
import { initialSeedData } from './data';
import type { MarketAssumptions, SeedData } from './types';
import { buildPathResults } from './utils';

const TEST_ASSUMPTIONS: MarketAssumptions = {
  equityMean: 0,
  equityVolatility: 0,
  internationalEquityMean: 0,
  internationalEquityVolatility: 0,
  bondMean: 0,
  bondVolatility: 0,
  cashMean: 0,
  cashVolatility: 0,
  inflation: 0,
  inflationVolatility: 0,
  simulationRuns: 8,
  irmaaThreshold: 200000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 18,
  guardrailCutPercent: 0.2,
  robPlanningEndAge: 90,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260421,
  assumptionsVersion: 'windfall-tax-test',
};

function cloneSeedData(data: SeedData) {
  return JSON.parse(JSON.stringify(data)) as SeedData;
}

function buildMinimalData() {
  const data = cloneSeedData(initialSeedData);
  data.income.salaryAnnual = 0;
  data.income.salaryEndDate = '2026-01-01';
  data.income.socialSecurity = [];
  data.spending.essentialMonthly = 0;
  data.spending.optionalMonthly = 0;
  data.spending.annualTaxesInsurance = 0;
  data.spending.travelEarlyRetirementAnnual = 0;
  data.accounts.cash.balance = 0;
  data.accounts.taxable.balance = 0;
  data.accounts.pretax.balance = 0;
  data.accounts.roth.balance = 0;
  if (data.accounts.hsa) {
    data.accounts.hsa.balance = 0;
  }
  return data;
}

describe('windfall tax treatment', () => {
  it('models primary home sale exclusion with taxable LTCG remainder', () => {
    const data = buildMinimalData();
    data.income.windfalls = [
      {
        name: 'home_sale',
        year: 2026,
        amount: 700_000,
        taxTreatment: 'primary_home_sale',
        costBasis: 100_000,
        exclusionAmount: 500_000,
      },
    ];

    const path = buildPathResults(data, TEST_ASSUMPTIONS, [], [], {
      pathMode: 'selected_only',
      strategyMode: 'planner_enhanced',
    })[0];
    const firstYear = path.yearlySeries.find((item) => item.year === 2026);

    expect(firstYear?.medianWindfallCashInflow).toBe(700_000);
    expect(firstYear?.medianWindfallOrdinaryIncome).toBe(0);
    expect(firstYear?.medianWindfallLtcgIncome).toBe(100_000);
  });

  it('spreads inherited IRA windfall as ordinary income over configured years', () => {
    const data = buildMinimalData();
    data.income.windfalls = [
      {
        name: 'inheritance',
        year: 2026,
        amount: 100_000,
        taxTreatment: 'inherited_ira_10y',
        distributionYears: 5,
      },
    ];

    const path = buildPathResults(data, TEST_ASSUMPTIONS, [], [], {
      pathMode: 'selected_only',
      strategyMode: 'planner_enhanced',
    })[0];
    const year2026 = path.yearlySeries.find((item) => item.year === 2026);
    const year2027 = path.yearlySeries.find((item) => item.year === 2027);

    expect(year2026?.medianWindfallCashInflow).toBe(20_000);
    expect(year2026?.medianWindfallOrdinaryIncome).toBe(20_000);
    expect(year2026?.medianWindfallLtcgIncome).toBe(0);
    expect(year2027?.medianWindfallOrdinaryIncome).toBe(20_000);
  });
});
