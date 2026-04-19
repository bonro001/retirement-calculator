export type OptimizationObjective =
  | 'preserve_legacy'
  | 'minimize_failure_risk'
  | 'maximize_flat_spending'
  | 'maximize_time_weighted_spending';

export type TimePreferenceWeights = {
  goGo: number;
  slowGo: number;
  late: number;
};

export type SpendingUtilityScope =
  | 'all_spending'
  | 'discretionary_above_essential_floor';

export interface TimeWeightedUtilityInput {
  agesByYear: number[];
  spendingByYear: number[];
  weights: TimePreferenceWeights;
  scope?: SpendingUtilityScope;
  essentialFloorByYear?: number[];
}

export const DEFAULT_TIME_PREFERENCE_WEIGHTS: TimePreferenceWeights = {
  goGo: 1.3,
  slowGo: 1,
  late: 0.65,
};

export function getAgeBandWeight(
  age: number,
  weights: TimePreferenceWeights = DEFAULT_TIME_PREFERENCE_WEIGHTS,
) {
  if (age < 70) {
    return weights.goGo;
  }
  if (age < 80) {
    return weights.slowGo;
  }
  return weights.late;
}

export function computeTimeWeightedSpendingUtility({
  agesByYear,
  spendingByYear,
  weights,
  scope = 'discretionary_above_essential_floor',
  essentialFloorByYear,
}: TimeWeightedUtilityInput) {
  const pointCount = Math.min(agesByYear.length, spendingByYear.length);
  if (!pointCount) {
    return 0;
  }

  let utility = 0;
  for (let index = 0; index < pointCount; index += 1) {
    const age = agesByYear[index] ?? 0;
    const grossSpend = Math.max(0, spendingByYear[index] ?? 0);
    const floor = Math.max(0, essentialFloorByYear?.[index] ?? 0);
    const countedSpend =
      scope === 'all_spending'
        ? grossSpend
        : Math.max(0, grossSpend - floor);
    utility += countedSpend * getAgeBandWeight(age, weights);
  }

  return utility;
}

