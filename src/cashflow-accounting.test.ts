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
  simulationSeed: 20260507,
  assumptionsVersion: 'cashflow-accounting-test',
};

function cloneSeedData(data: SeedData) {
  return JSON.parse(JSON.stringify(data)) as SeedData;
}

function buildCashflowData() {
  const data = cloneSeedData(initialSeedData);
  data.income.salaryAnnual = 100_000;
  data.income.salaryEndDate = '2027-01-01';
  data.income.socialSecurity = [];
  data.income.windfalls = [];
  data.income.preRetirementContributions = {};
  data.spending.essentialMonthly = 50_000 / 12;
  data.spending.optionalMonthly = 0;
  data.spending.annualTaxesInsurance = 0;
  data.spending.travelEarlyRetirementAnnual = 0;
  data.accounts.cash.balance = 10_000;
  data.accounts.cash.targetAllocation = { CASH: 1 };
  data.accounts.taxable.balance = 0;
  data.accounts.pretax.balance = 0;
  data.accounts.pretax.sourceAccounts = [];
  data.accounts.roth.balance = 0;
  if (data.accounts.hsa) {
    data.accounts.hsa.balance = 0;
  }
  data.rules.healthcarePremiums = {
    baselineAcaPremiumAnnual: 0,
    baselineMedicarePremiumAnnual: 0,
    medicalInflationAnnual: 0,
  };
  data.rules.hsaStrategy = {
    enabled: false,
  };
  data.rules.ltcAssumptions = {
    enabled: false,
    startAge: 85,
    annualCostToday: 0,
    durationYears: 0,
    inflationAnnual: 0,
    eventProbability: 0,
  };
  return data;
}

describe('cashflow accounting', () => {
  it('credits working-year wage surplus to cash instead of forcing a tax withdrawal', () => {
    const path = buildPathResults(buildCashflowData(), TEST_ASSUMPTIONS, [], [], {
      pathMode: 'selected_only',
      strategyMode: 'planner_enhanced',
    })[0];
    const firstYear = path.yearlySeries.find((item) => item.year === 2026);

    expect(firstYear?.medianIncome).toBe(100_000);
    expect(firstYear?.medianWithdrawalTotal).toBe(0);
    expect(firstYear?.medianUnresolvedFundingGap).toBe(0);
    expect(firstYear?.medianCashBalance).toBeCloseTo(
      10_000 +
        firstYear!.medianIncome -
        firstYear!.medianSpending -
        firstYear!.medianFederalTax,
      0,
    );
    expect(firstYear?.cashflowReconciliation).toEqual(
      expect.objectContaining({
        method: 'median_year_cashflow_components',
        totalAvailableForOutflows: firstYear!.medianIncome + firstYear!.medianWithdrawalTotal,
        unresolvedFundingGap: 0,
      }),
    );
    expect(
      firstYear!.cashflowReconciliation!.equationCheck
        .availableMinusOutflowsMinusSurplusOrGap,
    ).toBe(0);
  });
});
