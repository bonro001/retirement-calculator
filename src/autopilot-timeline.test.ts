import { describe, expect, it, vi } from 'vitest';
import { classifyAcaBridgeBreach, generateAutopilotPlan } from './autopilot-timeline';
import { initialSeedData } from './data';
import type { MarketAssumptions } from './types';
import { getRetirementHorizonYears } from './utils';

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
  simulationRuns: 80,
  irmaaThreshold: 200000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 18,
  guardrailCutPercent: 0.2,
  robPlanningEndAge: 90,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260417,
  assumptionsVersion: 'autopilot-test',
};

vi.setConfig({ testTimeout: 30_000 });

function buildInput() {
  return {
    data: initialSeedData,
    assumptions: TEST_ASSUMPTIONS,
    selectedStressors: ['market_down'],
    selectedResponses: ['cut_spending'],
    targetLegacyTodayDollars: 1_000_000,
    minSuccessRate: 0.8,
    doNotSellPrimaryResidence: false,
    solverRuntimeBudget: {
      searchSimulationRuns: 12,
      finalSimulationRuns: 20,
      maxIterations: 8,
      diagnosticsMode: 'core' as const,
      enableSuccessRelaxationProbe: false,
    },
  };
}

function cloneSeedData() {
  return structuredClone(initialSeedData);
}

