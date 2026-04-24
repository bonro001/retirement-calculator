import { describe, it, expect } from 'vitest';
import { initialSeedData } from './data';
import type { MarketAssumptions, SeedData } from './types';
import { buildPathResults } from './utils';
import { getDefaultVerificationAssumptions } from './verification-harness';

// Multi-year block bootstrap preserves autocorrelation but AVERAGES
// over single-year extremes. Empirically, block length 1 (iid) produces
// the tightest p10 match to Fidelity's published stress-scenario
// endpoint; longer blocks monotonically widen the p10 gap because they
// include recovery years alongside crisis years. Kept as infrastructure
// for future regime-switching experiments.

function runAt(
  blockLength: number,
  runs: number,
): { successRate: number; p50: number; p10: number } {
  const seed: SeedData = JSON.parse(JSON.stringify(initialSeedData));
  const assumptions: MarketAssumptions = {
    ...getDefaultVerificationAssumptions(),
    simulationRuns: runs,
    useHistoricalBootstrap: true,
    historicalBootstrapBlockLength: blockLength,
  };
  const [path] = buildPathResults(seed, assumptions, [], []);
  return {
    successRate: path.successRate,
    p50: path.medianEndingWealth,
    p10: path.tenthPercentileEndingWealth,
  };
}

describe('block bootstrap', () => {
  it('blockLength=1 (iid) produces a tighter left tail than blockLength=5', () => {
    const iid = runAt(1, 300);
    const block5 = runAt(5, 300);
    // Bigger blocks wash out single-year extremes → higher p10.
    expect(iid.p10).toBeLessThan(block5.p10);
  }, 60_000);

  it('blockLength=1 produces deterministic output under fixed seed', () => {
    const a = runAt(1, 200);
    const b = runAt(1, 200);
    expect(a.p10).toBe(b.p10);
    expect(a.p50).toBe(b.p50);
  }, 60_000);

  it('blockLength=10 preserves multi-year autocorrelation', () => {
    // Longer blocks inflate p50 because crisis clusters tend to be
    // followed by recovery clusters when sampling 10-year windows from
    // the historical fixture.
    const block1 = runAt(1, 200);
    const block10 = runAt(10, 200);
    expect(block10.p50).toBeGreaterThan(block1.p50 * 0.7); // not degenerate
    expect(block10.p10).toBeGreaterThan(block1.p10); // milder tail
  }, 60_000);

  it('undefined blockLength behaves the same as blockLength=1', () => {
    const seed: SeedData = JSON.parse(JSON.stringify(initialSeedData));
    const base: MarketAssumptions = {
      ...getDefaultVerificationAssumptions(),
      simulationRuns: 100,
      useHistoricalBootstrap: true,
    };
    const [pathUndef] = buildPathResults(seed, base, [], []);
    const [pathOne] = buildPathResults(
      seed,
      { ...base, historicalBootstrapBlockLength: 1 },
      [],
      [],
    );
    expect(pathUndef.tenthPercentileEndingWealth).toBe(
      pathOne.tenthPercentileEndingWealth,
    );
  }, 60_000);
});
