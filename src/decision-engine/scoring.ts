import type {
  LeverScenarioResult,
  LeverComplexity,
  LeverDisruption,
  RecommendationScoreWeights,
  ScenarioDelta,
  ScenarioMetrics,
} from './types';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const COMPLEXITY_RANK: Record<LeverScenarioResult['complexity'], number> = {
  simple: 0,
  moderate: 1,
  complex: 2,
};
const DISRUPTION_RANK: Record<LeverScenarioResult['disruption'], number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export const MIN_RECOMMENDED_SUCCESS_IMPROVEMENT = 0.01;
export const HIGH_DISRUPTION_MIN_SUCCESS_IMPROVEMENT = 0.05;
export const SIMILAR_IMPACT_SUCCESS_DELTA = 0.01;
export const DEDUPE_SUCCESS_DELTA_TOLERANCE = 0.01;
export const DEDUPE_EARLY_FAIL_DELTA_TOLERANCE = 0.01;

export const DEFAULT_RECOMMENDATION_WEIGHTS: RecommendationScoreWeights = {
  successImprovement: 120,
  earlyFailureRiskReduction: 85,
  p10Improvement: 40,
  failureYearDelay: 10,
  disruptionPenalty: {
    low: 8,
    medium: 18,
    high: 34,
  },
  complexityPenalty: {
    simple: 0,
    moderate: 8,
    complex: 18,
  },
};

export function mergeRecommendationWeights(
  override?: Partial<RecommendationScoreWeights>,
): RecommendationScoreWeights {
  if (!override) {
    return DEFAULT_RECOMMENDATION_WEIGHTS;
  }
  return {
    ...DEFAULT_RECOMMENDATION_WEIGHTS,
    ...override,
    disruptionPenalty: {
      ...DEFAULT_RECOMMENDATION_WEIGHTS.disruptionPenalty,
      ...(override.disruptionPenalty ?? {}),
    },
    complexityPenalty: {
      ...DEFAULT_RECOMMENDATION_WEIGHTS.complexityPenalty,
      ...(override.complexityPenalty ?? {}),
    },
  };
}

export interface RecommendationScoreInput {
  baselineMetrics: ScenarioMetrics;
  delta: ScenarioDelta;
  disruption: LeverDisruption;
  complexity: LeverComplexity;
  weights: RecommendationScoreWeights;
}

export function calculateRecommendationScore(input: RecommendationScoreInput) {
  const wealthScale = Math.max(1, Math.abs(input.baselineMetrics.p10EndingWealth), 250_000);
  const successComponent = input.delta.deltaSuccessRate * input.weights.successImprovement;
  const earlyRiskComponent =
    (-input.delta.deltaFailFirst10Years) * input.weights.earlyFailureRiskReduction;
  const p10Component =
    (input.delta.deltaP10EndingWealth / wealthScale) * input.weights.p10Improvement;
  const failureYearComponent =
    ((input.delta.deltaEarliestFailureYear ?? 0) / 10) * input.weights.failureYearDelay;
  const disruptionComponent = input.weights.disruptionPenalty[input.disruption];
  const complexityComponent = input.weights.complexityPenalty[input.complexity];

  const score =
    successComponent +
    earlyRiskComponent +
    p10Component +
    failureYearComponent -
    disruptionComponent -
    complexityComponent;

  return {
    score: clamp(score, -9999, 9999),
    components: {
      successComponent,
      earlyRiskComponent,
      p10Component,
      failureYearComponent,
      disruptionComponent,
      complexityComponent,
    },
  };
}

export function isActionableRecommendation(result: LeverScenarioResult) {
  const summary = result.recommendationSummary.trim();
  return summary.length >= 20;
}

export function passesRecommendationSanityGuards(result: LeverScenarioResult) {
  if ((result.tags ?? []).includes('essential_cut')) {
    return false;
  }
  if (result.excludedByConstraints) {
    return false;
  }
  if (result.isSensitivity) {
    return false;
  }
  if (result.recommendationScore <= 0) {
    return false;
  }
  if (result.delta.deltaSuccessRate < MIN_RECOMMENDED_SUCCESS_IMPROVEMENT) {
    return false;
  }
  if (
    result.disruption === 'high' &&
    result.delta.deltaSuccessRate <= HIGH_DISRUPTION_MIN_SUCCESS_IMPROVEMENT
  ) {
    return false;
  }
  return isActionableRecommendation(result);
}

function getPrimaryActionTag(result: LeverScenarioResult) {
  const tags = result.tags ?? [];
  const priority = [
    'retirement_delay',
    'ss_timing',
    'allocation_change',
    'essential_cut',
    'optional_cut',
    'travel_cut',
    'earlier_home_sale',
    'later_home_sale',
    'keep_house',
    'home_sale',
    'inheritance_sensitive',
    'combo',
  ] as const;
  return (
    priority.find((tag) => tags.includes(tag)) ??
    (result.category === 'combo' ? 'combo' : result.category)
  );
}

export function areRecommendationsEquivalent(
  left: LeverScenarioResult,
  right: LeverScenarioResult,
) {
  const primaryLeft = getPrimaryActionTag(left);
  const primaryRight = getPrimaryActionTag(right);
  if (primaryLeft !== primaryRight) {
    return false;
  }
  if (
    Math.abs(left.delta.deltaSuccessRate - right.delta.deltaSuccessRate) >
    DEDUPE_SUCCESS_DELTA_TOLERANCE
  ) {
    return false;
  }
  if (
    Math.abs(left.delta.deltaFailFirst10Years - right.delta.deltaFailFirst10Years) >
    DEDUPE_EARLY_FAIL_DELTA_TOLERANCE
  ) {
    return false;
  }
  return true;
}

export function compareRecommendationCandidates(
  left: LeverScenarioResult,
  right: LeverScenarioResult,
) {
  const successGap = Math.abs(left.delta.deltaSuccessRate - right.delta.deltaSuccessRate);
  if (successGap <= SIMILAR_IMPACT_SUCCESS_DELTA) {
    if (left.category !== right.category) {
      if (left.category === 'combo') {
        return 1;
      }
      if (right.category === 'combo') {
        return -1;
      }
    }

    const complexityGap =
      COMPLEXITY_RANK[left.complexity] - COMPLEXITY_RANK[right.complexity];
    if (complexityGap !== 0) {
      return complexityGap;
    }

    const disruptionGap =
      DISRUPTION_RANK[left.disruption] - DISRUPTION_RANK[right.disruption];
    if (disruptionGap !== 0) {
      return disruptionGap;
    }
  }

  if (left.recommendationScore !== right.recommendationScore) {
    return right.recommendationScore - left.recommendationScore;
  }
  if (left.delta.deltaSuccessRate !== right.delta.deltaSuccessRate) {
    return right.delta.deltaSuccessRate - left.delta.deltaSuccessRate;
  }
  return left.name.localeCompare(right.name);
}

export function dedupeRecommendationCandidates(
  sortedCandidates: LeverScenarioResult[],
) {
  const selected: LeverScenarioResult[] = [];
  sortedCandidates.forEach((candidate) => {
    const hasEquivalent = selected.some((existing) =>
      areRecommendationsEquivalent(existing, candidate),
    );
    if (!hasEquivalent) {
      selected.push(candidate);
    }
  });
  return selected;
}
