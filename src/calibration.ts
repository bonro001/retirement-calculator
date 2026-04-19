import type { SharedAssumptionsPack } from './assumptions-pack';
import type { BoldinBenchmark, PathResult } from './types';

export type CalibrationMetricId =
  | 'success_rate'
  | 'median_ending_wealth'
  | 'median_failure_year'
  | 'annual_tax_estimate';

export type CalibrationMetricUnit = 'percent' | 'currency' | 'year';

export interface CalibrationMetricDelta {
  id: CalibrationMetricId;
  label: string;
  unit: CalibrationMetricUnit;
  current: number | null;
  benchmark: number | null;
  delta: number | null;
  deltaPercent: number | null;
}

export interface CalibrationCompareReport {
  generatedAt: string;
  profileName: string;
  isComplete: boolean;
  completionRate: number;
  metrics: CalibrationMetricDelta[];
}

function toDelta(current: number | null, benchmark: number | null) {
  if (current === null || benchmark === null) {
    return {
      delta: null,
      deltaPercent: null,
    };
  }

  const delta = current - benchmark;
  const deltaPercent = benchmark === 0 ? null : delta / Math.abs(benchmark);

  return { delta, deltaPercent };
}

function getAverageMedianIncome(path: PathResult) {
  if (!path.yearlySeries.length) {
    return 0;
  }

  const totalMedianIncome = path.yearlySeries.reduce((total, row) => total + row.medianIncome, 0);
  return totalMedianIncome / path.yearlySeries.length;
}

export function estimateAnnualTax(path: PathResult, assumptionsPack: SharedAssumptionsPack) {
  const averageMedianIncome = getAverageMedianIncome(path);
  return Math.max(0, averageMedianIncome * assumptionsPack.taxes.heuristicEffectiveRate);
}

export function buildCalibrationCompareReport(
  path: PathResult,
  benchmark: BoldinBenchmark,
  assumptionsPack: SharedAssumptionsPack,
): CalibrationCompareReport {
  const currentTaxEstimate = estimateAnnualTax(path, assumptionsPack);
  const currentMetrics: Record<CalibrationMetricId, number | null> = {
    success_rate: path.successRate * 100,
    median_ending_wealth: path.medianEndingWealth,
    median_failure_year: path.medianFailureYear,
    annual_tax_estimate: currentTaxEstimate,
  };
  const benchmarkMetrics: Record<CalibrationMetricId, number | null> = {
    success_rate: benchmark.successRate,
    median_ending_wealth: benchmark.medianEndingWealth,
    median_failure_year: benchmark.medianFailureYear,
    annual_tax_estimate: benchmark.annualTaxEstimate,
  };
  const metricMeta: Array<{
    id: CalibrationMetricId;
    label: string;
    unit: CalibrationMetricUnit;
  }> = [
    {
      id: 'success_rate',
      label: 'Success %',
      unit: 'percent',
    },
    {
      id: 'median_ending_wealth',
      label: 'Median Ending Wealth',
      unit: 'currency',
    },
    {
      id: 'median_failure_year',
      label: 'Failure Year',
      unit: 'year',
    },
    {
      id: 'annual_tax_estimate',
      label: 'Tax Estimate (Annual)',
      unit: 'currency',
    },
  ];

  const metrics = metricMeta.map((meta) => {
    const current = currentMetrics[meta.id];
    const benchmarkValue = benchmarkMetrics[meta.id];
    const deltas = toDelta(current, benchmarkValue);

    return {
      id: meta.id,
      label: meta.label,
      unit: meta.unit,
      current,
      benchmark: benchmarkValue,
      delta: deltas.delta,
      deltaPercent: deltas.deltaPercent,
    } satisfies CalibrationMetricDelta;
  });

  const completeCount = metrics.filter((metric) => metric.benchmark !== null).length;

  return {
    generatedAt: new Date().toISOString(),
    profileName: assumptionsPack.profileName,
    isComplete: completeCount === metrics.length,
    completionRate: metrics.length ? completeCount / metrics.length : 0,
    metrics,
  };
}
