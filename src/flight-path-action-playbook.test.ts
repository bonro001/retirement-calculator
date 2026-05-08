import { describe, expect, it, vi } from 'vitest';
import { initialSeedData } from './data';
import { buildFlightPathPhasePlaybook } from './flight-path-action-playbook';
import type { MarketAssumptions, PathResult, SeedData } from './types';

vi.mock('./utils', async () => {
  const actual = await vi.importActual<typeof import('./utils')>('./utils');

  const buildMockPath = (
    data: SeedData,
    assumptions: MarketAssumptions,
  ): PathResult => {
    const investableBuckets = [
      data.accounts.pretax,
      data.accounts.roth,
      data.accounts.taxable,
      data.accounts.hsa,
    ].filter((bucket): bucket is NonNullable<typeof bucket> => Boolean(bucket));
    const investableTotal = investableBuckets.reduce((sum, bucket) => sum + bucket.balance, 0);

    const weightedCashExposure = investableBuckets.reduce((sum, bucket) => {
      const weight = bucket.balance / Math.max(1, investableTotal);
      return sum + weight * (bucket.targetAllocation.CASH ?? 0);
    }, 0);
    const weightedBondExposure = investableBuckets.reduce((sum, bucket) => {
      const weight = bucket.balance / Math.max(1, investableTotal);
      const directBond = bucket.targetAllocation.BND ?? 0;
      const muniBond = bucket.targetAllocation.MUB ?? 0;
      return sum + weight * (directBond + muniBond);
    }, 0);

    const baseSpend =
      (data.spending.essentialMonthly + data.spending.optionalMonthly) * 12 +
      data.spending.annualTaxesInsurance +
      data.spending.travelEarlyRetirementAnnual;
    const successRate = Math.max(
      0,
      Math.min(
        1,
        0.88 +
          weightedCashExposure * 0.05 +
          weightedBondExposure * 0.03 +
          (assumptions.equityMean - 0.07) * 0.7 -
          (assumptions.inflation - 0.028) * 0.6,
      ),
    );
    const medianEndingWealth =
      1_250_000 +
      investableTotal * assumptions.equityMean * 0.35 -
      investableTotal * weightedCashExposure * 0.03;
    const annualFederalTaxEstimate =
      27_500 + weightedCashExposure * 2_200 + weightedBondExposure * 1_300;
    const yearsFunded = 30 + successRate * 6 - weightedCashExposure * 1.5;

    return {
      id: 'selected',
      label: 'Selected Path',
      simulationMode: 'planner_enhanced',
      plannerLogicActive: true,
      successRate,
      medianEndingWealth,
      annualFederalTaxEstimate,
      yearsFunded,
      yearlySeries: [
        {
          year: 2026,
          medianSpending: baseSpend - weightedCashExposure * 2_400 + weightedBondExposure * 600,
        },
      ],
    } as unknown as PathResult;
  };

  return {
    ...actual,
    buildPathResults: vi.fn(
      (data: SeedData, assumptions: MarketAssumptions) =>
        [buildMockPath(data, assumptions)] satisfies PathResult[],
    ),
  };
});

const PLAYBOOK_TEST_ASSUMPTIONS: MarketAssumptions = {
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
  simulationRuns: 120,
  irmaaThreshold: 200_000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 18,
  guardrailCutPercent: 0.2,
  robPlanningEndAge: 90,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260420,
  assumptionsVersion: 'playbook-test',
};

