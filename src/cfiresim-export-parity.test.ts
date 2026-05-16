import { describe, expect, it } from 'vitest';
import {
  CFIRESIM_CAPTURED_400K_20K_30YR_60_40,
  cfiresimExportFixture,
  summarizeCfiresimExportFixture,
} from './cfiresim-export-parity';
import { externalModelBenchmarkCorpus } from './external-model-benchmark-corpus';

describe('cFIREsim hosted export parity', () => {
  it('keeps the exported benchmark evidence explicit and auditable', () => {
    expect(cfiresimExportFixture.$schemaVersion).toBe(1);
    expect(cfiresimExportFixture.$meta.modelCompleteness).toBe('reconstructed');
    expect(cfiresimExportFixture.$meta.inferredAssumptions.length).toBeGreaterThan(
      0,
    );
    expect(cfiresimExportFixture.$meta.capturedOn).toBe('2026-05-16');
    expect(cfiresimExportFixture.$meta.rawSourceCsvSha256).toHaveLength(64);
    expect(cfiresimExportFixture.$meta.normalizedSourceCsvSha256).toHaveLength(64);
    expect(cfiresimExportFixture.$meta.rawLineCount).toBe(4000);
    expect(cfiresimExportFixture.$meta.repeatedHeaderCount).toBe(124);
    expect(cfiresimExportFixture.$meta.blankSeparatorCount).toBe(125);
    expect(cfiresimExportFixture.$meta.dataRowCount).toBe(3750);
    expect(cfiresimExportFixture.$meta.sourceNotes.join(' ')).toContain(
      'closed-source',
    );

    expect(cfiresimExportFixture.scenario.durationYears).toBe(
      CFIRESIM_CAPTURED_400K_20K_30YR_60_40.durationYears,
    );
    expect(cfiresimExportFixture.scenario.startingBalance).toBe(
      CFIRESIM_CAPTURED_400K_20K_30YR_60_40.startingBalance,
    );
    expect(cfiresimExportFixture.scenario.initialAnnualWithdrawal).toBe(
      CFIRESIM_CAPTURED_400K_20K_30YR_60_40.initialAnnualWithdrawal,
    );
    expect(cfiresimExportFixture.scenario.allocation).toEqual(
      CFIRESIM_CAPTURED_400K_20K_30YR_60_40.allocation,
    );
  });

  it('summarizes the 125 exported cFIREsim cohorts exactly', () => {
    const summary = summarizeCfiresimExportFixture();

    expect(summary.modelCompleteness).toBe('reconstructed');
    expect(summary.inferredAssumptions.length).toBeGreaterThan(0);
    expect(summary.cohortCount).toBe(125);
    expect(summary.rowCount).toBe(3750);
    expect(summary.firstStartYear).toBe(1871);
    expect(summary.lastStartYear).toBe(1995);
    expect(summary.successfulCohorts).toBe(92);
    expect(summary.failedCohorts).toBe(33);
    expect(summary.successRate).toBe(0.736);
    expect(summary.zeroEndingPortfolios).toBe(33);
    expect(summary.averageEndingPortfolioReal).toBeCloseTo(455508.9476, 4);
    expect(summary.medianEndingPortfolioReal).toBe(268909.1874);
    expect(summary.averageEndingPortfolioNominal).toBeCloseTo(809429.1344, 4);
    expect(summary.medianEndingPortfolioNominal).toBe(471312.2401);
    expect(summary.failureStartYears).toEqual([
      1899,
      1901,
      1902,
      1903,
      1905,
      1906,
      1907,
      1909,
      1910,
      1911,
      1912,
      1913,
      1914,
      1916,
      1929,
      1936,
      1937,
      1956,
      1959,
      1960,
      1961,
      1962,
      1963,
      1964,
      1965,
      1966,
      1967,
      1968,
      1969,
      1970,
      1971,
      1972,
      1973,
    ]);
  });

  it('backs the broad cFIREsim external benchmark with the frozen export', () => {
    const benchmark = externalModelBenchmarkCorpus.benchmarks.find(
      (candidate) => candidate.id === 'cfiresim_live_400k_20k_30yr_60_40',
    );
    if (!benchmark || benchmark.kind !== 'historical_rolling_window_survival') {
      throw new Error('Expected cFIREsim rolling-window benchmark to exist.');
    }

    const summary = summarizeCfiresimExportFixture();
    expect(benchmark.externalObservation.cohortCount).toBe(summary.cohortCount);
    expect(benchmark.externalObservation.successfulCohorts).toBe(
      summary.successfulCohorts,
    );
    expect(benchmark.externalObservation.failedCohorts).toBe(
      summary.failedCohorts,
    );
    expect(benchmark.externalObservation.successRate).toBe(summary.successRate);
    expect(benchmark.externalObservation.averageEndingPortfolio).toBe(
      Math.round(summary.averageEndingPortfolioReal),
    );
    expect(benchmark.externalObservation.medianEndingPortfolio).toBe(
      Math.round(summary.medianEndingPortfolioReal),
    );
  });
});
