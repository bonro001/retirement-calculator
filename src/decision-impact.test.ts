import { describe, expect, it } from 'vitest';
import { initialSeedData } from './data';
import {
  analyzeRetirementPlan,
  buildRetirementPlan,
  type PlanDecisionInput,
} from './retirement-plan';
import type { MarketAssumptions } from './types';
import { getAnnualStretchSpend } from './utils';

const DECISION_TEST_ASSUMPTIONS: MarketAssumptions = {
  equityMean: 0.07,
  equityVolatility: 0.15,
  internationalEquityMean: 0.07,
  internationalEquityVolatility: 0.17,
  bondMean: 0.035,
  bondVolatility: 0.06,
  cashMean: 0.02,
  cashVolatility: 0.01,
  inflation: 0.028,
  inflationVolatility: 0.01,
  simulationRuns: 3,
  irmaaThreshold: 200000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 18,
  guardrailCutPercent: 0.2,
  robPlanningEndAge: 90,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260419,
  assumptionsVersion: 'decision-impact-test',
};

function buildTestPlan(decisionImpactRequest: PlanDecisionInput) {
  return buildRetirementPlan({
    data: initialSeedData,
    assumptions: DECISION_TEST_ASSUMPTIONS,
    selectedStressors: [],
    selectedResponses: ['preserve_roth'],
    constraints: {
      doNotRetireLater: false,
      doNotSellHouse: false,
      minimumTravelBudgetAnnual: 5_000,
    },
    autopilotPolicy: {
      posture: 'defensive',
      optionalSpendingCutsAllowed: true,
      optionalSpendingFlexPercent: 10,
      travelFlexPercent: 20,
      defensiveResponses: ['cut_spending'],
    },
    withdrawalPolicy: {
      order: ['cash', 'taxable', 'pretax', 'roth'],
      dynamicDefenseOrdering: true,
      preserveRothPreference: true,
      irmaaAware: true,
    },
    targets: {
      exitTargetTodayDollars: 1_000_000,
      spendingTargetAnnual: getAnnualStretchSpend(initialSeedData),
      minSuccessRate: 0.78,
      optimizationObjective: 'maximize_time_weighted_spending',
    },
    irmaaPolicy: {
      posture: 'balanced',
    },
    decisionEngineSettings: {
      strategyMode: 'planner_enhanced',
      seedStrategy: 'shared',
      simulationRunsOverride: 3,
    },
    decisionImpactRequest,
  });
}

describe('decision impact evaluation', () => {
  it('buying a car reduces projected legacy', async () => {
    const run = await analyzeRetirementPlan(
      buildTestPlan({
        decisionCost: 50_000,
        decisionTiming: 'now',
        decisionFundingSource: 'cash',
      }),
    );

    expect(run.decisionImpact).not.toBeNull();
    expect(run.decisionImpact?.decisionLegacyDelta).toBeLessThan(0);
  }, 30000);

  it('funding source changes modeled tax and IRMAA impact', async () => {
    const cashRun = await analyzeRetirementPlan(
      buildTestPlan({
        decisionCost: 60_000,
        decisionTiming: 'now',
        decisionFundingSource: 'cash',
      }),
    );
    const pretaxRun = await analyzeRetirementPlan(
      buildTestPlan({
        decisionCost: 60_000,
        decisionTiming: 'now',
        decisionFundingSource: 'pretax',
      }),
    );

    expect((pretaxRun.decisionImpact?.decisionTaxDelta ?? 0)).toBeGreaterThan(
      cashRun.decisionImpact?.decisionTaxDelta ?? 0,
    );
    expect((pretaxRun.decisionImpact?.decisionIRMAADelta ?? 0)).toBeGreaterThan(
      cashRun.decisionImpact?.decisionIRMAADelta ?? 0,
    );
  }, 60000);

  it('generates mitigation guidance', async () => {
    const run = await analyzeRetirementPlan(
      buildTestPlan({
        decisionCost: 120_000,
        decisionTiming: 'now',
        decisionFundingSource: 'pretax',
      }),
    );

    expect((run.decisionImpact?.suggestedMitigationLever ?? '').length).toBeGreaterThan(0);
  }, 30000);
});
