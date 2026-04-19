import type { PathResult } from '../types';
import { buildPathResults } from '../utils';
import { deriveBiggestDriverInsight } from './biggest-driver';
import { evaluateScenarioConstraints } from './constraints';
import { deriveExcludedHighImpactLevers } from './excluded-high-impact';
import {
  buildRecommendationSummary,
  buildTopLevelNotes,
  buildTradeoffs,
  deriveBaselineRiskWarning,
} from './explanations';
import { fnv1aHash, clonePlannerInput } from './helpers';
import { toScenarioDelta, toScenarioMetrics } from './metrics';
import {
  calculateRecommendationScore,
  compareRecommendationCandidates,
  dedupeRecommendationCandidates,
  mergeRecommendationWeights,
  passesRecommendationSanityGuards,
} from './scoring';
import { buildLeverScenarioLibrary } from './scenarios';
import { deriveRecommendationSummary } from './recommendation-summary';
import type {
  DecisionEngineOptions,
  DecisionEngineReport,
  LeverScenarioResult,
  PlannerInput,
  RecommendationScoreWeights,
} from './types';

const DEFAULT_SEED = 20260416;
function deriveScenarioSeed(baseSeed: number, scenarioId: string, strategy: 'shared' | 'scenario_derived') {
  if (strategy === 'shared') {
    return baseSeed;
  }
  return fnv1aHash(`${baseSeed}:${scenarioId}`);
}

function runSimulation(input: PlannerInput, seed: number, simulationRunsOverride?: number): PathResult {
  const assumptions = {
    ...input.assumptions,
    simulationSeed: seed,
    ...(typeof simulationRunsOverride === 'number'
      ? { simulationRuns: Math.max(1, Math.round(simulationRunsOverride)) }
      : {}),
  };
  const [path] = buildPathResults(
    input.data,
    assumptions,
    input.selectedStressors,
    input.selectedResponses,
    {
      pathMode: 'selected_only',
      strategyMode: input.strategyMode ?? 'planner_enhanced',
    },
  );
  return path;
}

function isPositiveRecommendationCandidate(result: LeverScenarioResult) {
  return passesRecommendationSanityGuards(result);
}

function toRankedRecommendations(
  scenarios: LeverScenarioResult[],
  maxRecommendations: number,
) {
  const candidates = scenarios
    .filter((scenario) => isPositiveRecommendationCandidate(scenario))
    .sort((left, right) => compareRecommendationCandidates(left, right));
  return dedupeRecommendationCandidates(candidates).slice(0, maxRecommendations);
}

function toTopLowDisruption(results: LeverScenarioResult[]) {
  return results
    .filter((result) => result.disruption === 'low')
    .slice(0, 3);
}

function toTopHighImpact(results: LeverScenarioResult[]) {
  return [...results]
    .sort((left, right) => right.delta.deltaSuccessRate - left.delta.deltaSuccessRate)
    .slice(0, 3);
}

function toTopDefensiveCombos(results: LeverScenarioResult[]) {
  return results.filter((result) => result.category === 'combo').slice(0, 3);
}

function toWorstSensitivityScenarios(allScenarioResults: LeverScenarioResult[]) {
  return allScenarioResults
    .filter((result) => result.isSensitivity)
    .sort((left, right) => {
      if (left.delta.deltaSuccessRate !== right.delta.deltaSuccessRate) {
        return left.delta.deltaSuccessRate - right.delta.deltaSuccessRate;
      }
      return left.delta.deltaP10EndingWealth - right.delta.deltaP10EndingWealth;
    })
    .slice(0, 5);
}

