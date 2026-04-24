// Temporary diagnostic: compare success rates for the app's seed data
// between HEAD and pre-merge commit. Reads only — not an assertion test.
// (Excluded from CI via vitest.config.ts src/.tmp-*.test.ts pattern.)
import { describe, it } from 'vitest';
import { buildPathResults } from './utils';
import { initialSeedData } from './data';
import type { MarketAssumptions } from './types';

const assumptions: MarketAssumptions = {
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
  simulationRuns: 2000,
  irmaaThreshold: 200000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 18,
  guardrailCutPercent: 0.2,
  robPlanningEndAge: 90,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260416,
  assumptionsVersion: 'v1',
};

describe('success rate probe', () => {
  it('prints flex + hands-off success at HEAD', () => {
    const [raw] = buildPathResults(initialSeedData, assumptions, [], [], {
      pathMode: 'selected_only',
      strategyMode: 'raw_simulation',
    });
    const [planner] = buildPathResults(initialSeedData, assumptions, [], [], {
      pathMode: 'selected_only',
      strategyMode: 'planner_enhanced',
    });
    // eslint-disable-next-line no-console
    console.log(
      `PROBE hands-off(raw)=${(raw.successRate * 100).toFixed(1)}% flex(planner)=${(planner.successRate * 100).toFixed(1)}% plannerEndingMedian=${Math.round(planner.medianEndingWealth)} rawEndingMedian=${Math.round(raw.medianEndingWealth)}`,
    );
  }, 120_000);
});
