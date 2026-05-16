import { describe, expect, it } from 'vitest';
import {
  externalModelBenchmarkCorpus,
  runExternalModelBenchmark,
} from './external-model-benchmark-corpus';

describe('external model benchmark corpus', () => {
  it('keeps source metadata and model-completeness labels explicit', () => {
    expect(externalModelBenchmarkCorpus.$schemaVersion).toBe(1);
    expect(externalModelBenchmarkCorpus.benchmarks.length).toBeGreaterThanOrEqual(4);

    const ids = externalModelBenchmarkCorpus.benchmarks.map((benchmark) => benchmark.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const benchmark of externalModelBenchmarkCorpus.benchmarks) {
      expect(benchmark.source.modelName).toBeTruthy();
      expect(benchmark.source.url).toMatch(/^https:\/\//);
      expect(benchmark.source.capturedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(benchmark.source.sourceNotes.length).toBeGreaterThan(40);
      expect(['faithful', 'reconstructed']).toContain(benchmark.modelCompleteness);
      expect(Array.isArray(benchmark.inferredAssumptions)).toBe(true);
      if (benchmark.modelCompleteness === 'reconstructed') {
        expect(benchmark.inferredAssumptions.length).toBeGreaterThan(0);
      }
    }
  });

  for (const benchmark of externalModelBenchmarkCorpus.benchmarks) {
    it(`${benchmark.id} stays inside the frozen external tolerance`, () => {
      const result = runExternalModelBenchmark(benchmark);

      expect(result.passed).toBe(true);

      if (result.kind === 'historical_rolling_window_survival') {
        expect(benchmark.kind).toBe('historical_rolling_window_survival');
        if (benchmark.kind !== 'historical_rolling_window_survival') {
          throw new Error(`Unexpected benchmark kind for ${benchmark.id}`);
        }
        expect(result.local.cohortCount).toBe(benchmark.expectedLocal.cohortCount);
        expect(result.local.successfulCohorts).toBe(
          benchmark.expectedLocal.successfulCohorts,
        );
        expect(result.local.failedCohorts).toBe(benchmark.expectedLocal.failedCohorts);
        expect(result.localSuccessRate).toBeCloseTo(
          benchmark.expectedLocal.successRate,
          12,
        );
        expect(result.local.failureStartYears).toEqual(
          benchmark.expectedLocal.failureStartYears,
        );
        expect(Math.abs(result.successRateDelta)).toBeLessThanOrEqual(
          benchmark.tolerance.successRateAbs,
        );
      } else {
        expect(benchmark.kind).toBe('policyengine_tax_snapshot');
        if (benchmark.kind !== 'policyengine_tax_snapshot') {
          throw new Error(`Unexpected benchmark kind for ${benchmark.id}`);
        }
        expect(Math.abs(result.deltas.adjustedGrossIncome)).toBeLessThanOrEqual(
          benchmark.tolerance.dollarsAbs,
        );
        expect(Math.abs(result.deltas.taxableIncome)).toBeLessThanOrEqual(
          benchmark.tolerance.dollarsAbs,
        );
        expect(Math.abs(result.deltas.federalIncomeTax)).toBeLessThanOrEqual(
          benchmark.tolerance.dollarsAbs,
        );
      }
    });
  }
});
