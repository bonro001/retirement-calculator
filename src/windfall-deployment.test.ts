import { describe, expect, it } from 'vitest';
import { initialSeedData } from './data';
import type { MarketAssumptions, SeedData, WindfallEntry } from './types';
import { buildPathResults } from './utils';

const BASE_ASSUMPTIONS: MarketAssumptions = {
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
  simulationRuns: 1,
  irmaaThreshold: 200000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 18,
  guardrailCutPercent: 0.2,
  robPlanningEndAge: 90,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260514,
  assumptionsVersion: 'windfall-deployment-test',
};

function cloneSeed(): SeedData {
  return JSON.parse(JSON.stringify(initialSeedData)) as SeedData;
}

function buildMinimalSeed(windfall: WindfallEntry): SeedData {
  const data = cloneSeed();
  data.income.salaryAnnual = 0;
  data.income.salaryEndDate = '2026-01-01';
  data.income.socialSecurity = [];
  data.income.windfalls = [windfall];
  data.income.preRetirementContributions = {};
  data.spending.optionalMonthly = 0;
  data.spending.annualTaxesInsurance = 0;
  data.spending.travelEarlyRetirementAnnual = 0;
  data.accounts.cash.balance = 0;
  data.accounts.cash.targetAllocation = { CASH: 1 };
  data.accounts.taxable.balance = 0;
  data.accounts.taxable.targetAllocation = { VTI: 1 };
  data.accounts.pretax.balance = 0;
  data.accounts.pretax.targetAllocation = { VTI: 1 };
  data.accounts.pretax.sourceAccounts = [];
  data.accounts.roth.balance = 0;
  data.accounts.roth.targetAllocation = { VTI: 1 };
  if (data.accounts.hsa) {
    data.accounts.hsa.balance = 0;
  }
  data.rules.healthcarePremiums = {
    baselineAcaPremiumAnnual: 0,
    baselineMedicarePremiumAnnual: 0,
    medicalInflationAnnual: 0,
  };
  data.rules.hsaStrategy = { enabled: false };
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

describe('windfall deployment', () => {
  it('uses windfall cash once, then deploys only the unspent remainder', () => {
    const data = buildMinimalSeed({
      name: 'test_windfall',
      year: 2026,
      amount: 100_000,
      taxTreatment: 'cash_non_taxable',
    });
    data.spending.essentialMonthly = 50_000 / 12;

    const [path] = buildPathResults(data, BASE_ASSUMPTIONS, [], [], {
      pathMode: 'selected_only',
      strategyMode: 'planner_enhanced',
    });
    const firstYear = path.yearlySeries.find((item) => item.year === 2026);

    expect(firstYear?.medianWindfallCashInflow).toBe(100_000);
    expect(firstYear?.medianWithdrawalCash).toBe(50_000);
    expect(firstYear?.medianWindfallDeployedToTaxable).toBe(50_000);
    expect(firstYear?.medianWindfallInvestmentSleeveBalance).toBe(50_000);
    expect(firstYear?.medianCashBalance).toBe(0);
    expect(firstYear?.medianTaxableBalance).toBe(50_000);
    expect(firstYear?.medianAssets).toBe(50_000);
  });

  it('invests leftover windfall cash into the current invested mix', () => {
    const data = buildMinimalSeed({
      name: 'test_windfall',
      year: 2026,
      amount: 100_000,
      taxTreatment: 'cash_non_taxable',
    });
    data.spending.essentialMonthly = 0;
    data.accounts.pretax.balance = 100_000;
    data.accounts.pretax.targetAllocation = { VTI: 1 };

    const [path] = buildPathResults(
      data,
      { ...BASE_ASSUMPTIONS, equityMean: 0.1 },
      [],
      [],
      {
        pathMode: 'selected_only',
        strategyMode: 'planner_enhanced',
      },
    );
    const year2026 = path.yearlySeries.find((item) => item.year === 2026);
    const year2027 = path.yearlySeries.find((item) => item.year === 2027);

    expect(year2026?.medianWindfallDeployedToTaxable).toBe(100_000);
    expect(year2026?.medianWindfallInvestmentSleeveBalance).toBe(100_000);
    expect(year2026?.medianCashBalance).toBe(0);
    expect(year2026?.medianTaxableBalance).toBe(100_000);
    expect(year2027?.medianTaxableBalance).toBe(110_000);
    expect(year2027?.medianWindfallInvestmentSleeveBalance).toBe(110_000);
  });
});
