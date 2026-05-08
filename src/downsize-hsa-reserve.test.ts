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
  assumptionsVersion: 'downsize-hsa-reserve-test',
};

function cloneSeedData(data: SeedData) {
  return JSON.parse(JSON.stringify(data)) as SeedData;
}

function buildMinimalData() {
  const data = cloneSeedData(initialSeedData);
  data.income.salaryAnnual = 0;
  data.income.salaryEndDate = '2026-01-01';
  data.income.socialSecurity = [];
  data.income.preRetirementContributions = {};
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

describe('downsizing and HSA reserve modeling', () => {
  it('credits only net downsizing liquidity after replacement home and transaction costs', () => {
    const data = buildMinimalData();
    data.income.windfalls = [
      {
        name: 'home_sale',
        year: 2026,
        amount: 1_000_000,
        taxTreatment: 'primary_home_sale',
        costBasis: 500_000,
        exclusionAmount: 500_000,
        sellingCostPercent: 0.06,
        replacementHomeCost: 500_000,
        purchaseClosingCostPercent: 0.02,
        movingCost: 20_000,
        certainty: 'estimated',
        timingUncertaintyYears: 2,
        amountUncertaintyPercent: 0.3,
      },
    ];

    const path = buildPathResults(data, TEST_ASSUMPTIONS, [], [], {
      pathMode: 'selected_only',
      strategyMode: 'planner_enhanced',
    })[0];
    const firstYear = path.yearlySeries.find((item) => item.year === 2026);

    expect(firstYear?.medianHomeSaleGrossProceeds).toBe(1_000_000);
    expect(firstYear?.medianHomeSaleSellingCosts).toBe(60_000);
    expect(firstYear?.medianHomeReplacementPurchaseCost).toBe(530_000);
    expect(firstYear?.medianHomeDownsizeNetLiquidity).toBe(410_000);
    expect(firstYear?.medianWindfallCashInflow).toBe(410_000);
    expect(firstYear?.medianWindfallLtcgIncome).toBe(0);
  });

  it('preserves HSA for LTC reserve mode and reports remaining LTC exposure', () => {
    const data = buildMinimalData();
    if (!data.accounts.hsa) {
      throw new Error('Expected seed data to include an HSA account');
    }
    data.accounts.hsa.balance = 50_000;
    data.accounts.hsa.targetAllocation = { CASH: 1 };
    data.rules.hsaStrategy = {
      enabled: true,
      withdrawalMode: 'ltc_reserve',
      annualQualifiedExpenseWithdrawalCap: 250_000,
      prioritizeHighMagiYears: false,
    };
    data.rules.ltcAssumptions = {
      enabled: true,
      startAge: 62,
      annualCostToday: 40_000,
      durationYears: 2,
      inflationAnnual: 0,
      eventProbability: 1,
    };

    const path = buildPathResults(data, TEST_ASSUMPTIONS, [], [], {
      pathMode: 'selected_only',
      strategyMode: 'planner_enhanced',
    })[0];
    const firstYear = path.yearlySeries.find((item) => item.year === 2026);
    const secondYear = path.yearlySeries.find((item) => item.year === 2027);

    expect(firstYear?.medianLtcCost).toBe(40_000);
    expect(firstYear?.medianHsaOffsetUsed).toBe(40_000);
    expect(firstYear?.medianHsaLtcOffsetUsed).toBe(40_000);
    expect(firstYear?.medianLtcCostRemainingAfterHsa).toBe(0);
    expect(firstYear?.medianHsaBalance).toBe(10_000);

    expect(secondYear?.medianLtcCost).toBe(40_000);
    expect(secondYear?.medianHsaLtcOffsetUsed).toBe(10_000);
    expect(secondYear?.medianLtcCostRemainingAfterHsa).toBe(30_000);
    expect(secondYear?.medianHsaBalance).toBe(0);
  });
});
