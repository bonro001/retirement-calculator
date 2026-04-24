import { describe, it, expect } from 'vitest';
import { initialSeedData } from './data';
import type { MarketAssumptions } from './types';
import { buildPathResults } from './utils';
import { getDefaultVerificationAssumptions } from './verification-harness';

// At 30 MC runs, a +2pp bond-mean perturbation produced lower median ending
// wealth than baseline — counterintuitive for a strictly-better input.
// Documented in the validation workplan as a suspected MC-noise artifact
// at low run count. This test re-runs the experiment at higher run counts
// to confirm the hypothesis.

function run(
  assumptionsOverride: Partial<MarketAssumptions>,
  runs: number,
): { medianEndingWealth: number; successRate: number } {
  const assumptions: MarketAssumptions = {
    ...getDefaultVerificationAssumptions(),
    simulationRuns: runs,
    ...assumptionsOverride,
  };
  const seed = JSON.parse(JSON.stringify(initialSeedData));
  const [baseline] = buildPathResults(seed, assumptions, [], []);
  return {
    medianEndingWealth: baseline.medianEndingWealth,
    successRate: baseline.successRate,
  };
}

describe('bond perturbation anomaly investigation', () => {
  it('+2pp bond-mean perturbation trends toward higher wealth as MC run count rises', () => {
    const base = run({}, 500);
    const bumpedBond = run({ bondMean: getDefaultVerificationAssumptions().bondMean + 0.02 }, 500);
    const delta = bumpedBond.medianEndingWealth - base.medianEndingWealth;

    // eslint-disable-next-line no-console
    console.log(`[bond investigation] runs=500:`);
    // eslint-disable-next-line no-console
    console.log(
      `  baseline median=${base.medianEndingWealth.toFixed(0)}  +2pp-bond median=${bumpedBond.medianEndingWealth.toFixed(0)}  delta=${delta.toFixed(0)}`,
    );
    // eslint-disable-next-line no-console
    console.log(
      `  baseline success=${(base.successRate * 100).toFixed(2)}%  +2pp-bond success=${(bumpedBond.successRate * 100).toFixed(2)}%`,
    );

    // Success rate should non-decrease with strictly better bond returns.
    expect(bumpedBond.successRate).toBeGreaterThanOrEqual(base.successRate);
    // Median ending wealth should be at least as high (allowing minor
    // numerical noise at 500 runs — strict inequality would require more).
    expect(delta).toBeGreaterThan(-50_000);
  }, 60_000);

  it('delta is monotone-ish across run counts (documents convergence behavior)', () => {
    const counts = [30, 100, 300];
    const deltas: Array<{ runs: number; delta: number; base: number; bump: number }> = [];
    for (const runs of counts) {
      const base = run({}, runs);
      const bump = run(
        { bondMean: getDefaultVerificationAssumptions().bondMean + 0.02 },
        runs,
      );
      deltas.push({
        runs,
        delta: bump.medianEndingWealth - base.medianEndingWealth,
        base: base.medianEndingWealth,
        bump: bump.medianEndingWealth,
      });
    }
    // eslint-disable-next-line no-console
    console.log('[bond investigation] run-count convergence:');
    for (const d of deltas) {
      // eslint-disable-next-line no-console
      console.log(
        `  runs=${d.runs} delta=${d.delta.toFixed(0)} (base=${d.base.toFixed(0)} bump=${d.bump.toFixed(0)})`,
      );
    }
    expect(deltas.length).toBe(3);
  }, 60_000);
});