export async function evaluateDecisionLevers(
  baselineInput: PlannerInput,
  options: DecisionEngineOptions = {},
): Promise<DecisionEngineReport> {
  const input = clonePlannerInput({
    ...baselineInput,
    strategyMode: options.strategyMode ?? baselineInput.strategyMode ?? 'planner_enhanced',
  });
  const weights: RecommendationScoreWeights = mergeRecommendationWeights(options.weights);
  const seedBase = options.seedBase ?? input.assumptions.simulationSeed ?? DEFAULT_SEED;
  const seedStrategy = options.seedStrategy ?? 'shared';
  const maxRecommendations = options.maxRecommendations ?? 10;
  const evaluateExcludedScenarios = Boolean(options.evaluateExcludedScenarios);

  const baselinePath = runSimulation(input, seedBase, options.simulationRunsOverride);
  const baselineMetrics = toScenarioMetrics(baselinePath, input);

  const scenarioDefinitions = buildLeverScenarioLibrary();
  const scenarioConstraintEvaluation = evaluateScenarioConstraints(
    scenarioDefinitions,
    input,
    options.constraints,
  );
  const excludedScenarioById = new Map(
    scenarioConstraintEvaluation.excludedScenarios.map((entry) => [entry.scenario.id, entry]),
  );
  const scenarioUniverse = evaluateExcludedScenarios
    ? scenarioDefinitions
    : scenarioConstraintEvaluation.allowedScenarios;

  function evaluateScenarioResult(
    scenario: (typeof scenarioDefinitions)[number],
    exclusionReasons: string[] = [],
  ): LeverScenarioResult {
    const scenarioInput = scenario.apply(clonePlannerInput(input));
    const scenarioSeed = deriveScenarioSeed(seedBase, scenario.id, seedStrategy);
    const scenarioPath = runSimulation(scenarioInput, scenarioSeed, options.simulationRunsOverride);
    const scenarioMetrics = toScenarioMetrics(scenarioPath, scenarioInput);
    const scenarioDelta = toScenarioDelta(baselineMetrics, scenarioMetrics);
    const score = calculateRecommendationScore({
      baselineMetrics,
      delta: scenarioDelta,
      disruption: scenario.disruption,
      complexity: scenario.complexity,
      weights,
    });
    const result: LeverScenarioResult = {
      scenarioId: scenario.id,
      name: scenario.name,
      category: scenario.category,
      disruption: scenario.disruption,
      complexity: scenario.complexity,
      isSensitivity: Boolean(scenario.isSensitivity),
      metrics: scenarioMetrics,
      delta: scenarioDelta,
      recommendationScore: score.score,
      recommendationSummary: '',
      tradeoffs: [],
      excludedByConstraints: exclusionReasons.length > 0,
      exclusionReasons,
      tags: scenario.tags,
    };
    result.recommendationSummary = buildRecommendationSummary(result);
    result.tradeoffs = buildTradeoffs(result);
    return result;
  }

  const allScenarioResults: LeverScenarioResult[] = scenarioUniverse.map((scenario) => {
    const exclusion = excludedScenarioById.get(scenario.id);
    return evaluateScenarioResult(scenario, exclusion?.reasons ?? []);
  });

  const excludedScenarioResults: LeverScenarioResult[] =
    evaluateExcludedScenarios
      ? allScenarioResults.filter((scenario) => scenario.excludedByConstraints)
      : scenarioConstraintEvaluation.excludedScenarios.map((entry) =>
          evaluateScenarioResult(entry.scenario, entry.reasons),
        );

  const rankedRecommendations = toRankedRecommendations(allScenarioResults, maxRecommendations);
  const report: DecisionEngineReport = {
    activeOptimizationObjective: input.optimizationObjective ?? 'maximize_flat_spending',
    baseline: baselineMetrics,
    recommendationSummary: deriveRecommendationSummary(
      baselineMetrics,
      rankedRecommendations,
      scenarioConstraintEvaluation.activeConstraints,
    ),
    baselineRiskWarning: deriveBaselineRiskWarning(baselineMetrics, allScenarioResults),
    biggestDriver: deriveBiggestDriverInsight(allScenarioResults),
    excludedHighImpactLevers: deriveExcludedHighImpactLevers(excludedScenarioResults),
    activeConstraints: scenarioConstraintEvaluation.activeConstraints,
    excludedScenarioCount: scenarioConstraintEvaluation.excludedScenarios.length,
    excludedScenarioNames: scenarioConstraintEvaluation.excludedScenarios.map(
      (entry) => entry.scenario.name,
    ),
    recommendationUniverseNotes: [
      ...scenarioConstraintEvaluation.notes,
      ...(scenarioConstraintEvaluation.excludedScenarios.length
        ? [
            `${scenarioConstraintEvaluation.excludedScenarios.length} scenario(s) were excluded by active recommendation constraints.`,
          ]
        : []),
      ...scenarioConstraintEvaluation.excludedScenarios.flatMap((entry) =>
        entry.reasons.map((reason) => `${entry.scenario.name}: ${reason}`),
      ),
    ],
    allScenarioResults,
    rankedRecommendations,
    topLowDisruption: toTopLowDisruption(rankedRecommendations),
    topHighImpact: toTopHighImpact(rankedRecommendations),
    topDefensiveCombos: toTopDefensiveCombos(rankedRecommendations),
    worstSensitivityScenarios: toWorstSensitivityScenarios(allScenarioResults),
    notes: [],
  };
  report.notes = buildTopLevelNotes(report);
  return report;
}
