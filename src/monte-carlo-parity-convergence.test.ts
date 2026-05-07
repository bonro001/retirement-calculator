import { describe, expect, it } from 'vitest';
import { initialSeedData } from './data';
import { runParityConvergenceFromExport, runParityHarnessFromExport } from './monte-carlo-parity';
import { buildPlanningStateExport } from './planning-export';
import type { MarketAssumptions } from './types';

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
  simulationRuns: 5000,
  irmaaThreshold: 200000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 18,
  guardrailCutPercent: 0.2,
  robPlanningEndAge: 90,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260418,
  assumptionsVersion: 'parity-convergence-test',
};

describe('monte carlo parity convergence', () => {
  it('runs convergence at 2k, 4k, and 8k and keeps diagnostics structured', () => {
    const payload = buildPlanningStateExport({
      data: initialSeedData,
      assumptions: TEST_ASSUMPTIONS,
      selectedStressorIds: ['market_down'],
      selectedResponseIds: ['cut_spending', 'preserve_roth'],
    });

    const convergence = runParityConvergenceFromExport(payload, [2000, 4000, 8000]);
    const baseline = runParityHarnessFromExport(payload);

    expect(convergence.rows).toHaveLength(3);
    expect(convergence.rows.map((row) => row.runCount)).toEqual([2000, 4000, 8000]);
    expect(baseline.diagnostics.rawSimulation.mismatches.length).toBe(0);
    expect(baseline.diagnostics.plannerEnhancedSimulation.mismatches.length).toBe(0);
    expect(convergence.rows.every((row) => row.rawSimulation.successRate >= 0)).toBe(true);
    expect(convergence.rows.every((row) => row.plannerEnhancedSimulation.successRate >= 0)).toBe(true);
  }, 120000);
});
