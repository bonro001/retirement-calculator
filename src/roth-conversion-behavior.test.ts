import { describe, expect, it } from 'vitest';
import { initialSeedData } from './data';
import type { MarketAssumptions, SeedData } from './types';
import { buildPathResults } from './utils';

const TEST_ASSUMPTIONS: MarketAssumptions = {
  equityMean: 0.06,
  equityVolatility: 0,
  internationalEquityMean: 0.06,
  internationalEquityVolatility: 0,
  bondMean: 0.03,
  bondVolatility: 0,
  cashMean: 0.02,
  cashVolatility: 0,
  inflation: 0.025,
  inflationVolatility: 0,
  simulationRuns: 1,
  irmaaThreshold: 200000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 18,
  guardrailCutPercent: 0.2,
  robPlanningEndAge: 90,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260421,
  assumptionsVersion: 'roth-behavior-test',
};

function cloneSeedData(data: SeedData) {
  return JSON.parse(JSON.stringify(data)) as SeedData;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function max(values: number[]) {
  return values.length > 0 ? Math.max(...values) : 0;
}

describe('Roth conversion behavior', () => {
  it('executes non-zero ACA-constrained conversions when eligible and links MAGI effects', () => {
    const data = cloneSeedData(initialSeedData);
    data.income.salaryAnnual = 0;
    data.income.salaryEndDate = '2024-01-01';
    data.income.windfalls = [];
    data.accounts.pretax.balance = 420_000;
    data.accounts.roth.balance = 120_000;
    data.accounts.taxable.balance = 700_000;
    data.accounts.cash.balance = 320_000;
    data.spending.essentialMonthly = 4_800;
    data.spending.optionalMonthly = 2_200;
    data.spending.travelEarlyRetirementAnnual = 0;

    const path = buildPathResults(data, TEST_ASSUMPTIONS, [], [], {
      pathMode: 'selected_only',
      strategyMode: 'planner_enhanced',
    })[0];
    const trace = path.simulationDiagnostics.rothConversionTracePath;
    const debugPath = path.simulationDiagnostics.rothConversionEligibilityPath;
    const convertedYears = trace.filter((year) => year.amount > 0);
    expect(convertedYears.length).toBeGreaterThan(0);
    expect(path.simulationDiagnostics.conversionPath.some((year) => year.value > 0)).toBe(true);
    expect(debugPath.some((year) => year.executedRunRate > 0)).toBe(true);
    expect(path.simulationDiagnostics.conversionPath).toHaveLength(trace.length);
    path.simulationDiagnostics.conversionPath.forEach((point, index) => {
      expect(point.value).toBe(trace[index].amount);
      expect(point.year).toBe(trace[index].year);
      expect(trace[index].conversionReason).toBe(trace[index].reason);
      expect(trace[index].conversionExecuted).toBe(trace[index].amount > 0);
      expect(trace[index].evaluatedCandidateAmounts.length).toBeGreaterThanOrEqual(0);
      expect(trace[index].bestCandidateAmount).toBeGreaterThanOrEqual(0);
      expect(trace[index].withdrawalRoth).toBe(
        path.simulationDiagnostics.withdrawalPath[index]?.roth ?? 0,
      );
    });
    convertedYears.forEach((year) => {
      expect(year.simulationModeUsedForConversion).toBe('planner_enhanced');
      expect(year.plannerLogicActiveAtConversion).toBe(true);
      expect(year.conversionEngineInvoked).toBe(true);
      expect(year.reason.startsWith('executed_')).toBe(true);
      expect(year.conversionExecuted).toBe(true);
      expect(year.conversionReason).toBe(year.reason);
      expect(year.rawMAGI).toBeGreaterThanOrEqual(0);
      expect(year.irmaaThreshold).not.toBeNull();
      expect(year.computedHeadroom).toBeGreaterThan(0);
      expect(year.headroomComputed).toBe(true);
      expect(year.candidateAmountsGenerated).toBe(true);
      expect(year.evaluatedCandidateAmounts.length).toBeGreaterThan(0);
      expect(year.magiEffect).toBeGreaterThan(0);
      expect(year.pretaxBalanceEffect).toBeLessThan(0);
      expect(Math.abs(year.rothBalanceReconciliationDelta)).toBeLessThanOrEqual(2);
    });
    debugPath
      .filter((year) => year.representativeAmount > 0)
      .forEach((year) => {
        expect(year.representativeReason.startsWith('executed_')).toBe(true);
        expect(year.medianMagiAfter).toBeGreaterThan(year.medianMagiBefore);
        expect(year.evaluatedCandidateAmounts.some((amount) => amount > 0)).toBe(true);
        expect(year.bestCandidateAmount).toBeGreaterThan(0);
        expect(year.bestScore).toBeGreaterThan(0);
        expect(year.conversionExecuted).toBe(true);
        expect(year.simulationModeUsedForConversion).toBe('planner_enhanced');
        expect(year.plannerLogicActiveAtConversion).toBe(true);
        expect(year.conversionEngineInvoked).toBe(true);
        expect(year.rawMAGI).toBeGreaterThanOrEqual(0);
        expect(year.irmaaThreshold).not.toBeNull();
        expect(year.computedHeadroom).toBeGreaterThan(0);
        expect(year.headroomComputed).toBe(true);
        expect(year.candidateAmountsGenerated).toBe(true);
        expect(year.eligibilityBlockedReason).toBeNull();
        expect(year.conversionScore).toBeGreaterThan(0);
        expect(year.conversionOpportunityScore).toBeGreaterThan(0);
        expect(year.futureTaxReduction).toBeGreaterThanOrEqual(0);
        expect(year.futureTaxBurdenReduction).toBeGreaterThan(0);
        expect(year.irmaaAvoidanceValue).toBeGreaterThanOrEqual(0);
        expect(year.rmdReductionValue).toBeGreaterThan(0);
        expect(year.rothOptionalityValue).toBeGreaterThan(0);
        expect(year.future_tax_reduction_value).toBeGreaterThan(0);
        expect(year.currentTaxCost).toBeGreaterThanOrEqual(0);
        expect(year.conversionSuppressedReason).toBeNull();
      });
    const allowedSuppressionReasons = new Set([
      'no_headroom',
      'negative_score',
      'already_optimal',
      null,
    ]);
    debugPath.forEach((year) => {
      expect(Array.isArray(year.evaluatedCandidateAmounts)).toBe(true);
      expect(['planner_enhanced', 'raw_simulation']).toContain(year.simulationModeUsedForConversion);
      expect(typeof year.plannerLogicActiveAtConversion).toBe('boolean');
      expect(typeof year.conversionEngineInvoked).toBe('boolean');
      expect(Number.isFinite(year.bestCandidateAmount)).toBe(true);
      expect(Number.isFinite(year.bestScore)).toBe(true);
      expect(Number.isFinite(year.rawMAGI)).toBe(true);
      expect(year.irmaaThreshold === null || Number.isFinite(year.irmaaThreshold)).toBe(true);
      expect(Number.isFinite(year.computedHeadroom)).toBe(true);
      expect(Number.isFinite(year.magiBuffer)).toBe(true);
      expect(typeof year.headroomComputed).toBe('boolean');
      expect(typeof year.candidateAmountsGenerated).toBe('boolean');
      expect(Number.isFinite(year.conversionScore)).toBe(true);
      expect(Number.isFinite(year.conversionOpportunityScore)).toBe(true);
      expect(Number.isFinite(year.futureTaxReduction)).toBe(true);
      expect(Number.isFinite(year.futureTaxBurdenReduction)).toBe(true);
      expect(Number.isFinite(year.irmaaAvoidanceValue)).toBe(true);
      expect(Number.isFinite(year.rmdReductionValue)).toBe(true);
      expect(Number.isFinite(year.rothOptionalityValue)).toBe(true);
      expect(Number.isFinite(year.future_tax_reduction_value)).toBe(true);
      expect(Number.isFinite(year.currentTaxCost)).toBe(true);
      expect(allowedSuppressionReasons.has(year.conversionSuppressedReason)).toBe(true);
    });
  });

  it('does not suppress eligible conversions in RMD years', () => {
    const data = cloneSeedData(initialSeedData);
    data.household.robBirthDate = '1948-12-08';
    data.household.debbieBirthDate = '1947-10-23';
    data.income.salaryAnnual = 0;
    data.income.salaryEndDate = '2000-01-01';
    data.income.windfalls = [];
    data.accounts.pretax.balance = 520_000;
    data.accounts.roth.balance = 120_000;
    data.accounts.taxable.balance = 650_000;
    data.accounts.cash.balance = 360_000;
    data.spending.essentialMonthly = 4_000;
    data.spending.optionalMonthly = 2_000;
    data.spending.travelEarlyRetirementAnnual = 0;
    data.rules.rothConversionPolicy = {
      enabled: true,
      strategy: 'irmaa_headroom_only',
      minAnnualDollars: 500,
      maxPretaxBalancePercent: 0.12,
      magiBufferDollars: 2000,
    };

    const path = buildPathResults(
      data,
      { ...TEST_ASSUMPTIONS, irmaaThreshold: 1_000_000 },
      [],
      [],
      {
        pathMode: 'selected_only',
        strategyMode: 'planner_enhanced',
      },
    )[0];
    const trace = path.simulationDiagnostics.rothConversionTracePath;
    const executedIrmaaYears = trace.filter(
      (year) => year.amount > 0 && year.reason === 'executed_irmaa_headroom_fill',
    );

    expect(executedIrmaaYears.length).toBeGreaterThan(0);
    expect(
      trace.some((year) => year.reason === 'blocked_by_other_planner_constraint_rmd_required'),
    ).toBe(false);
  });

  it('keeps raw and planner Roth traces isolated by simulation mode', () => {
    const data = cloneSeedData(initialSeedData);
    data.income.salaryAnnual = 0;
    data.income.salaryEndDate = '2020-01-01';
    data.income.windfalls = [];
    data.accounts.pretax.balance = 600_000;
    data.accounts.roth.balance = 50_000;
    data.accounts.taxable.balance = 300_000;
    data.accounts.cash.balance = 300_000;

    const [planner] = buildPathResults(data, TEST_ASSUMPTIONS, [], [], {
      pathMode: 'selected_only',
      strategyMode: 'planner_enhanced',
    });
    const [raw] = buildPathResults(data, TEST_ASSUMPTIONS, [], [], {
      pathMode: 'selected_only',
      strategyMode: 'raw_simulation',
    });

    expect(planner.simulationDiagnostics.conversionPath.some((entry) => entry.value > 0)).toBe(true);
    expect(
      planner.simulationDiagnostics.rothConversionTracePath.some((entry) =>
        entry.reason.startsWith('executed_'),
      ),
    ).toBe(true);
    expect(raw.simulationDiagnostics.conversionPath.every((entry) => entry.value === 0)).toBe(true);
    expect(
      raw.simulationDiagnostics.rothConversionTracePath.every(
        (entry) =>
          entry.reason === 'simulation_mode_raw' &&
          entry.simulationModeUsedForConversion === 'raw_simulation' &&
          entry.plannerLogicActiveAtConversion === false &&
          entry.conversionEngineInvoked === false,
      ),
    ).toBe(true);
    expect(
      raw.simulationDiagnostics.rothConversionEligibilityPath.every((entry) => entry.executedRunRate === 0),
    ).toBe(true);
    expect(
      planner.simulationDiagnostics.rothConversionEligibilityPath.every(
        (entry) =>
          entry.simulationModeUsedForConversion === 'planner_enhanced' &&
          entry.plannerLogicActiveAtConversion === true &&
          entry.conversionEngineInvoked === true,
      ),
    ).toBe(true);
  });

  it('uses score-driven headroom conversions to lower later pretax withdrawals while respecting MAGI caps', () => {
    const enabledData = cloneSeedData(initialSeedData);
    enabledData.income.salaryAnnual = 0;
    enabledData.income.salaryEndDate = '2024-01-01';
    enabledData.income.windfalls = [];
    enabledData.accounts.pretax.balance = 2_200_000;
    enabledData.accounts.roth.balance = 120_000;
    enabledData.accounts.taxable.balance = 300_000;
    enabledData.accounts.cash.balance = 250_000;
    enabledData.spending.essentialMonthly = 5_200;
    enabledData.spending.optionalMonthly = 2_400;
    enabledData.spending.travelEarlyRetirementAnnual = 0;

    const disabledData = cloneSeedData(enabledData);
    disabledData.rules.rothConversionPolicy = {
      ...(disabledData.rules.rothConversionPolicy ?? {}),
      enabled: false,
      strategy: 'aca_then_irmaa_headroom',
      minAnnualDollars: 500,
      maxPretaxBalancePercent: 0.12,
      magiBufferDollars: 2000,
    };

    const enabled = buildPathResults(enabledData, TEST_ASSUMPTIONS, [], [], {
      pathMode: 'selected_only',
      strategyMode: 'planner_enhanced',
    })[0];
    const disabled = buildPathResults(disabledData, TEST_ASSUMPTIONS, [], [], {
      pathMode: 'selected_only',
      strategyMode: 'planner_enhanced',
    })[0];

    const startYear = enabled.yearlySeries[0]?.year ?? 0;
    const earlyCutoff = startYear + 6;
    const lateStart = startYear + 12;

    const earlyConversionYears = enabled.yearlySeries.filter(
      (year) => year.year <= earlyCutoff && year.medianRothConversion > 0,
    );
    const enabledLatePretaxWithdrawals = enabled.yearlySeries
      .filter((year) => year.year >= lateStart)
      .map((year) => year.medianWithdrawalIra401k);
    const disabledLatePretaxWithdrawals = disabled.yearlySeries
      .filter((year) => year.year >= lateStart)
      .map((year) => year.medianWithdrawalIra401k);
    const executedTraceYears = enabled.simulationDiagnostics.rothConversionTracePath.filter(
      (year) => year.amount > 0,
    );
    const earlyEvaluatedYears = enabled.simulationDiagnostics.rothConversionEligibilityPath.filter(
      (year) => year.year <= earlyCutoff && year.evaluatedCandidateAmounts.length > 0,
    );

    expect(earlyConversionYears.length).toBeGreaterThan(0);
    expect(earlyEvaluatedYears.length).toBeGreaterThan(0);
    earlyEvaluatedYears.forEach((year) => {
      if (year.plannerLogicActiveAtConversion && year.computedHeadroom > 0) {
        expect(year.evaluatedCandidateAmounts.length).toBeGreaterThan(0);
      }
      expect(year.eligibilityBlockedReason).not.toBe('planner_logic_inactive');
    });
    expect(sum(enabledLatePretaxWithdrawals)).toBeLessThan(sum(disabledLatePretaxWithdrawals));
    expect(max(enabledLatePretaxWithdrawals)).toBeLessThan(max(disabledLatePretaxWithdrawals));
    executedTraceYears.forEach((year) => {
      const debugYear = enabled.simulationDiagnostics.rothConversionEligibilityPath.find(
        (entry) => entry.year === year.year,
      );
      expect(debugYear).toBeDefined();
      expect(year.conversionScore).toBeGreaterThan(0);
      if (
        debugYear &&
        debugYear.medianTargetMagiCeiling !== null &&
        debugYear.medianMagiBefore <= debugYear.medianTargetMagiCeiling + 1
      ) {
        expect(debugYear.medianMagiAfter).toBeLessThanOrEqual(debugYear.medianTargetMagiCeiling + 1);
      }
    });
  });
});
