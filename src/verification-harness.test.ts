import { describe, expect, it } from 'vitest';
import { initialSeedData } from './data';
import type { MarketAssumptions } from './types';
import { buildPathResults } from './utils';
import { GOLDEN_SCENARIOS } from './verification-scenarios';
import {
  getDefaultVerificationAssumptions,
  runGoldenScenarios,
  summarizePathForVerification,
} from './verification-harness';

describe('verification-harness', () => {
  it('passes parity checks for golden scenarios within tolerance thresholds', () => {
    const reports = runGoldenScenarios(GOLDEN_SCENARIOS);

    expect(reports).toHaveLength(5);
    expect(reports.every((report) => report.pass)).toBe(true);
    expect(
      reports.every((report) =>
        report.comparisons.some((row) => row.metric === 'success_rate'),
      ),
    ).toBe(true);
    expect(
      reports.every((report) =>
        report.comparisons.some((row) => row.metric === 'median_ending_wealth'),
      ),
    ).toBe(true);
    expect(
      reports.every((report) =>
        report.comparisons.some((row) => row.metric === 'annual_tax_estimate'),
      ),
    ).toBe(true);
  });

  it('produces deterministic full-model results for identical seed and assumptions', () => {
    const assumptions: MarketAssumptions = {
      ...getDefaultVerificationAssumptions(),
      simulationRuns: 120,
      simulationSeed: 112233,
      assumptionsVersion: 'repro-test',
    };

    const firstRun = buildPathResults(initialSeedData, assumptions, ['market_down'], ['cut_spending']);
    const secondRun = buildPathResults(initialSeedData, assumptions, ['market_down'], ['cut_spending']);

    expect(secondRun).toEqual(firstRun);
  });

  it('summarizes path outputs for tax, IRMAA, and healthcare signals', () => {
    const assumptions: MarketAssumptions = {
      ...getDefaultVerificationAssumptions(),
      simulationRuns: 80,
      simulationSeed: 443322,
      assumptionsVersion: 'summary-test',
    };
    const path = buildPathResults(initialSeedData, assumptions, [], [])[0];
    const summary = summarizePathForVerification(path);

    expect(summary.successRate).toBeGreaterThanOrEqual(0);
    expect(summary.successRate).toBeLessThanOrEqual(1);
    expect(summary.annualTaxEstimate).toBeGreaterThanOrEqual(0);
    expect(summary.maxIrmaaTier).toBeGreaterThanOrEqual(1);
    expect(summary.averageHealthcarePremiumCost).toBeGreaterThan(0);
  });
});

