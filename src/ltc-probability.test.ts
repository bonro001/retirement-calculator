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
  simulationRuns: 16,
  irmaaThreshold: 200000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 18,
  guardrailCutPercent: 0.2,
  robPlanningEndAge: 90,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260421,
  assumptionsVersion: 'ltc-probability-test',
};

function cloneSeedData(data: SeedData) {
  return JSON.parse(JSON.stringify(data)) as SeedData;
}

function buildBaseData() {
  const data = cloneSeedData(initialSeedData);
  data.income.salaryAnnual = 0;
  data.income.salaryEndDate = '2026-01-01';
  data.income.socialSecurity = [];
  data.spending.essentialMonthly = 0;
  data.spending.optionalMonthly = 0;
  data.spending.annualTaxesInsurance = 0;
  data.spending.travelEarlyRetirementAnnual = 0;
  data.rules.hsaStrategy = {
    enabled: false,
  };
  data.rules.ltcAssumptions = {
    enabled: true,
    startAge: 62,
    annualCostToday: 10_000,
    durationYears: 2,
    inflationAnnual: 0,
    eventProbability: 1,
  };
  return data;
}

describe('LTC probability modeling', () => {
  it('applies LTC cost only across the configured probability share of runs', () => {
    const alwaysData = buildBaseData();
    alwaysData.rules.ltcAssumptions = {
      ...alwaysData.rules.ltcAssumptions!,
      eventProbability: 1,
    };
    const neverData = buildBaseData();
    neverData.rules.ltcAssumptions = {
      ...neverData.rules.ltcAssumptions!,
      eventProbability: 0,
    };

    const alwaysPath = buildPathResults(alwaysData, TEST_ASSUMPTIONS, [], [], {
      pathMode: 'selected_only',
      strategyMode: 'planner_enhanced',
    })[0];
    const neverPath = buildPathResults(neverData, TEST_ASSUMPTIONS, [], [], {
      pathMode: 'selected_only',
      strategyMode: 'planner_enhanced',
    })[0];

    const year = 2026;
    const alwaysLtc = alwaysPath.yearlySeries.find((item) => item.year === year)?.medianLtcCost ?? 0;
    const neverLtc = neverPath.yearlySeries.find((item) => item.year === year)?.medianLtcCost ?? 0;

    expect(alwaysLtc).toBe(10_000);
    expect(neverLtc).toBe(0);
  });

  it('exposes LTC incidence, cost percentiles, and deterministic HSA audit traces', () => {
    const data = buildBaseData();
    if (!data.accounts.hsa) {
      throw new Error('Expected seed data to include an HSA account');
    }
    data.accounts.hsa.balance = 15_000;
    data.rules.hsaStrategy = {
      enabled: true,
      withdrawalMode: 'ltc_reserve',
      annualQualifiedExpenseWithdrawalCap: 250_000,
      prioritizeHighMagiYears: false,
    };
    data.rules.ltcAssumptions = {
      ...data.rules.ltcAssumptions!,
      annualCostToday: 10_000,
      durationYears: 2,
      eventProbability: 0.5,
    };

    const path = buildPathResults(data, TEST_ASSUMPTIONS, [], [], {
      pathMode: 'selected_only',
      strategyMode: 'planner_enhanced',
    })[0];

    const diagnostics = path.ltcHsaDiagnostics;
    expect(diagnostics).toBeDefined();
    expect(diagnostics!.monteCarlo.ltcEventIncidenceRate).toBeGreaterThan(0);
    expect(diagnostics!.monteCarlo.ltcEventIncidenceRate).toBeLessThan(1);
    expect(diagnostics!.monteCarlo.totalLtcCostPercentiles.p90).toBeGreaterThan(0);
    expect(diagnostics!.monteCarlo.totalLtcCostRemainingAfterHsaPercentiles.p90).toBe(5_000);

    const firstYearVisibility = path.yearlySeries.find((item) => item.year === 2026)
      ?.ltcHsaPathVisibility;
    expect(firstYearVisibility?.ltcEventTriggeredRate).toBe(
      diagnostics!.monteCarlo.ltcEventIncidenceRate,
    );
    expect(firstYearVisibility?.ltcCostPercentiles.p90).toBe(10_000);
    expect(firstYearVisibility?.hsaLtcOffsetUsedPercentiles.p90).toBe(10_000);

    const noEventFirstYear = diagnostics!.deterministicAudit.noEvent[0];
    const withEventFirstYear = diagnostics!.deterministicAudit.withEvent[0];
    const expectedFirstYear = diagnostics!.deterministicAudit.expectedValue[0];
    expect(noEventFirstYear.ltcCost).toBe(0);
    expect(withEventFirstYear.ltcCost).toBe(10_000);
    expect(withEventFirstYear.hsaBalanceEnd).toBe(5_000);
    expect(expectedFirstYear.ltcCost).toBe(5_000);
    expect(expectedFirstYear.hsaBalanceEnd).toBe(10_000);
  });
});
