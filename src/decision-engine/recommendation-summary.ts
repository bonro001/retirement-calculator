import type {
  LeverScenarioResult,
  RecommendationConstraints,
  RecommendationSummaryOutput,
  ScenarioMetrics,
} from './types';

const MIN_SUMMARY_IMPROVEMENT = 0.02;
const FALLBACK_MESSAGE =
  'No single low-impact change materially improves the plan. Consider combining smaller adjustments.';

function formatPercentRounded(value: number) {
  return `${Math.round(value * 100)}%`;
}

function toActionPhrase(scenario: LeverScenarioResult) {
  return scenario.name;
}

function buildReasoning(
  scenario: LeverScenarioResult,
  constraints: RecommendationConstraints | null,
) {
  const tags = new Set(scenario.tags ?? []);
  const reasons: string[] = [];
  const retirementDelayDisallowed = constraints?.rules?.allowRetirementDelay === false;

  if (scenario.delta.deltaFailFirst10Years < 0) {
    reasons.push('Improves early failure risk');
  }

  if (!tags.has('retirement_delay')) {
    if (retirementDelayDisallowed) {
      reasons.push('Respects your no-retirement-delay preference');
    } else {
      reasons.push('Does not require delaying retirement');
    }
  } else {
    reasons.push('Requires delaying retirement');
  }

  if (!tags.has('travel_cut')) {
    reasons.push('Maintains travel goals');
  } else {
    reasons.push('Requires a travel reduction tradeoff');
  }

  return reasons.slice(0, 3);
}

function pickSummaryCandidate(rankedRecommendations: LeverScenarioResult[]) {
  const candidates = rankedRecommendations.filter(
    (scenario) => scenario.delta.deltaSuccessRate > MIN_SUMMARY_IMPROVEMENT,
  );
  if (!candidates.length) {
    return null;
  }

  const nonHighDisruption = candidates.filter((scenario) => scenario.disruption !== 'high');
  if (nonHighDisruption.length) {
    return nonHighDisruption[0];
  }
  return candidates[0];
}

export function deriveRecommendationSummary(
  baseline: ScenarioMetrics,
  rankedRecommendations: LeverScenarioResult[],
  constraints: RecommendationConstraints | null,
): RecommendationSummaryOutput {
  const choice = pickSummaryCandidate(rankedRecommendations);
  if (!choice) {
    return {
      title: 'Best Path Forward',
      summary: FALLBACK_MESSAGE,
      impact: null,
      reasoning: [],
      isFallback: true,
    };
  }

  const currentSuccess = baseline.successRate;
  const nextSuccess = baseline.successRate + choice.delta.deltaSuccessRate;
  const preserveRetirementText = (choice.tags ?? []).includes('retirement_delay')
    ? 'though it requires delaying retirement.'
    : 'while preserving your retirement date.';
  const summary = `${toActionPhrase(choice)} to improve success from ${formatPercentRounded(
    currentSuccess,
  )} to ${formatPercentRounded(nextSuccess)} ${preserveRetirementText}`;

  return {
    title: 'Best Path Forward',
    summary,
    impact: {
      deltaSuccessRate: choice.delta.deltaSuccessRate,
    },
    reasoning: buildReasoning(choice, constraints),
    isFallback: false,
  };
}
