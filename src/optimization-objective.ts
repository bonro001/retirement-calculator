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

export interface LegacyTargetScoreInput {
  baseUtility: number;
  projectedEndingWealthTodayDollars: number;
  legacyTargetTodayDollars: number;
  deadbandPercent?: number;
  underTargetPenaltyWeight?: number;
  overTargetPenaltyWeight?: number;
}

export interface LegacyTargetScoreResult {
  compositeScore: number;
  distanceToTarget: number;
  overReservedAmount: number;
  underTargetAmount: number;
  penalty: number;
}

export const DEFAULT_TIME_PREFERENCE_WEIGHTS: TimePreferenceWeights = {
  goGo: 1.3,
  slowGo: 1,
  late: 0.65,
};

const DEFAULT_TARGET_DEADBAND_PERCENT = 0.05;
const DEFAULT_UNDER_TARGET_PENALTY_WEIGHT = 1.0;
const DEFAULT_OVER_TARGET_PENALTY_WEIGHT = 0.55;

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

export function scoreUtilityWithLegacyTarget({
  baseUtility,
  projectedEndingWealthTodayDollars,
  legacyTargetTodayDollars,
  deadbandPercent = DEFAULT_TARGET_DEADBAND_PERCENT,
  underTargetPenaltyWeight = DEFAULT_UNDER_TARGET_PENALTY_WEIGHT,
  overTargetPenaltyWeight = DEFAULT_OVER_TARGET_PENALTY_WEIGHT,
}: LegacyTargetScoreInput): LegacyTargetScoreResult {
  const target = Math.max(0, legacyTargetTodayDollars);
  if (target === 0) {
    return {
      compositeScore: baseUtility,
      distanceToTarget: projectedEndingWealthTodayDollars,
      overReservedAmount: Math.max(0, projectedEndingWealthTodayDollars),
      underTargetAmount: 0,
      penalty: 0,
    };
  }

  const projected = Math.max(0, projectedEndingWealthTodayDollars);
  const distanceToTarget = projected - target;
  const deadband = target * Math.max(0, deadbandPercent);
  const underTargetAmount = Math.max(0, target - projected);
  const overReservedAmount = Math.max(0, projected - target);
  const underPenalty =
    Math.max(0, underTargetAmount - deadband) * Math.max(0, underTargetPenaltyWeight);
  const overPenalty =
    Math.max(0, overReservedAmount - deadband) * Math.max(0, overTargetPenaltyWeight);
  const penalty = underPenalty + overPenalty;

  return {
    compositeScore: baseUtility - penalty,
    distanceToTarget,
    overReservedAmount,
    underTargetAmount,
    penalty,
  };
}
