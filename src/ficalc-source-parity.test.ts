import { describe, expect, it } from 'vitest';
import {
  FICALC_CAPTURED_400K_20K_30YR_60_40,
  ficalcHistoricalFixture,
  runFicalcSourceConstantDollarReplay,
} from './ficalc-source-parity';

describe('FI Calc source-specific historical replay parity', () => {
  it('keeps the extracted source fixture faithful and auditable', () => {
    expect(ficalcHistoricalFixture.$schemaVersion).toBe(1);
    expect(ficalcHistoricalFixture.$meta.modelCompleteness).toBe('faithful');
    expect(ficalcHistoricalFixture.$meta.inferredAssumptions).toEqual([]);
    expect(ficalcHistoricalFixture.$meta.capturedOn).toBe('2026-05-16');
    expect(ficalcHistoricalFixture.$meta.vendorSha256).toHaveLength(64);
    expect(ficalcHistoricalFixture.$meta.workerSha256).toHaveLength(64);
    expect(ficalcHistoricalFixture.annual.length).toBe(
      ficalcHistoricalFixture.$meta.rowCount,
    );
    expect(ficalcHistoricalFixture.annual[0].year).toBe(
      ficalcHistoricalFixture.$meta.firstYear,
    );
    expect(ficalcHistoricalFixture.annual.at(-1)?.year).toBe(
      ficalcHistoricalFixture.$meta.lastYear,
    );
  });

  it('reproduces the live FI Calc 400k / 20k / 30yr / 60-40 capture exactly', () => {
    const replay = runFicalcSourceConstantDollarReplay(
      FICALC_CAPTURED_400K_20K_30YR_60_40,
    );

    expect(replay.modelCompleteness).toBe('faithful');
    expect(replay.inferredAssumptions).toEqual([]);
    expect(replay.cohortCount).toBe(125);
    expect(replay.firstStartYear).toBe(1871);
    expect(replay.lastStartYear).toBe(1995);
    expect(replay.successfulCohorts).toBe(94);
    expect(replay.failedCohorts).toBe(31);
    expect(replay.successRate).toBe(0.752);
    expect(replay.zeroEndingPortfolios).toBe(31);
    expect(replay.medianEndingPortfolioFirstYearDollars).toBe(305693);
    expect(replay.averageEndingPortfolioFirstYearDollars).toBeCloseTo(
      506034.17,
      2,
    );
    expect(replay.failureStartYears).toEqual([
      1973,
      1972,
      1971,
      1970,
      1969,
      1968,
      1967,
      1966,
      1965,
      1964,
      1963,
      1962,
      1961,
      1960,
      1959,
      1956,
      1937,
      1929,
      1916,
      1913,
      1912,
      1911,
      1910,
      1909,
      1907,
      1906,
      1905,
      1903,
      1902,
      1901,
      1899,
    ]);
  });
});
