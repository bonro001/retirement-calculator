import type { ExcludedHighImpactLever, LeverScenarioResult } from './types';

const DEFAULT_LIMIT = 3;

function toReason(exclusionReasons: string[] | undefined) {
  if (!exclusionReasons || exclusionReasons.length === 0) {
    return 'Excluded by active recommendation constraints.';
  }
  return exclusionReasons[0];
}

export function deriveExcludedHighImpactLevers(
  scenarios: LeverScenarioResult[],
  limit = DEFAULT_LIMIT,
): ExcludedHighImpactLever[] {
  const cappedLimit = Math.max(1, Math.floor(limit));
  return scenarios
    .filter(
      (scenario) =>
        scenario.excludedByConstraints &&
        scenario.delta.deltaSuccessRate > 0,
    )
    .sort((left, right) => {
      if (left.delta.deltaSuccessRate !== right.delta.deltaSuccessRate) {
        return right.delta.deltaSuccessRate - left.delta.deltaSuccessRate;
      }
      return left.name.localeCompare(right.name);
    })
    .slice(0, cappedLimit)
    .map((scenario) => ({
      scenario: scenario.name,
      deltaSuccessRate: scenario.delta.deltaSuccessRate,
      reasonExcluded: toReason(scenario.exclusionReasons),
    }));
}
