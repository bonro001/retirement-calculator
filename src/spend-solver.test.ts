import { describe, expect, it } from 'vitest';
import { initialSeedData } from './data';
import type { MarketAssumptions } from './types';
import { solveSpendByReverseTimeline } from './spend-solver';

const SOLVER_TEST_ASSUMPTIONS: MarketAssumptions = {
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
  assumptionsVersion: 'spend-solver-test',
};

function buildSolverInput() {
  return {
    data: initialSeedData,
    assumptions: SOLVER_TEST_ASSUMPTIONS,
    selectedStressors: ['market_down'],
    selectedResponses: ['cut_spending'],
    targetLegacyTodayDollars: 900000,
    minSuccessRate: 0.8,
    spendingFloorAnnual: 60000,
    spendingCeilingAnnual: 220000,
    toleranceAnnual: 500,
    maxIterations: 14,
  };
}

function getPhaseDelta(result: ReturnType<typeof solveSpendByReverseTimeline>, phase: 'go_go' | 'slow_go' | 'late') {
  return result.spendingDeltaByPhase.find((entry) => entry.phase === phase)?.deltaAnnual ?? 0;
}

describe('spend-solver', () => {
  it('reduces allowed spending when primary residence sale is disabled', () => {
    const allowsHomeSale = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      targetLegacyTodayDollars: 1_200_000,
      minSuccessRate: 0.85,
      housingFundingPolicy: 'allow_primary_residence_sale',
    });
    const blocksHomeSale = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      targetLegacyTodayDollars: 1_200_000,
      minSuccessRate: 0.85,
      housingFundingPolicy: 'do_not_sell_primary_residence',
    });

    expect(blocksHomeSale.recommendedAnnualSpend).toBeLessThan(
      allowsHomeSale.recommendedAnnualSpend,
    );
  });

  it('reduces allowed spending when legacy target increases', () => {
    const lowLegacy = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      targetLegacyTodayDollars: 500000,
    });
    const highLegacy = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      targetLegacyTodayDollars: 1400000,
    });

    expect(highLegacy.recommendedAnnualSpend).toBeLessThanOrEqual(
      lowLegacy.recommendedAnnualSpend,
    );
  });

  it('reduces allowed spending when required success rate increases', () => {
    const lowerSuccessFloor = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      minSuccessRate: 0.72,
    });
    const higherSuccessFloor = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      minSuccessRate: 0.9,
    });

    expect(higherSuccessFloor.recommendedAnnualSpend).toBeLessThanOrEqual(
      lowerSuccessFloor.recommendedAnnualSpend,
    );
  });

  it('converges to a stable recommendation', () => {
    const result = solveSpendByReverseTimeline(buildSolverInput());

    expect(result.converged).toBe(true);
    expect(result.safeSpendingBand.lowerAnnual).toBeLessThanOrEqual(
      result.safeSpendingBand.targetAnnual,
    );
    expect(result.safeSpendingBand.targetAnnual).toBeLessThanOrEqual(
      result.safeSpendingBand.upperAnnual,
    );
    expect(result.actionableExplanation.length).toBeGreaterThan(0);
    expect(result.tradeoffExplanation.length).toBeGreaterThan(0);
  });

  it('is deterministic for repeated runs with the same seed', () => {
    const firstRun = solveSpendByReverseTimeline(buildSolverInput());
    const secondRun = solveSpendByReverseTimeline(buildSolverInput());

    expect(secondRun.recommendedAnnualSpend).toBe(firstRun.recommendedAnnualSpend);
    expect(secondRun.modeledSuccessRate).toBe(firstRun.modeledSuccessRate);
    expect(secondRun.projectedLegacyOutcomeTodayDollars).toBe(
      firstRun.projectedLegacyOutcomeTodayDollars,
    );
  });

  it('increases earlier-life spending relative to later-life spending in time-weighted mode', () => {
    const result = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      selectedStressors: [],
      selectedResponses: [],
      optimizationObjective: 'maximize_time_weighted_spending',
      targetLegacyTodayDollars: 750_000,
      minSuccessRate: 0.75,
    });

    const goGoDelta = getPhaseDelta(result, 'go_go');
    const lateDelta = getPhaseDelta(result, 'late');

    expect(result.activeOptimizationObjective).toBe('maximize_time_weighted_spending');
    expect(goGoDelta).toBeGreaterThan(lateDelta);
    expect(result.spendingDeltaByPhase.find((entry) => entry.phase === 'go_go')?.optimizedAnnual)
      .toBeGreaterThanOrEqual(
        result.spendingDeltaByPhase.find((entry) => entry.phase === 'late')?.optimizedAnnual ?? 0,
      );
  });

  it('respects minimum ending wealth and success constraints in time-weighted mode', () => {
    const minSuccessRate = 0.8;
    const targetLegacy = 700_000;
    const result = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      optimizationObjective: 'maximize_time_weighted_spending',
      minSuccessRate,
      targetLegacyTodayDollars: targetLegacy,
    });

    if (result.feasible) {
      expect(result.legacyAttainmentMet).toBe(true);
      expect(result.projectedLegacyOutcomeTodayDollars).toBeGreaterThanOrEqual(targetLegacy);
      expect(result.modeledSuccessRate).toBeGreaterThanOrEqual(minSuccessRate);
      return;
    }

    expect(result.bindingConstraint.length).toBeGreaterThan(0);
    expect(result.actionableExplanation.length).toBeGreaterThan(0);
    expect(result.modeledSuccessRate < minSuccessRate || result.projectedLegacyOutcomeTodayDollars < targetLegacy).toBe(true);
  });

  it('reduces feasible spending when inheritance is removed in time-weighted mode', () => {
    const withInheritance = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      optimizationObjective: 'maximize_time_weighted_spending',
      targetLegacyTodayDollars: 1_200_000,
      minSuccessRate: 0.85,
    });
    const withoutInheritance = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      optimizationObjective: 'maximize_time_weighted_spending',
      targetLegacyTodayDollars: 1_200_000,
      minSuccessRate: 0.85,
      constraints: {
        inheritanceEnabled: false,
      },
    });

    expect(withoutInheritance.recommendedAnnualSpend).toBeLessThanOrEqual(
      withInheritance.recommendedAnnualSpend,
    );
  }, 20000);

  it('produces a meaningfully different phase profile than preserve_legacy mode', () => {
    const preserveLegacy = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      optimizationObjective: 'preserve_legacy',
      selectedStressors: [],
      selectedResponses: [],
    });
    const timeWeighted = solveSpendByReverseTimeline({
      ...buildSolverInput(),
      optimizationObjective: 'maximize_time_weighted_spending',
      selectedStressors: [],
      selectedResponses: [],
    });

    const preserveDeltas = preserveLegacy.spendingDeltaByPhase.map((entry) => entry.deltaAnnual);
    const timeWeightedDeltas = timeWeighted.spendingDeltaByPhase.map((entry) => entry.deltaAnnual);
    const preserveSpread = Math.max(...preserveDeltas) - Math.min(...preserveDeltas);
    const timeWeightedSpread = Math.max(...timeWeightedDeltas) - Math.min(...timeWeightedDeltas);

    expect(timeWeighted.activeOptimizationObjective).toBe('maximize_time_weighted_spending');
    expect(preserveLegacy.activeOptimizationObjective).toBe('preserve_legacy');
    expect(timeWeightedSpread).toBeGreaterThan(preserveSpread);
  }, 20000);
});