describe('flight-path-action-playbook', () => {
  it('builds phase sections with fund-level trade instructions', () => {
    const result = buildFlightPathPhasePlaybook({
      evaluation: null,
      data: structuredClone(initialSeedData),
      assumptions: PLAYBOOK_TEST_ASSUMPTIONS,
      selectedStressors: [],
      selectedResponses: [],
      nowYear: 2026,
    });

    expect(result.phases.length).toBeGreaterThan(0);
    const preRetirement = result.phases.find((phase) => phase.id === 'pre_retirement');
    expect(preRetirement).toBeDefined();
    const runwayActions = result.phases
      .flatMap((phase) => phase.actions)
      .filter((action) => action.id.includes('runway'));

    if (runwayActions.length === 0) {
      expect(preRetirement?.actions.some((action) => action.id.includes('runway'))).toBe(false);
      return;
    }

    const runwayAction = preRetirement?.actions.find((action) =>
      action.id.startsWith('pre-retirement-vti-runway-'),
    );
    expect(runwayAction).toBeDefined();
    expect(runwayAction?.tradeInstructions.length).toBeGreaterThan(0);
    expect(
      runwayAction?.tradeInstructions.every(
        (instruction) =>
          instruction.fromSymbol === 'VTI' && instruction.toSymbol === 'CASH' && instruction.dollarAmount > 0,
      ),
    ).toBe(true);

    const payrollRunwayAction = preRetirement?.actions.find((action) =>
      action.id.startsWith('pre-retirement-payroll-runway-'),
    );
    expect(payrollRunwayAction).toBeDefined();
    expect(payrollRunwayAction?.tradeInstructions.length).toBe(0);
    expect(payrollRunwayAction?.contributionSettingsPatch?.employee401kPreTaxAnnualAmount).toBeDefined();
    expect(
      Number(payrollRunwayAction?.intermediateCalculations.currentEmployee401kPreTaxAnnualAmount),
    ).toBeGreaterThan(
      Number(payrollRunwayAction?.contributionSettingsPatch?.employee401kPreTaxAnnualAmount ?? 0),
    );
  });

  it('includes model completeness and sensitivity diagnostics per action', () => {
    const result = buildFlightPathPhasePlaybook({
      evaluation: null,
      data: structuredClone(initialSeedData),
      assumptions: PLAYBOOK_TEST_ASSUMPTIONS,
      selectedStressors: [],
      selectedResponses: [],
      nowYear: 2026,
    });

    const allActions = result.phases.flatMap((phase) => phase.actions);
    expect(allActions.length).toBeGreaterThan(0);
    expect(result.retirementFlowYears.length).toBeGreaterThan(0);
    const firstFlowYear = result.retirementFlowYears[0];
    expect(firstFlowYear?.monthsInRetirement).toBeGreaterThan(0);
    expect(firstFlowYear?.totalIncome).toBeGreaterThanOrEqual(0);
    expect(firstFlowYear?.expectedMagi).toBeGreaterThanOrEqual(0);
    expect(['standard', 'aca_bridge', 'unknown']).toContain(firstFlowYear?.regime);
    expect(firstFlowYear?.irmaaStatus).toBeTruthy();
    expect(
      firstFlowYear?.acaFriendlyMagiCeiling === null ||
        typeof firstFlowYear?.acaFriendlyMagiCeiling === 'number',
    ).toBe(true);
    const acaBridgePhase = result.phases.find((phase) => phase.id === 'aca_bridge');
    expect(acaBridgePhase?.acaMetrics).toBeDefined();
    expect(
      ['green', 'yellow', 'red', 'unknown'].includes(
        acaBridgePhase?.acaMetrics?.subsidyRiskBand ?? '',
      ),
    ).toBe(true);
    expect(acaBridgePhase?.acaMetrics?.guardrailBufferDollars).toBe(5000);
    expect(
      acaBridgePhase?.acaMetrics?.requiredMagiReductionWithBuffer ?? 0,
    ).toBeGreaterThanOrEqual(0);
    expect(
      acaBridgePhase?.acaMetrics?.estimatedAcaPremiumAtRisk ?? 0,
    ).toBeGreaterThanOrEqual(0);
    expect(
      ['normal', 'watch', 'recovery', 'unknown'].includes(
        result.diagnostics.acaGuardrailAdjustment.mode,
      ),
    ).toBe(true);
    expect(
      ['green', 'yellow', 'red', 'unknown'].includes(
        result.diagnostics.acaGuardrailAdjustment.subsidyRiskBand,
      ),
    ).toBe(true);
    expect(result.diagnostics.acaGuardrailAdjustment.requiredMagiReduction).toBeGreaterThanOrEqual(0);
    expect(result.diagnostics.acaGuardrailAdjustment.prioritizedPhaseIds.length).toBeGreaterThan(0);
    expect(result.diagnostics.acaGuardrailAdjustment.prioritizedPhaseIds).toContain('aca_bridge');
    expect(
      ['aca_bridge_first', 'runway_first'].includes(
        result.diagnostics.acaGuardrailAdjustment.priorityDriver,
      ),
    ).toBe(true);
    expect(result.diagnostics.acaGuardrailAdjustment.runwayGapMonths).toBeGreaterThanOrEqual(0);
    expect(
      result.diagnostics.acaGuardrailAdjustment.yearsUntilBridge === null ||
        Number.isFinite(result.diagnostics.acaGuardrailAdjustment.yearsUntilBridge),
    ).toBe(true);
    expect(allActions.every((action) => action.modelCompleteness === 'reconstructed')).toBe(true);
    expect(
      allActions.every(
        (action) => action.rankWithinPhase >= 1 && Number.isFinite(action.rankScore),
      ),
    ).toBe(true);
    expect(
      allActions.every(
        (action) =>
          !action.inferredAssumptions.some((assumption) =>
            assumption.includes('Plan evaluation context unavailable'),
          ),
      ),
    ).toBe(true);
    expect(result.phases.every((phase) => phase.actions.filter((action) => action.isTopRecommendation).length <= 1)).toBe(true);
    expect(
      allActions.every(
        (action) =>
          action.sensitivity.scenarios.length === 3 &&
          action.sensitivity.scenarios.some((scenario) => scenario.name === 'base'),
      ),
    ).toBe(true);
    expect(
      allActions.every(
        (action) => Number.isFinite(action.fullGoalDollars) && action.fullGoalDollars >= 0,
      ),
    ).toBe(true);
    expect(
      allActions.every(
        (action) =>
          action.laymanExpansion.templateVersion === 'layman_v1' &&
          action.laymanExpansion.storyHook.length > 0 &&
          action.laymanExpansion.plainEnglishTask.length > 0 &&
          action.laymanExpansion.whyImportant.length > 0 &&
          action.laymanExpansion.walkthroughSteps.length > 0 &&
          action.laymanExpansion.watchOuts.length > 0,
      ),
    ).toBe(true);
    expect(result.diagnostics.inferredAssumptions.length).toBeGreaterThan(0);
  });

  it('surfaces final-year 401k room as a pre-retirement payroll action', () => {
    const result = buildFlightPathPhasePlaybook({
      evaluation: null,
      data: structuredClone(initialSeedData),
      assumptions: PLAYBOOK_TEST_ASSUMPTIONS,
      selectedStressors: [],
      selectedResponses: [],
      nowYear: 2026,
    });

    const preRetirement = result.phases.find((phase) => phase.id === 'pre_retirement');
    const action = preRetirement?.actions.find(
      (item) => item.id === 'pre-retirement-final-year-401k-max-1',
    );

    expect(action).toBeDefined();
    expect(action?.tradeInstructions.length).toBe(0);
    expect(action?.contributionSettingsPatch?.employee401kPreTaxAnnualAmount).toBe(36250);
    expect(Number(action?.intermediateCalculations.employee401kAnnualLimit)).toBe(36250);
    expect(Number(action?.intermediateCalculations.employee401kRemainingRoom)).toBeCloseTo(
      20510.5,
      1,
    );
    expect(action?.objective).toMatch(/MAGI/);
  });

  it('is deterministic for repeated seeded runs', () => {
    const first = buildFlightPathPhasePlaybook({
      evaluation: null,
      data: structuredClone(initialSeedData),
      assumptions: PLAYBOOK_TEST_ASSUMPTIONS,
      selectedStressors: [],
      selectedResponses: [],
      nowYear: 2026,
    });
    const second = buildFlightPathPhasePlaybook({
      evaluation: null,
      data: structuredClone(initialSeedData),
      assumptions: PLAYBOOK_TEST_ASSUMPTIONS,
      selectedStressors: [],
      selectedResponses: [],
      nowYear: 2026,
    });

    expect(second).toEqual(first);
  });

  it('keeps phase actions ranked by descending score with a single top recommendation', () => {
    const result = buildFlightPathPhasePlaybook({
      evaluation: null,
      data: structuredClone(initialSeedData),
      assumptions: PLAYBOOK_TEST_ASSUMPTIONS,
      selectedStressors: [],
      selectedResponses: [],
      nowYear: 2026,
    });

    result.phases.forEach((phase) => {
      if (!phase.actions.length) {
        return;
      }
      const sortedByScore = [...phase.actions].sort((left, right) => {
        const scoreDiff = right.rankScore - left.rankScore;
        if (scoreDiff !== 0) {
          return scoreDiff;
        }
        return left.id.localeCompare(right.id);
      });
      expect(phase.actions.map((action) => action.id)).toEqual(
        sortedByScore.map((action) => action.id),
      );
      expect(phase.actions[0].rankWithinPhase).toBe(1);
      expect(phase.actions[0].isTopRecommendation).toBe(true);
      expect(phase.actions.slice(1).every((action) => !action.isTopRecommendation)).toBe(true);
    });
  });

  it('adds a payroll MAGI-reducer action when ACA bridge year is over the ceiling and salary is active', () => {
    const data = structuredClone(initialSeedData);
    data.income.salaryEndDate = '2027-07-01';
    data.income.preRetirementContributions = {
      employee401kPreTaxAnnualAmount: 26000,
      employee401kRothAnnualAmount: 6000,
      hsaAnnualAmount: 6000,
      hsaCoverageType: 'family',
      employerMatch: {
        matchRate: 0.5,
        maxEmployeeContributionPercentOfSalary: 0.06,
      },
    };
    const evaluation = {
      raw: {
        run: {
          plan: {
            modelCompleteness: 'faithful',
            inferredAssumptions: [],
          },
          autopilot: {
            years: [
              {
                year: 2027,
                regime: 'aca_bridge',
                estimatedMAGI: 132000,
                acaFriendlyMagiCeiling: 108000,
                withdrawalCash: 0,
                withdrawalTaxable: 12000,
                withdrawalIra401k: 0,
                withdrawalRoth: 8000,
                rmdAmount: 0,
                irmaaStatus: 'not_applicable',
                irmaaHeadroom: null,
                robAge: 63,
                debbieAge: 61,
              },
            ],
          },
        },
      },
    } as unknown as Parameters<typeof buildFlightPathPhasePlaybook>[0]['evaluation'];

    const result = buildFlightPathPhasePlaybook({
      evaluation,
      data,
      assumptions: PLAYBOOK_TEST_ASSUMPTIONS,
      selectedStressors: [],
      selectedResponses: [],
      nowYear: 2026,
    });

    const acaBridgePhase = result.phases.find((phase) => phase.id === 'aca_bridge');
    const payrollAction = acaBridgePhase?.actions.find((action) =>
      action.id.startsWith('aca-bridge-payroll-magi-reducer-'),
    );

    expect(payrollAction).toBeDefined();
    expect(payrollAction?.tradeInstructions.length).toBe(0);
    expect(payrollAction?.contributionSettingsPatch).toBeTruthy();
    expect(payrollAction?.contributionSettingsPatch?.employee401kPreTaxAnnualAmount).toBeGreaterThan(
      26000,
    );
    expect(payrollAction?.contributionSettingsPatch?.employee401kPreTaxAnnualAmount).toBeLessThanOrEqual(
      Number(payrollAction?.intermediateCalculations.employee401kAnnualLimit),
    );
    expect(
      Number(payrollAction?.intermediateCalculations.acaBridgeMagiReductionNeededWithBuffer),
    ).toBe(29000);
    expect(
      Number(payrollAction?.intermediateCalculations.remainingMagiReductionAfterPayroll),
    ).toBeGreaterThan(0);
    expect(
      Number(payrollAction?.intermediateCalculations.mitigationAttributedToRothConversionCapping),
    ).toBeGreaterThan(0);
    expect(Number(payrollAction?.intermediateCalculations.estimatedAcaPremiumAtRisk)).toBeGreaterThan(
      0,
    );
  });

  it('distinguishes unmitigated ACA risk from the executed planner path', () => {
    const data = structuredClone(initialSeedData);
    const evaluation = {
      raw: {
        run: {
          plan: {
            modelCompleteness: 'faithful',
            inferredAssumptions: [],
          },
          autopilot: {
            years: [
              {
                year: 2027,
                regime: 'aca_bridge',
                estimatedMAGI: 87591,
                acaFriendlyMagiCeiling: 84969,
                withdrawalCash: 0,
                withdrawalTaxable: 12000,
                withdrawalIra401k: 0,
                withdrawalRoth: 8000,
                rmdAmount: 0,
                irmaaStatus: 'not_applicable',
                irmaaHeadroom: null,
                robAge: 63,
                debbieAge: 61,
              },
            ],
          },
        },
      },
    } as unknown as Parameters<typeof buildFlightPathPhasePlaybook>[0]['evaluation'];

    const result = buildFlightPathPhasePlaybook({
      evaluation,
      data,
      assumptions: PLAYBOOK_TEST_ASSUMPTIONS,
      selectedStressors: [],
      selectedResponses: [],
      nowYear: 2026,
      executedSimulationOutcome: {
        yearlySeries: [
          {
            year: 2027,
            medianMagi: 72993,
            medianRothConversion: 11475,
          },
        ],
      } as unknown as PathResult,
      unmitigatedSimulationOutcome: {
        yearlySeries: [
          {
            year: 2027,
            medianMagi: 87591,
            medianRothConversion: 40000,
          },
        ],
      } as unknown as PathResult,
    });

    const acaMetrics = result.phases.find((phase) => phase.id === 'aca_bridge')?.acaMetrics;
    expect(acaMetrics?.projectedMagi).toBe(72993);
    expect(acaMetrics?.unmitigatedProjectedMagi).toBe(87591);
    expect(acaMetrics?.requiredMagiReduction).toBe(0);
    expect(acaMetrics?.unmitigatedRequiredMagiReduction).toBe(2622);
    expect(acaMetrics?.acaMitigationDelta).toBe(14598);
    expect(acaMetrics?.acaStatus).toBe('mitigated');
    expect(result.diagnostics.acaGuardrailAdjustment.mode).toBe('normal');
  });

  it('surfaces a Roth FCNTX concentration reducer when the Roth bucket is dominated by one fund', () => {
    const result = buildFlightPathPhasePlaybook({
      evaluation: null,
      data: structuredClone(initialSeedData),
      assumptions: PLAYBOOK_TEST_ASSUMPTIONS,
      selectedStressors: [],
      selectedResponses: [],
      nowYear: 2026,
    });

    const concentrationActions = result.phases
      .flatMap((phase) => phase.actions)
      .filter((action) => action.id.startsWith('roth-fcntx-concentration-'));

    expect(concentrationActions.length).toBeGreaterThan(0);
    const balancedAction = concentrationActions.find((action) =>
      action.id.endsWith('-2'),
    );
    expect(balancedAction).toBeDefined();
    expect(balancedAction?.tradeInstructions.length).toBeGreaterThan(0);
    expect(
      new Set(balancedAction?.tradeInstructions.map((instruction) => instruction.toSymbol)),
    ).toEqual(new Set(['VTI', 'VXUS']));
    expect(
      Number(balancedAction?.intermediateCalculations.concentrationSharePercent),
    ).toBeGreaterThan(75);
  });
});
