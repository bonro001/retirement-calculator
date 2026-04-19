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
});
