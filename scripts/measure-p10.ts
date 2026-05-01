// Measure engine p10 ending wealth against Fidelity's published p10
// for the household's actual seed. Phase 2 of the Fidelity p10 tail
// gap calibration. Runs the engine in 4 configurations:
//   1. Default parametric (current Cockpit headline mode)
//   2. Parametric + crash mixture
//   3. Historical bootstrap (already validated within ±3pp Trinity)
//   4. Historical bootstrap + crash mixture (no-op; should match #3)

import { initialSeedData } from '../src/data';
import type { MarketAssumptions } from '../src/types';
import { buildPathResults } from '../src/utils';
import fidelityBaseline from '../fixtures/fidelity_baseline.json';

// The fidelity_baseline.json fixture nests p10 under different keys
// across versions; pick whichever exists. Fall back to the documented
// $436,224 from inline notes.
function findP10(): number {
  const raw = JSON.stringify(fidelityBaseline);
  const m = raw.match(/"assetsRemainingTenthPercentile"\s*:\s*(\d+)/);
  if (m) return Number(m[1]);
  return 436_224;
}
const FIDELITY_P10 = findP10();

const baseAssumptions: MarketAssumptions = {
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
  robPlanningEndAge: 95,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260430,
  assumptionsVersion: 'p10-calibration',
};

function runMode(label: string, overrides: Partial<MarketAssumptions>): void {
  const t0 = Date.now();
  const assumptions = { ...baseAssumptions, ...overrides };
  const [path] = buildPathResults(initialSeedData, assumptions, [], []);
  const dt = Date.now() - t0;
  const p10 = path.tenthPercentileEndingWealth;
  const median = path.medianEndingWealth;
  const success = path.successRate;
  const ratioToFidelity = p10 / FIDELITY_P10;
  console.log(
    `${label.padEnd(40)} p10=$${p10.toLocaleString(undefined, { maximumFractionDigits: 0 })}  ` +
      `(${ratioToFidelity.toFixed(2)}× Fidelity $${FIDELITY_P10.toLocaleString()})  ` +
      `median=$${median.toLocaleString(undefined, { maximumFractionDigits: 0 })}  ` +
      `solvent=${(success * 100).toFixed(1)}%  ` +
      `[${dt}ms]`,
  );
}

console.log(`Fidelity baseline p10: $${FIDELITY_P10.toLocaleString()}`);
console.log('Engine measurements (5000 trials, household actual seed):');
console.log('');

runMode('1. Parametric default', {});
runMode('2. Parametric + crash mixture', { equityTailMode: 'crash_mixture' });
runMode('3. Historical bootstrap', { useHistoricalBootstrap: true });
runMode('4. Historical bootstrap + crash mix', {
  useHistoricalBootstrap: true,
  equityTailMode: 'crash_mixture',
});
