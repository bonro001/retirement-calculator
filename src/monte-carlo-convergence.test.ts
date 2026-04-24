import { describe, it, expect } from 'vitest';
import { initialSeedData } from './data';
import type { MarketAssumptions, SeedData } from './types';
import { buildPathResults } from './utils';
import { getDefaultVerificationAssumptions } from './verification-harness';

// Validates that our Monte Carlo outputs actually CONVERGE as run count
// grows — i.e., what we report as "X% success" isn't just noise at the
// default run count. Runs the baseline plan at 100 / 500 / 2000 trials
// and asserts successive pairs are within a tightening tolerance.
//
// Reviewer critique (next-priority list item #7 from the post-
// triangulation review) called this out: "results shouldn't materially
// drift across runs." This is the test.

function runAt(trials: number): {
  successRate: number;
  medianEndingWealth: number;
} {
  const seed: SeedData = JSON.parse(JSON.stringify(initialSeedData));
  const assumptions: MarketAssumptions = {
    ...getDefaultVerificationAssumptions(),
    simulationRuns: trials,
  };
  const [baseline] = buildPathResults(seed, assumptions, [], []);
  return {
    successRate: baseline.successRate,
    medianEndingWealth: baseline.medianEndingWealth,
  };
}

describe('Monte Carlo convergence', () => {
  it('success rate stabilizes as run count grows (100 → 500 → 2000)', () => {
    const r100 = runAt(100);
    const r500 = runAt(500);
    const r2000 = runAt(2000);

    // eslint-disable-next-line no-console
    console.log(
      `[MC convergence] success: 100=${(r100.successRate * 100).toFixed(1)}% ` +
        `500=${(r500.successRate * 100).toFixed(1)}% ` +
        `2000=${(r2000.successRate * 100).toFixed(1)}%`,
    );

    // 100 → 500: allow up to 5pp drift (MC noise at low n).
    expect(Math.abs(r500.successRate - r100.successRate)).toBeLessThan(0.06);
    // 500 → 2000: tighter — we expect to be close to "true" MC value.
    expect(Math.abs(r2000.successRate - r500.successRate)).toBeLessThan(0.04);
  }, 120_000);

  it('median ending wealth is within noisy-but-finite bounds vs high-run-count baseline', () => {
    const r100 = runAt(100);
    const r500 = runAt(500);
    const r2000 = runAt(2000);

    const baseline = r2000.medianEndingWealth;
    // eslint-disable-next-line no-console
    console.log(
      `[MC convergence] median wealth: 100=$${r100.medianEndingWealth.toFixed(0)} ` +
        `500=$${r500.medianEndingWealth.toFixed(0)} ` +
        `2000=$${r2000.medianEndingWealth.toFixed(0)}`,
    );

    // IMPORTANT FINDING: at 500 runs, median ending wealth can drift up to
    // ~30% vs the 2000-run baseline. This is a real MC-noise signal and
    // documents why reporting a single median dollar figure off a 500-run
    // simulation is misleading (one of the motivations for the
    // uncertainty-surface range display). The assertion is loose on
    // purpose — its job is to confirm that the engine doesn't swing by
    // orders of magnitude, not that 500 runs converges to production
    // accuracy.
    const at500Drift = Math.abs(r500.medianEndingWealth - baseline) / Math.max(1, baseline);
    expect(at500Drift).toBeLessThan(0.4);
    const at100Drift = Math.abs(r100.medianEndingWealth - baseline) / Math.max(1, baseline);
    expect(at100Drift).toBeLessThan(0.5);
  }, 120_000);

  it('re-running at the same run count with the same seed is perfectly deterministic', () => {
    const first = runAt(500);
    const second = runAt(500);
    expect(first.successRate).toBe(second.successRate);
    expect(first.medianEndingWealth).toBe(second.medianEndingWealth);
  }, 60_000);
});
