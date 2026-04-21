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
});
