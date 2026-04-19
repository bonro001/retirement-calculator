import type {
  BiggestDriverCategory,
  BiggestDriverInsight,
  LeverScenarioResult,
} from './types';

const DRIVER_CATEGORIES: BiggestDriverCategory[] = [
  'spending',
  'timing',
  'allocation',
  'housing',
  'assumption',
];

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

const SIMILAR_IMPACT_DELTA = 0.01;

function compareScenarioByImpact(
  left: LeverScenarioResult,
  right: LeverScenarioResult,
) {
  const successGap = Math.abs(left.delta.deltaSuccessRate - right.delta.deltaSuccessRate);
  if (successGap <= SIMILAR_IMPACT_DELTA) {
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

  if (left.delta.deltaSuccessRate !== right.delta.deltaSuccessRate) {
    return right.delta.deltaSuccessRate - left.delta.deltaSuccessRate;
  }
  return left.name.localeCompare(right.name);
}

function toSummary(
  category: BiggestDriverCategory,
  scenario: LeverScenarioResult,
) {
  if (category === 'timing') {
    if (scenario.name.toLowerCase().includes('social security')) {
      return 'The plan is most sensitive to Social Security claim timing.';
    }
    return 'The plan is most sensitive to retirement timing.';
  }
  if (category === 'spending') {
    return 'Reducing spending has the largest impact on success.';
  }
  if (category === 'allocation') {
    return 'Allocation changes are the largest driver of improvement.';
  }
  if (category === 'housing') {
    return 'Housing policy changes are the largest driver of improvement.';
  }
  if (scenario.name.toLowerCase().includes('inheritance')) {
    return 'The plan heavily depends on the inheritance assumption.';
  }
  return 'The plan is highly sensitive to key planning assumptions.';
}

function getCategoryWinner(
  category: BiggestDriverCategory,
  scenarios: LeverScenarioResult[],
) {
  const candidates = scenarios
    .filter((scenario) => scenario.category === category)
    .sort((left, right) => compareScenarioByImpact(left, right));
  return candidates[0] ?? null;
}

export function deriveBiggestDriverInsight(
  scenarios: LeverScenarioResult[],
): BiggestDriverInsight | null {
  const eligibleScenarios = scenarios.filter(
    (scenario) =>
      !scenario.excludedByConstraints &&
      !scenario.isSensitivity &&
      scenario.category !== 'combo' &&
      scenario.delta.deltaSuccessRate > 0,
  );

  const categoryWinners = DRIVER_CATEGORIES.map((category) =>
    getCategoryWinner(category, eligibleScenarios),
  ).filter((winner): winner is LeverScenarioResult => winner !== null);

  if (!categoryWinners.length) {
    return null;
  }

  const top = [...categoryWinners].sort((left, right) =>
    compareScenarioByImpact(left, right),
  )[0];

  return {
    category: top.category as BiggestDriverCategory,
    scenarioName: top.name,
    deltaSuccessRate: top.delta.deltaSuccessRate,
    summary: toSummary(top.category as BiggestDriverCategory, top),
  };
}
