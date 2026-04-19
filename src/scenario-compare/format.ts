import { formatCurrency, formatPercent } from '../utils';
import type { ScenarioCompareDisplayRow, ScenarioCompareReport } from './types';

function formatEarliestFailureYear(value: number | null) {
  return value === null ? 'None' : `${value}`;
}

function formatTopRecommendation(
  recommendation: ScenarioCompareReport['results'][number]['topRecommendation'],
) {
  return recommendation?.name ?? 'No recommendation';
}

export function buildScenarioCompareDisplayRows(
  report: ScenarioCompareReport,
): ScenarioCompareDisplayRow[] {
  return report.results.map((result) => ({
    scenarioId: result.scenarioId,
    scenarioName: result.scenarioName,
    successRate: formatPercent(result.metrics.successRate),
    medianEndingWealth: formatCurrency(result.metrics.medianEndingWealth),
    p10EndingWealth: formatCurrency(result.metrics.p10EndingWealth),
    earliestFailureYear: formatEarliestFailureYear(result.metrics.earliestFailureYear),
    topRecommendation: formatTopRecommendation(result.topRecommendation),
  }));
}
