import { describe, expect, it } from 'vitest';
import { initialSeedData } from './data';
import {
  buildNorthStarResult,
  getNorthStarDistributionMode,
} from './north-star-result';
import type { MarketAssumptions, PathResult } from './types';

const assumptions: MarketAssumptions = {
  equityMean: 0.074,
  equityVolatility: 0.18,
  internationalEquityMean: 0.065,
  internationalEquityVolatility: 0.2,
  bondMean: 0.038,
  bondVolatility: 0.07,
  cashMean: 0.02,
  cashVolatility: 0.01,
  inflation: 0.028,
  inflationVolatility: 0.015,
  simulationRuns: 100,
  simulationSeed: 1234,
  assumptionsVersion: 'test-pack',
  robPlanningEndAge: 95,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  irmaaThreshold: 218_000,
};

function makePath(overrides: Partial<PathResult> = {}): PathResult {
  return {
    id: 'path',
    label: 'Path',
    simulationMode: 'planner_enhanced',
    plannerLogicActive: true,
    successRate: 0.87,
    medianEndingWealth: 2_000_000,
    tenthPercentileEndingWealth: 250_000,
    yearsFunded: 33,
    medianFailureYear: null,
    spendingCutRate: 0,
    irmaaExposureRate: 0.12,
    homeSaleDependenceRate: 0.02,
    inheritanceDependenceRate: 0.04,
    flexibilityScore: 0,
    cornerRiskScore: 0,
    rothDepletionRate: 0,
    annualFederalTaxEstimate: 32_000,
    irmaaExposure: 'Low',
    cornerRisk: 'Low',
    failureMode: 'none',
    notes: '',
    stressors: [],
    responses: [],
    endingWealthPercentiles: {
      p10: 250_000,
      p25: 900_000,
      p50: 2_000_000,
      p75: 3_500_000,
      p90: 5_000_000,
    },
    failureYearDistribution: [],
    worstOutcome: { endingWealth: 0, success: false, failureYear: 2044 },
    bestOutcome: { endingWealth: 8_000_000, success: true, failureYear: null },
    monteCarloMetadata: {
      seed: 1234,
      trialCount: 100,
      assumptionsVersion: 'test-pack',
      planningHorizonYears: 34,
    },
    simulationConfiguration: {} as PathResult['simulationConfiguration'],
    simulationDiagnostics: {} as PathResult['simulationDiagnostics'],
    riskMetrics: {} as PathResult['riskMetrics'],
    yearlySeries: [],
    ...overrides,
  };
}

describe('north-star result contract', () => {
  it('labels distribution mode from assumptions', () => {
    expect(getNorthStarDistributionMode({ useHistoricalBootstrap: false })).toBe(
      'forward-looking',
    );
    expect(getNorthStarDistributionMode({ useHistoricalBootstrap: true })).toBe(
      'historical-precedent',
    );
  });

  it('builds a replayable headline result with provenance and intermediate calculations', () => {
    const result = buildNorthStarResult({
      seedData: initialSeedData,
      assumptions,
      path: makePath(),
      modelCompleteness: 'reconstructed',
      inferredAssumptions: ['CENTRAL_MANAGED look-through estimated.'],
      supportedAnnualSpend: 140_000,
      activeSimulationProfile: 'plannerEnhancedSimulation',
      generatedAtIso: '2026-05-08T00:00:00.000Z',
    });

    expect(result.version).toBe('north_star_result_v1');
    expect(result.generatedAtIso).toBe('2026-05-08T00:00:00.000Z');
    expect(result.planFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(result.engineVersion).toBe('test-pack');
    expect(result.assumptionsPackVersion).toBe('current-law-2026-v1');
    expect(result.distributionMode).toBe('forward-looking');
    expect(result.simulationSeed).toBe(1234);
    expect(result.simulationRuns).toBe(100);
    expect(result.supportedAnnualSpend).toBe(140_000);
    expect(result.successRate).toBe(0.87);
    expect(result.modelCompleteness).toBe('reconstructed');
    expect(result.inferredAssumptions).toEqual([
      'CENTRAL_MANAGED look-through estimated.',
    ]);
    expect(result.intermediateCalculations.activeSimulationProfile).toBe(
      'plannerEnhancedSimulation',
    );
    expect(result.intermediateCalculations.endingWealthPercentiles.p50).toBe(
      2_000_000,
    );
  });
});
