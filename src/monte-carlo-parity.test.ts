import { describe, expect, it } from 'vitest';
import { initialSeedData } from './data';
import { buildPlanningStateExport } from './planning-export';
import type { MarketAssumptions, SeedData } from './types';
import {
  __testOnly_buildWithdrawalOrder,
  __testOnly_getGuardrailState,
  __testOnly_getSalaryForYear,
  __testOnly_getSocialSecurityIncome,
  __testOnly_getStressAdjustedReturns,
  buildPathResults,
} from './utils';
import {
  reproduceSimulationModeFromExport,
  runParityHarnessFromExport,
  runParityHarnessFromExportJson,
} from './monte-carlo-parity';

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
  simulationRuns: 60,
  irmaaThreshold: 200000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 18,
  guardrailCutPercent: 0.2,
  robPlanningEndAge: 90,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260418,
  assumptionsVersion: 'parity-targeted-test',
};

const cloneSeedData = (data: SeedData): SeedData => JSON.parse(JSON.stringify(data)) as SeedData;

describe('monte carlo parity targeted checks', () => {
  it('applies market_down stress overlays on equity and keeps cash stochastic', () => {
    const randomA = () => 0.15;
    const randomB = () => 0.85;
    const year1A = __testOnly_getStressAdjustedReturns(['market_down'], TEST_ASSUMPTIONS, 0, randomA);
    const year1B = __testOnly_getStressAdjustedReturns(['market_down'], TEST_ASSUMPTIONS, 0, randomB);

    expect(year1A.assetReturns.US_EQUITY).toBe(-0.18);
    expect(year1A.assetReturns.INTL_EQUITY).toBeCloseTo(-0.18);
    expect(year1A.marketState).toBe('down');
    expect(year1A.assetReturns.BONDS).not.toBe(year1B.assetReturns.BONDS);
    expect(year1A.assetReturns.CASH).not.toBe(year1B.assetReturns.CASH);
  });

  it('prorates salary in salary end year using month fraction', () => {
    const salary = __testOnly_getSalaryForYear(210000, '2027-07-15T00:00:00.000Z', 2027);
    expect(salary).toBeCloseTo(210000 * (6 / 12));
  });

  it('activates social security only after claim age is reached', () => {
    const noIncome = __testOnly_getSocialSecurityIncome(
      [{ person: 'rob', fraMonthly: 3000, claimAge: 67 }],
      2030,
      { rob: 66, debbie: 60 },
      1,
    );
    const startsIncome = __testOnly_getSocialSecurityIncome(
      [{ person: 'rob', fraMonthly: 3000, claimAge: 67 }],
      2031,
      { rob: 67, debbie: 61 },
      1,
    );
    expect(noIncome).toBe(0);
    expect(startsIncome).toBeGreaterThan(0);
  });

  it('applies and reverses guardrail cut state using funded years floor and ceiling', () => {
    const activated = __testOnly_getGuardrailState(true, 11.5, false, {
      floorYears: 12,
      ceilingYears: 18,
      cutPercent: 0.2,
    });
    expect(activated.optionalCutActive).toBe(true);
    expect(activated.cutMultiplier).toBe(0.8);

    const released = __testOnly_getGuardrailState(true, 18.5, true, {
      floorYears: 12,
      ceilingYears: 18,
      cutPercent: 0.2,
    });
    expect(released.optionalCutActive).toBe(false);
    expect(released.cutMultiplier).toBe(1);
  });

  it('reorders taxable vs pretax in planner mode during down markets based on defense score', () => {
    const order = __testOnly_buildWithdrawalOrder(
      'down',
      { plannerLogicActive: true, dynamicDefenseOrdering: true },
      { cash: 1000, taxable: 1000, pretax: 1000, roth: 1000 },
      {
        taxable: { SCHD: 1 },
        pretax: { BND: 1 },
      },
    );
    expect(order.slice(0, 3)).toEqual(['cash', 'pretax', 'taxable']);
  });

  it('applies windfalls by configured year into cashflow and deployment path', () => {
    const data = cloneSeedData(initialSeedData);
    data.income.salaryAnnual = 0;
    data.income.salaryEndDate = '2026-01-01T00:00:00.000Z';
    data.spending.essentialMonthly = 0;
    data.spending.optionalMonthly = 0;
    data.spending.annualTaxesInsurance = 0;
    data.spending.travelEarlyRetirementAnnual = 0;
    data.income.socialSecurity = data.income.socialSecurity.map((entry) => ({ ...entry, claimAge: 90 }));
    data.income.windfalls = [{ name: 'inheritance', year: 2027, amount: 120000 }];
    data.accounts = {
      ...data.accounts,
      pretax: { ...data.accounts.pretax, balance: 0 },
      roth: { ...data.accounts.roth, balance: 0 },
      taxable: { ...data.accounts.taxable, balance: 0 },
      cash: { ...data.accounts.cash, balance: 0 },
    };
    const assumptions = { ...TEST_ASSUMPTIONS, simulationRuns: 20, equityMean: 0, equityVolatility: 0, internationalEquityMean: 0, internationalEquityVolatility: 0, bondMean: 0, bondVolatility: 0, cashMean: 0, cashVolatility: 0 };
    const [path] = buildPathResults(data, assumptions, [], [], { pathMode: 'selected_only', strategyMode: 'raw_simulation' });
    const income2026 = path.yearlySeries.find((row) => row.year === 2026)?.medianIncome ?? 0;
    const year2027 = path.yearlySeries.find((row) => row.year === 2027);
    expect(income2026).toBe(0);
    expect(year2027?.medianIncome).toBe(0);
    expect(year2027?.medianWindfallCashInflow).toBe(120000);
    expect(year2027?.medianWindfallDeployedToTaxable).toBe(120000);
  });

  it('reproduces raw and planner modes from export payload with diagnostics', () => {
    const payload = buildPlanningStateExport({
      data: initialSeedData,
      assumptions: TEST_ASSUMPTIONS,
      selectedStressorIds: ['market_down'],
      selectedResponseIds: ['cut_spending', 'preserve_roth'],
    });
    const rawPath = reproduceSimulationModeFromExport(payload, 'raw_simulation');
    const plannerPath = reproduceSimulationModeFromExport(payload, 'planner_enhanced');
    const harness = runParityHarnessFromExport(payload);
    const fromJson = runParityHarnessFromExportJson(JSON.stringify(payload));

    expect(rawPath.simulationMode).toBe('raw_simulation');
    expect(plannerPath.simulationMode).toBe('planner_enhanced');
    expect(harness.rawSimulation.mode).toBe('raw_simulation');
    expect(harness.plannerEnhancedSimulation.mode).toBe('planner_enhanced');
    expect(harness.diagnostics.rawSimulation.parityAudit.length).toBeGreaterThan(0);
    expect(fromJson.rawSimulation.successRate).toBe(harness.rawSimulation.successRate);
  }, 12_000);

  it('replayed export path matches direct seeded run inputs without double-applying toggles', () => {
    const selectedStressors = ['layoff', 'market_down'];
    const selectedResponses = ['cut_spending', 'delay_retirement'];
    const payload = buildPlanningStateExport({
      data: initialSeedData,
      assumptions: TEST_ASSUMPTIONS,
      selectedStressorIds: selectedStressors,
      selectedResponseIds: selectedResponses,
    });

    const replayedPlanner = reproduceSimulationModeFromExport(payload, 'planner_enhanced');
    const [directPlanner] = buildPathResults(
      initialSeedData,
      TEST_ASSUMPTIONS,
      selectedStressors,
      selectedResponses,
      { pathMode: 'selected_only', strategyMode: 'planner_enhanced' },
    );

    expect(replayedPlanner.successRate).toBe(directPlanner.successRate);
    expect(replayedPlanner.medianEndingWealth).toBe(directPlanner.medianEndingWealth);
    expect(replayedPlanner.failureYearDistribution).toEqual(directPlanner.failureYearDistribution);
  }, 12_000);
});
