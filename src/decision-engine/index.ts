export { evaluateDecisionLevers } from './engine';
export type {
  BiggestDriverInsight,
  DecisionEngineOptions,
  DecisionEngineReport,
  ExcludedHighImpactLever,
  LeverScenarioDefinition,
  LeverScenarioResult,
  PlannerInput,
  RecommendationConstraints,
  RecommendationScoreWeights,
  RecommendationConstraintRules,
  RecommendationSummaryOutput,
  ScenarioDelta,
  ScenarioMetrics,
} from './types';
export { DEFAULT_RECOMMENDATION_WEIGHTS } from './scoring';
export { buildLeverScenarioLibrary } from './scenarios';

import { evaluateDecisionLevers } from './engine';
import type { DecisionEngineOptions, PlannerInput } from './types';

export async function runDecisionEngine(
  baselineInput: PlannerInput,
  options?: DecisionEngineOptions,
) {
  return evaluateDecisionLevers(baselineInput, options);
}
