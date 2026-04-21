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
function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

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
  const startedAt = nowMs();
  const input = clonePlannerInput({
    ...baselineInput,
    strategyMode: options.strategyMode ?? baselineInput.strategyMode ?? 'planner_enhanced',
  });
  const weights: RecommendationScoreWeights = mergeRecommendationWeights(options.weights);
  const seedBase = options.seedBase ?? input.assumptions.simulationSeed ?? DEFAULT_SEED;
  const seedStrategy = options.seedStrategy ?? 'shared';
  const maxRecommendations = options.maxRecommendations ?? 10;
  const evaluateExcludedScenarios = Boolean(options.evaluateExcludedScenarios);
  const skipExcludedScenarioSimulation = Boolean(options.skipExcludedScenarioSimulation);
  const maxScenarioEvaluations = Math.max(
    1,
    Math.round(options.maxScenarioEvaluations ?? Number.MAX_SAFE_INTEGER),
  );
  const simulationRunsUsed = Math.max(
    1,
    Math.round(options.simulationRunsOverride ?? input.assumptions.simulationRuns),
  );

  const baselineStartedAt = nowMs();
  const baselinePath =
    options.baselinePathOverride ??
    runSimulation(input, seedBase, options.simulationRunsOverride);
  const baselineSimulationMs = Number((nowMs() - baselineStartedAt).toFixed(1));
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
  const scenariosToEvaluate = scenarioUniverse.slice(0, maxScenarioEvaluations);
  const scenarioCountSkippedByBudget = Math.max(0, scenarioUniverse.length - scenariosToEvaluate.length);
  const simulationCache = new Map<string, PathResult>();
  let scenarioSimulationTotalMs = 0;

  function evaluateScenarioResult(
    scenario: (typeof scenarioDefinitions)[number],
    exclusionReasons: string[] = [],
  ): LeverScenarioResult {
    const scenarioInput = scenario.apply(clonePlannerInput(input));
    const scenarioSeed = deriveScenarioSeed(seedBase, scenario.id, seedStrategy);
    const scenarioKey = JSON.stringify({
      seed: scenarioSeed,
      simulationRunsOverride: options.simulationRunsOverride ?? null,
      strategyMode: scenarioInput.strategyMode ?? 'planner_enhanced',
      stressors: [...scenarioInput.selectedStressors].sort(),
      responses: [...scenarioInput.selectedResponses].sort(),
      data: scenarioInput.data,
      assumptions: scenarioInput.assumptions,
    });
    let scenarioPath = simulationCache.get(scenarioKey);
    if (!scenarioPath) {
      const scenarioStartedAt = nowMs();
      scenarioPath = runSimulation(scenarioInput, scenarioSeed, options.simulationRunsOverride);
      scenarioSimulationTotalMs += nowMs() - scenarioStartedAt;
      simulationCache.set(scenarioKey, scenarioPath);
    }
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

  const allScenarioResults: LeverScenarioResult[] = scenariosToEvaluate.map((scenario) => {
    const exclusion = excludedScenarioById.get(scenario.id);
    return evaluateScenarioResult(scenario, exclusion?.reasons ?? []);
  });

  const excludedScenarioResults: LeverScenarioResult[] =
    evaluateExcludedScenarios
      ? allScenarioResults.filter((scenario) => scenario.excludedByConstraints)
      : skipExcludedScenarioSimulation
        ? []
        : scenarioConstraintEvaluation.excludedScenarios.map((entry) =>
            evaluateScenarioResult(entry.scenario, entry.reasons),
          );

  const rankedRecommendations = toRankedRecommendations(allScenarioResults, maxRecommendations);
  const runtimeDiagnostics = {
    totalMs: Number((nowMs() - startedAt).toFixed(1)),
    baselineSimulationMs,
    scenarioSimulationTotalMs: Number(scenarioSimulationTotalMs.toFixed(1)),
    scenarioCountEvaluated: allScenarioResults.length,
    scenarioCountTotal: scenarioUniverse.length,
    scenarioCountSkippedByBudget,
    simulationRunsUsed,
  };
  const report: DecisionEngineReport = {
    activeOptimizationObjective: input.optimizationObjective ?? 'maximize_time_weighted_spending',
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
    runtimeDiagnostics,
  };
  report.notes = buildTopLevelNotes(report);
  if (scenarioCountSkippedByBudget > 0) {
    report.notes.push(
      `Runtime budget limited evaluated scenarios to ${allScenarioResults.length} of ${scenarioUniverse.length}.`,
    );
  }
  return report;
}
