import { describe, it, expect } from 'vitest';
import { initialSeedData } from './data';
import type { MarketAssumptions, SeedData } from './types';
import { buildPathResults } from './utils';
import { getDefaultVerificationAssumptions } from './verification-harness';

// The historical-bootstrap sampler (opt-in via
// MarketAssumptions.useHistoricalBootstrap) draws one year's
// (stocks, bonds, cash, inflation) tuple from fixtures/historical_annual_returns.json
// per simulated year. Closes the Fidelity p10 gap because it preserves
// cross-asset correlation, left-skew, and kurtosis for free.

function runWithBootstrap(
  overrides: Partial<MarketAssumptions> = {},
): { medianEndingWealth: number; successRate: number; p10: number } {
  const seed: SeedData = JSON.parse(JSON.stringify(initialSeedData));
  const assumptions: MarketAssumptions = {
    ...getDefaultVerificationAssumptions(),
    simulationRuns: 300,
    useHistoricalBootstrap: true,
    ...overrides,
  };
  const [baseline] = buildPathResults(seed, assumptions, [], []);
  return {
    medianEndingWealth: baseline.medianEndingWealth,
    successRate: baseline.successRate,
    p10: baseline.tenthPercentileEndingWealth,
  };
}

function runWithBoundedNormal(): {
  medianEndingWealth: number;
  successRate: number;
  p10: number;
} {
  const seed: SeedData = JSON.parse(JSON.stringify(initialSeedData));
  const assumptions: MarketAssumptions = {
    ...getDefaultVerificationAssumptions(),
    simulationRuns: 300,
  };
  const [baseline] = buildPathResults(seed, assumptions, [], []);
  return {
    medianEndingWealth: baseline.medianEndingWealth,
    successRate: baseline.successRate,
    p10: baseline.tenthPercentileEndingWealth,
  };
}

describe('historical bootstrap return sampling', () => {
  it('runs the full simulation without crashing', () => {
    const result = runWithBootstrap();
    expect(result.successRate).toBeGreaterThanOrEqual(0);
    expect(result.successRate).toBeLessThanOrEqual(1);
    expect(result.medianEndingWealth).toBeGreaterThanOrEqual(0);
  });

  it('is deterministic under fixed seed', () => {
    const first = runWithBootstrap({ simulationSeed: 12345 });
    const second = runWithBootstrap({ simulationSeed: 12345 });
    expect(first.medianEndingWealth).toBe(second.medianEndingWealth);
    expect(first.successRate).toBe(second.successRate);
    expect(first.p10).toBe(second.p10);
  });

  it('produces a fatter left tail than bounded-normal with matched means', () => {
    // Apples-to-apples comparison: bounded-normal parameterized with the
    // same first and second moments as historical (equity ~10% mean / 16%
    // vol; bonds ~5% / 7%). Even with matched moments, bootstrap should
    // produce a meaningfully worse p10 because historical sequences are
    // left-skewed and kurtotic — 1929-1932, 1966-1974, 2000-2002, 2008
    // are all in the pool. That's the entire point of this change.
    const seed: SeedData = JSON.parse(JSON.stringify(initialSeedData));
    const matchedMomentsAssumptions: MarketAssumptions = {
      ...getDefaultVerificationAssumptions(),
      simulationRuns: 300,
      equityMean: 0.1,
      equityVolatility: 0.16,
      internationalEquityMean: 0.1,
      internationalEquityVolatility: 0.16,
      bondMean: 0.05,
      bondVolatility: 0.07,
      cashMean: 0.03,
      cashVolatility: 0.01,
      inflation: 0.03,
    };
    const [matchedNormal] = buildPathResults(seed, matchedMomentsAssumptions, [], []);
    const bootstrap = runWithBootstrap({ simulationSeed: 424242 });
    expect(bootstrap.p10).toBeLessThanOrEqual(matchedNormal.tenthPercentileEndingWealth);
  });

  it('ignores equity mean/stdev/correlation when bootstrap is on (all no-ops)', () => {
    // Setting equity parameters way off but with bootstrap on should not
    // affect the result: bootstrap samples from historical data, not
    // from the mean/stdDev we passed in.
    const a = runWithBootstrap({
      equityMean: 0.01,
      equityVolatility: 0.01,
      useCorrelatedReturns: false,
    });
    const b = runWithBootstrap({
      equityMean: 0.5,
      equityVolatility: 0.5,
      useCorrelatedReturns: true,
    });
    expect(a.medianEndingWealth).toBe(b.medianEndingWealth);
    expect(a.successRate).toBe(b.successRate);
  });

  it('stress overlays (market_down) still apply on top of bootstrap', () => {
    const seed: SeedData = JSON.parse(JSON.stringify(initialSeedData));
    const assumptions: MarketAssumptions = {
      ...getDefaultVerificationAssumptions(),
      simulationRuns: 200,
      useHistoricalBootstrap: true,
    };
    const [, stressedPath] = buildPathResults(
      seed,
      assumptions,
      ['market_down'],
      [],
    );
    const [baselinePath] = buildPathResults(seed, assumptions, [], []);
    // Stress path should be no better than baseline; usually worse.
    expect(stressedPath.successRate).toBeLessThanOrEqual(
      baselinePath.successRate + 0.02,
    );
  });
});