describe('autopilot-timeline', () => {
  it('generates timeline for the full planning horizon', () => {
    const plan = generateAutopilotPlan(buildInput());
    const expectedYears = getRetirementHorizonYears(initialSeedData, TEST_ASSUMPTIONS) + 1;

    expect(plan.years).toHaveLength(expectedYears);
    expect(plan.years[0]?.year).toBe(2026);
  });

  it('includes required fields and explanation for each year', () => {
    const plan = generateAutopilotPlan(buildInput());
    const sampleYear = plan.years[Math.floor(plan.years.length / 2)];

    expect(sampleYear.plannedAnnualSpend).toBeGreaterThanOrEqual(0);
    expect(sampleYear.withdrawalCash).toBeGreaterThanOrEqual(0);
    expect(sampleYear.withdrawalTaxable).toBeGreaterThanOrEqual(0);
    expect(sampleYear.withdrawalIra401k).toBeGreaterThanOrEqual(0);
    expect(sampleYear.withdrawalRoth).toBeGreaterThanOrEqual(0);
    expect(sampleYear.suggestedRothConversion).toBeGreaterThanOrEqual(0);
    expect(sampleYear.estimatedMAGI).toBeGreaterThanOrEqual(0);
    expect(sampleYear.estimatedFederalTax).toBeGreaterThanOrEqual(0);
    expect(sampleYear.primaryBindingConstraint.length).toBeGreaterThan(0);
    expect(sampleYear.bindingConstraintExplanation.length).toBeGreaterThan(0);
    expect(sampleYear.tradeoffChosen.length).toBeGreaterThan(0);
    expect(sampleYear.tradeoffs.length).toBeGreaterThan(0);
    expect(sampleYear.diagnostics.primaryFundingSource.length).toBeGreaterThan(0);
    expect(sampleYear.diagnostics.bindingConstraint.length).toBeGreaterThan(0);
    expect(Array.isArray(sampleYear.diagnostics.warningFlags)).toBe(true);
    expect(Array.isArray(sampleYear.diagnostics.explanationTags)).toBe(true);
    expect(sampleYear.explanation.length).toBeGreaterThan(0);
  });

  it('changes behavior when house sale is disabled', () => {
    const allowsSale = generateAutopilotPlan({
      ...buildInput(),
      doNotSellPrimaryResidence: false,
      targetLegacyTodayDollars: 1_200_000,
      minSuccessRate: 0.85,
    });
    const blocksSale = generateAutopilotPlan({
      ...buildInput(),
      doNotSellPrimaryResidence: true,
      targetLegacyTodayDollars: 1_200_000,
      minSuccessRate: 0.85,
    });

    expect(blocksSale.spendSolver.recommendedAnnualSpend).toBeLessThanOrEqual(
      allowsSale.spendSolver.recommendedAnnualSpend,
    );
    expect(
      blocksSale.years.some((year) => year.explanation.includes('House retained')),
    ).toBe(true);
  });

  it('uses taxable before IRA in pre-65 retirement years when appropriate', () => {
    const data = cloneSeedData();
    data.income.salaryEndDate = '2026-01-01T00:00:00.000Z';
    data.income.socialSecurity = data.income.socialSecurity.map((entry) => ({
      ...entry,
      claimAge: 70,
    }));
    data.income.windfalls = [];
    data.accounts.cash.balance = 5_000;
    data.accounts.taxable.balance = 220_000;
    data.accounts.roth.balance = 0;
    data.accounts.pretax.balance = 500_000;
    data.accounts.hsa = {
      balance: 0,
      targetAllocation: { CASH: 1 },
    };
    data.spending.essentialMonthly = 9_000;
    data.spending.optionalMonthly = 3_000;

    const plan = generateAutopilotPlan({
      ...buildInput(),
      data,
      selectedStressors: [],
      selectedResponses: [],
      minSuccessRate: 0.7,
      targetLegacyTodayDollars: 250_000,
    });
    const taxableBeforeIraYear = plan.years.find(
      (year) =>
        year.regime === 'aca_bridge' &&
        year.robAge < 65 &&
        year.withdrawalTaxable > 0 &&
        year.withdrawalIra401k <= 1,
    );

    expect(taxableBeforeIraYear).toBeTruthy();
  });

  it('populates top summary fields', () => {
    const plan = generateAutopilotPlan(buildInput());

    expect(plan.summary.successRate).toBeGreaterThanOrEqual(0);
    expect(plan.summary.projectedLegacyOutcomeTodayDollars).toBeGreaterThanOrEqual(0);
    expect(plan.summary.bindingConstraint.length).toBeGreaterThan(0);
    expect(plan.summary.primaryBindingConstraint.length).toBeGreaterThan(0);
    expect(plan.summary.bindingConstraintDescription.length).toBeGreaterThan(0);
    expect(plan.summary.whatThisMeans.length).toBeGreaterThan(0);
    expect(plan.summary.tradeoffs.length).toBeGreaterThan(0);
    expect(plan.summary.routeSummary.length).toBeGreaterThan(0);
    expect(plan.summary.tradeoffSummary.length).toBeGreaterThan(0);
    expect(plan.diagnostics.totalAcaBridgeYears).toBeGreaterThanOrEqual(0);
    expect(plan.diagnostics.acaSafeYears).toBeGreaterThanOrEqual(0);
    expect(plan.diagnostics.acaBreachYears).toBeGreaterThanOrEqual(0);
    expect(plan.diagnostics.avoidableAcaBreachYears).toBeGreaterThanOrEqual(0);
    expect(plan.diagnostics.irmaaSurchargeYears).toBeGreaterThanOrEqual(0);
    expect(plan.diagnostics.yearsWithRothConversions).toBeGreaterThanOrEqual(0);
    expect(plan.diagnostics.yearsWithRmds).toBeGreaterThanOrEqual(0);
    expect(plan.diagnostics.yearsFundedPrimarilyByCash).toBeGreaterThanOrEqual(0);
    expect(plan.diagnostics.yearsFundedPrimarilyByTaxable).toBeGreaterThanOrEqual(0);
    expect(plan.diagnostics.yearsFundedPrimarilyByIra401k).toBeGreaterThanOrEqual(0);
    expect(plan.diagnostics.yearsFundedPrimarilyByRoth).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(plan.diagnostics.warningFlags)).toBe(true);
  });

  it('avoids ACA breach in bridge years when feasible', () => {
    const data = cloneSeedData();
    data.income.salaryEndDate = '2026-01-01T00:00:00.000Z';
    data.income.socialSecurity = data.income.socialSecurity.map((entry) => ({
      ...entry,
      claimAge: 70,
    }));
    data.income.windfalls = [];
    data.accounts.cash.balance = 420_000;
    data.accounts.taxable.balance = 120_000;
    data.accounts.roth.balance = 280_000;
    data.accounts.pretax.balance = 450_000;
    data.accounts.hsa = {
      balance: 0,
      targetAllocation: { CASH: 1 },
    };
    data.spending.essentialMonthly = 6_000;
    data.spending.optionalMonthly = 2_000;
    data.spending.travelEarlyRetirementAnnual = 4_000;

    const plan = generateAutopilotPlan({
      ...buildInput(),
      data,
      selectedStressors: [],
      selectedResponses: [],
      minSuccessRate: 0.7,
      targetLegacyTodayDollars: 300_000,
    });

    const bridgeYears = plan.years.filter((year) => year.regime === 'aca_bridge');
    expect(bridgeYears.length).toBeGreaterThan(1);
    expect(
      bridgeYears.every(
        (year) =>
          year.estimatedMAGI <= (year.acaFriendlyMagiCeiling ?? Number.POSITIVE_INFINITY) + 1,
      ),
    ).toBe(true);
    expect(
      bridgeYears.every((year) => year.explanationFlags.includes('preserved_aca_subsidy')),
    ).toBe(true);
  });

  it('reports ACA bridge MAGI trace and does not accept conversions across the cliff', () => {
    const data = cloneSeedData();
    data.income.salaryEndDate = '2026-01-01T00:00:00.000Z';
    data.income.socialSecurity = data.income.socialSecurity.map((entry) => ({
      ...entry,
      claimAge: 70,
    }));
    data.income.windfalls = [];
    data.accounts.cash.balance = 180_000;
    data.accounts.taxable.balance = 140_000;
    data.accounts.roth.balance = 40_000;
    data.accounts.pretax.balance = 1_100_000;
    data.accounts.hsa = {
      balance: 0,
      targetAllocation: { CASH: 1 },
    };
    data.spending.essentialMonthly = 5_000;
    data.spending.optionalMonthly = 2_000;
    data.spending.travelEarlyRetirementAnnual = 0;

    const plan = generateAutopilotPlan({
      ...buildInput(),
      data,
      selectedStressors: [],
      selectedResponses: [],
      minSuccessRate: 0.75,
      targetLegacyTodayDollars: 400_000,
    });
    const bridgeYears = plan.years.filter((year) => year.regime === 'aca_bridge');

    expect(bridgeYears.length).toBeGreaterThan(0);
    for (const year of bridgeYears) {
      expect(year.acaBridgeTrace).toBeDefined();
      const trace = year.acaBridgeTrace!;
      expect(trace.magiAfterPayroll).toBeLessThanOrEqual(trace.magiBeforePayroll + 0.01);
      expect(trace.magiAfterWithdrawals).toBeCloseTo(year.estimatedMAGI, 2);
      expect(trace.acaFriendlyMagiCeiling).toBe(year.acaFriendlyMagiCeiling);
      expect(trace.conversionAcceptedAcrossAcaCliff).toBe(false);
      if (year.suggestedRothConversion > 0 && trace.acaFriendlyMagiCeiling !== null) {
        expect(trace.magiAfterRothConversion).toBeLessThanOrEqual(
          trace.acaFriendlyMagiCeiling + 0.01,
        );
      }
    }
  });

  it('spreads Roth conversions across ACA bridge years', () => {
    const data = cloneSeedData();
    data.income.salaryEndDate = '2026-01-01T00:00:00.000Z';
    data.income.socialSecurity = data.income.socialSecurity.map((entry) => ({
      ...entry,
      claimAge: 70,
    }));
    data.income.windfalls = [];
    data.accounts.cash.balance = 180_000;
    data.accounts.taxable.balance = 140_000;
    data.accounts.roth.balance = 40_000;
    data.accounts.pretax.balance = 1_100_000;
    data.accounts.hsa = {
      balance: 0,
      targetAllocation: { CASH: 1 },
    };

    const plan = generateAutopilotPlan({
      ...buildInput(),
      data,
      selectedStressors: [],
      selectedResponses: [],
      minSuccessRate: 0.75,
      targetLegacyTodayDollars: 400_000,
    });
    const bridgeYears = plan.years.filter((year) => year.regime === 'aca_bridge');
    const conversionYears = bridgeYears.filter((year) => year.suggestedRothConversion > 0);

    expect(bridgeYears.length).toBeGreaterThan(1);
    expect(conversionYears.length).toBeGreaterThan(1);
  });

  it('flags avoidable vs unavoidable ACA breaches', () => {
    const unavoidableData = cloneSeedData();
    unavoidableData.income.salaryAnnual = 600_000;
    unavoidableData.income.salaryEndDate = '2026-03-01T00:00:00.000Z';
    unavoidableData.income.socialSecurity = unavoidableData.income.socialSecurity.map((entry) => ({
      ...entry,
      claimAge: 70,
    }));
    unavoidableData.income.windfalls = [];
    unavoidableData.accounts.cash.balance = 25_000;
    unavoidableData.accounts.taxable.balance = 20_000;
    unavoidableData.accounts.roth.balance = 5_000;
    unavoidableData.accounts.pretax.balance = 0;
    unavoidableData.accounts.hsa = {
      balance: 0,
      targetAllocation: { CASH: 1 },
    };
    unavoidableData.spending.essentialMonthly = 4_000;
    unavoidableData.spending.optionalMonthly = 1_000;

    const unavoidablePlan = generateAutopilotPlan({
      ...buildInput(),
      data: unavoidableData,
      selectedStressors: [],
      selectedResponses: [],
      minSuccessRate: 0.65,
      targetLegacyTodayDollars: 0,
    });

    const avoidableClassification = classifyAcaBridgeBreach({
      estimatedMagi: 95_000,
      acaFriendlyMagiCeiling: 82_000,
      baselineMagi: 55_000,
      rmdAmount: 0,
      lowMagiFundingCapacityAtStart: 35_000,
    });
    expect(avoidableClassification).toBe('avoidable_aca_breach');
    expect(
      unavoidablePlan.years.some((year) =>
        year.explanationFlags.includes('unavoidable_aca_breach'),
      ),
    ).toBe(true);
  });

  it('handles tight-income ACA bridge scenarios deterministically', () => {
    const data = cloneSeedData();
    data.income.salaryEndDate = '2026-01-01T00:00:00.000Z';
    data.income.socialSecurity = data.income.socialSecurity.map((entry) => ({
      ...entry,
      claimAge: 70,
    }));
    data.income.windfalls = [];
    data.accounts.cash.balance = 3_000;
    data.accounts.taxable.balance = 2_000;
    data.accounts.roth.balance = 1_500;
    data.accounts.pretax.balance = 70_000;
    data.accounts.hsa = {
      balance: 0,
      targetAllocation: { CASH: 1 },
    };
    data.spending.essentialMonthly = 11_000;
    data.spending.optionalMonthly = 5_000;

    const input = {
      ...buildInput(),
      data,
      selectedStressors: [],
      selectedResponses: [],
      minSuccessRate: 0.6,
      targetLegacyTodayDollars: 0,
    };
    const planA = generateAutopilotPlan(input);
    const planB = generateAutopilotPlan(input);
    const bridgeYears = planA.years.filter((year) => year.regime === 'aca_bridge');

    expect(bridgeYears.length).toBeGreaterThan(0);
    expect(
      bridgeYears.every(
        (year) =>
          Number.isFinite(year.estimatedMAGI) &&
          Number.isFinite(year.plannedAnnualSpend) &&
          year.explanation.length > 0,
      ),
    ).toBe(true);
    expect(planB.years[0]?.plannedAnnualSpend).toBe(planA.years[0]?.plannedAnnualSpend);
  });

  it('identifies legacy target as a binding plan-level constraint in high-legacy scenarios', () => {
    const plan = generateAutopilotPlan({
      ...buildInput(),
      selectedStressors: [],
      selectedResponses: [],
      targetLegacyTodayDollars: 2_100_000,
      minSuccessRate: 0.4,
      spendingFloorAnnual: 0,
    });

    expect(
      plan.summary.primaryBindingConstraint === 'legacy_target' ||
        plan.summary.supportingConstraints.includes('legacy_target'),
    ).toBe(true);
  });

  it('identifies ACA headroom as a year-level binding constraint in bridge years', () => {
    const data = cloneSeedData();
    data.income.salaryEndDate = '2026-01-01T00:00:00.000Z';
    data.income.socialSecurity = data.income.socialSecurity.map((entry) => ({
      ...entry,
      claimAge: 70,
    }));
    data.income.windfalls = [];
    data.accounts.cash.balance = 20_000;
    data.accounts.taxable.balance = 300_000;
    data.accounts.roth.balance = 20_000;
    data.accounts.pretax.balance = 900_000;
    data.spending.essentialMonthly = 14_000;
    data.spending.optionalMonthly = 8_000;

    const plan = generateAutopilotPlan({
      ...buildInput(),
      data,
      selectedStressors: [],
      selectedResponses: [],
      targetLegacyTodayDollars: 200_000,
      minSuccessRate: 0.65,
    });

    expect(
      plan.years.some((year) => year.tradeoffs.some((item) => item.category === 'aca_headroom')),
    ).toBe(true);
  });

  it('identifies IRMAA headroom as a binding constraint in Medicare years', () => {
    const data = cloneSeedData();
    data.household.robBirthDate = '1955-12-08';
    data.household.debbieBirthDate = '1954-10-23';
    data.income.salaryAnnual = 450_000;
    data.income.salaryEndDate = '2026-06-01T00:00:00.000Z';
    data.income.socialSecurity = data.income.socialSecurity.map((entry) => ({
      ...entry,
      claimAge: 70,
    }));
    data.income.windfalls = [];
    data.accounts.pretax.balance = 1_200_000;
    data.accounts.taxable.balance = 100_000;
    data.accounts.cash.balance = 20_000;
    data.accounts.roth.balance = 40_000;

    const plan = generateAutopilotPlan({
      ...buildInput(),
      data,
      selectedStressors: [],
      selectedResponses: [],
      targetLegacyTodayDollars: 300_000,
      minSuccessRate: 0.6,
    });

    expect(
      plan.years.some((year) =>
        year.tradeoffs.some((item) => item.category === 'irmaa_headroom'),
      ),
    ).toBe(true);
    expect(plan.diagnostics.warningFlags.includes('irmaa_surcharge_detected')).toBe(true);
  });

  it('identifies liquidity floor as a binding constraint when liquid assets are tight', () => {
    const data = cloneSeedData();
    data.income.salaryEndDate = '2026-01-01T00:00:00.000Z';
    data.income.socialSecurity = data.income.socialSecurity.map((entry) => ({
      ...entry,
      claimAge: 70,
    }));
    data.income.windfalls = [];
    data.accounts.cash.balance = 1_000;
    data.accounts.taxable.balance = 3_000;
    data.accounts.roth.balance = 2_000;
    data.accounts.pretax.balance = 120_000;
    data.accounts.hsa = {
      balance: 0,
      targetAllocation: { CASH: 1 },
    };
    data.spending.essentialMonthly = 12_000;
    data.spending.optionalMonthly = 6_000;

    const plan = generateAutopilotPlan({
      ...buildInput(),
      data,
      selectedStressors: [],
      selectedResponses: [],
      targetLegacyTodayDollars: 0,
      minSuccessRate: 0.55,
    });

    expect(
      plan.years.some((year) => year.tradeoffs.some((item) => item.category === 'liquidity_floor')),
    ).toBe(true);
    expect(plan.diagnostics.warningFlags.includes('liquidity_floor_pressure_detected')).toBe(true);
  });

  it('identifies do-not-sell-home stressor as a binding constraint when active', () => {
    const plan = generateAutopilotPlan({
      ...buildInput(),
      doNotSellPrimaryResidence: true,
      selectedStressors: [],
      selectedResponses: [],
      targetLegacyTodayDollars: 900_000,
      minSuccessRate: 0.7,
    });

    expect(
      plan.summary.primaryBindingConstraint === 'do_not_sell_primary_residence' ||
        plan.summary.supportingConstraints.includes('do_not_sell_primary_residence'),
    ).toBe(true);
    expect(
      plan.years.some((year) =>
        year.tradeoffs.some((item) => item.category === 'do_not_sell_primary_residence'),
      ),
    ).toBe(true);
  });

  it('identifies RMD forced income as a binding constraint in later retirement years', () => {
    const data = cloneSeedData();
    data.household.robBirthDate = '1948-12-08';
    data.household.debbieBirthDate = '1947-10-23';
    data.income.salaryAnnual = 0;
    data.income.salaryEndDate = '2026-01-01T00:00:00.000Z';
    data.income.socialSecurity = data.income.socialSecurity.map((entry) => ({
      ...entry,
      claimAge: 70,
    }));
    data.income.windfalls = [];
    data.accounts.pretax.balance = 1_800_000;
    data.accounts.taxable.balance = 30_000;
    data.accounts.cash.balance = 20_000;
    data.accounts.roth.balance = 10_000;

    const plan = generateAutopilotPlan({
      ...buildInput(),
      data,
      selectedStressors: [],
      selectedResponses: [],
      targetLegacyTodayDollars: 100_000,
      minSuccessRate: 0.55,
    });

    expect(
      plan.years.some((year) =>
        year.tradeoffs.some((item) => item.category === 'rmd_forced_income'),
      ),
    ).toBe(true);
  });
});
