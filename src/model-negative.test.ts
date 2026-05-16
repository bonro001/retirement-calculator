import { describe, expect, it, vi } from 'vitest';
import { initialSeedData } from './data';
import { buildModelFidelityAssessment } from './model-fidelity';
import { runParityHarnessFromExportJson } from './monte-carlo-parity';
import { buildPlanningStateExport } from './planning-export';
import { solveSpendByReverseTimeline } from './spend-solver';
import type { MarketAssumptions, ModelFidelityAssessment, SeedData } from './types';

vi.setConfig({ testTimeout: 40_000 });

const NEGATIVE_TEST_ASSUMPTIONS: MarketAssumptions = {
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
  simulationRuns: 12,
  irmaaThreshold: 200000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 18,
  guardrailCutPercent: 0.2,
  robPlanningEndAge: 90,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260516,
  assumptionsVersion: 'negative-model-test',
};

function cloneSeedData(data: SeedData = initialSeedData): SeedData {
  return JSON.parse(JSON.stringify(data)) as SeedData;
}

function inputById(assessment: ModelFidelityAssessment, id: string) {
  return assessment.inputs.find((input) => input.id === id);
}

describe('negative model guardrails', () => {
  it('marks impossible numeric inputs as blocking reconstruction evidence', () => {
    const data = cloneSeedData();
    data.spending.essentialMonthly = -1;
    data.accounts.taxable.balance = -100;
    data.accounts.roth.targetAllocation = { VTI: 1.25 };
    data.income.socialSecurity = data.income.socialSecurity.map((entry, index) => ({
      ...entry,
      claimAge: index === 0 ? 71 : entry.claimAge,
    }));

    const assessment = buildModelFidelityAssessment({
      data,
      assumptions: {
        ...NEGATIVE_TEST_ASSUMPTIONS,
        simulationRuns: 0,
        robPlanningEndAge: 40,
        equityVolatility: -0.1,
        guardrailCeilingYears: 2,
      },
    });

    expect(assessment.modelCompleteness).toBe('reconstructed');
    expect(assessment.assessmentGrade).toBe('exploratory');
    expect(assessment.blockingAssumptions).toEqual(
      expect.arrayContaining([
        'income.social_security_claim_age_range',
        'assumptions.simulation_runs',
        'spending.non_negative_amounts',
        'accounts.non_negative_balances',
        'accounts.target_allocation_totals',
        'assumptions.planning_horizon',
        'assumptions.market_parameters',
        'assumptions.guardrail_parameters',
      ]),
    );
    expect(inputById(assessment, 'spending.non_negative_amounts')?.detail).toContain(
      'spending.essentialMonthly',
    );
    expect(inputById(assessment, 'accounts.target_allocation_totals')?.detail).toContain(
      'roth.allocation_sum',
    );
  });

  it('keeps omitted seed and version from looking faithful', () => {
    const missingTraceability: MarketAssumptions = {
      ...NEGATIVE_TEST_ASSUMPTIONS,
      simulationSeed: undefined,
      assumptionsVersion: undefined,
    };

    const assessment = buildModelFidelityAssessment({
      data: cloneSeedData(),
      assumptions: missingTraceability,
    });

    expect(assessment.modelCompleteness).toBe('reconstructed');
    expect(assessment.assessmentGrade).not.toBe('decision_grade');
    expect(assessment.blockingAssumptions).toEqual(
      expect.arrayContaining([
        'assumptions.simulationSeed',
        'assumptions.assumptionsVersion',
      ]),
    );
    expect(assessment.effectOnReliability).toContain('blocking assumptions');
  });

  it('returns an explicit infeasible solver result when legacy cannot be met', () => {
    const data = cloneSeedData();
    data.income.salaryAnnual = 0;
    data.income.salaryEndDate = '2026-01-01T00:00:00.000Z';
    data.income.socialSecurity = [];
    data.income.windfalls = [];
    data.spending.essentialMonthly = 5000;
    data.spending.optionalMonthly = 0;
    data.spending.annualTaxesInsurance = 0;
    data.spending.travelEarlyRetirementAnnual = 0;
    data.accounts.pretax.balance = 0;
    data.accounts.roth.balance = 0;
    data.accounts.taxable.balance = 0;
    data.accounts.cash.balance = 0;
    if (data.accounts.hsa) {
      data.accounts.hsa.balance = 0;
    }

    const result = solveSpendByReverseTimeline({
      data,
      assumptions: {
        ...NEGATIVE_TEST_ASSUMPTIONS,
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
        assumptionsVersion: 'negative-infeasible-solver',
      },
      selectedStressors: [],
      selectedResponses: [],
      targetLegacyTodayDollars: 1_000_000,
      minSuccessRate: 0.99,
      spendingFloorAnnual: 60_000,
      spendingCeilingAnnual: 60_000,
      toleranceAnnual: 500,
      maxIterations: 6,
      skipSuccessFloorRelaxationProbe: true,
      runtimeBudget: {
        searchSimulationRuns: 8,
        finalSimulationRuns: 8,
        maxIterations: 6,
        diagnosticsMode: 'full',
        enableSuccessRelaxationProbe: false,
      },
    });

    expect(result.feasible).toBe(false);
    expect(result.legacyAttainmentMet).toBe(false);
    expect(result.projectedLegacyOutcomeTodayDollars).toBeLessThan(
      result.legacyFloorTodayDollars,
    );
    expect(result.actionableExplanation).toContain('closest fit');
    expect(result.bindingConstraint.length).toBeGreaterThan(0);
  });

  it('refuses to replay a corrupted export snapshot instead of defaulting missing fields', () => {
    const payload = buildPlanningStateExport({
      data: cloneSeedData(),
      assumptions: {
        ...NEGATIVE_TEST_ASSUMPTIONS,
        simulationRuns: 8,
        assumptionsVersion: 'negative-export-corruption',
      },
      selectedStressorIds: [],
      selectedResponseIds: [],
    });
    const corrupted = structuredClone(payload) as typeof payload & {
      baseInputs: typeof payload.baseInputs & {
        spending: Partial<typeof payload.baseInputs.spending>;
      };
    };
    delete corrupted.baseInputs.spending.travelFloorAnnual;

    expect(() => runParityHarnessFromExportJson(JSON.stringify(corrupted), undefined, 8))
      .toThrow(/baseInputs\.spending\.travelFloorAnnual/);
  });
});
