import {
  evaluateDecisionLevers,
  type DecisionEngineReport,
  type PlannerInput,
} from '../decision-engine';
import { clonePlannerInput } from '../decision-engine/helpers';
import type { PathResult } from '../types';
import { buildPathResults } from '../utils';
import {
  getScenarioCompareDefinitionById,
  getScenarioCompareRegistry,
} from './registry';
import type {
  ScenarioCompareOptions,
  ScenarioCompareReport,
  ScenarioCompareResult,
  ScenarioTopRecommendation,
} from './types';

const DEFAULT_SEED = 20260416;

function fnv1aHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function deriveScenarioSeed(
  seedBase: number,
  scenarioId: string,
  strategy: 'shared' | 'scenario_derived',
) {
  if (strategy === 'shared') {
    return seedBase;
  }
  return fnv1aHash(`${seedBase}:${scenarioId}`);
}

function getEarliestFailureYear(path: PathResult) {
  const failures = path.failureYearDistribution
    .filter((point) => point.count > 0)
    .map((point) => point.year)
    .sort((left, right) => left - right);
  return failures[0] ?? null;
}

function toTopRecommendation(report: DecisionEngineReport): ScenarioTopRecommendation | null {
  const top = report.rankedRecommendations[0];
  if (!top) {
    return null;
  }
  return {
    id: top.scenarioId,
    name: top.name,
    summary: top.recommendationSummary,
    successDelta: top.delta.deltaSuccessRate,
  };
}

async function runSingleScenario(
  baselineInput: PlannerInput,
  scenarioId: string,
  scenarioSeed: number,
  options: Required<
    Pick<ScenarioCompareOptions, 'strategyMode' | 'simulationRunsOverride'>
  > & {
    decisionEngineOptions?: ScenarioCompareOptions['decisionEngineOptions'];
  },
): Promise<ScenarioCompareResult> {
  const definition = getScenarioCompareDefinitionById(scenarioId);
  if (!definition) {
    throw new Error(`Unknown scenario id: ${scenarioId}`);
  }

  const scenarioInput = definition.apply(clonePlannerInput(baselineInput));
  const assumptions = {
    ...scenarioInput.assumptions,
    simulationSeed: scenarioSeed,
    simulationRuns: options.simulationRunsOverride,
  };

  const [path] = buildPathResults(
    scenarioInput.data,
    assumptions,
    scenarioInput.selectedStressors,
    scenarioInput.selectedResponses,
    {
      pathMode: 'selected_only',
      strategyMode: options.strategyMode,
    },
  );

  const decisionReport = await evaluateDecisionLevers(
    {
      ...scenarioInput,
      assumptions,
      strategyMode: options.strategyMode,
    },
    {
      ...options.decisionEngineOptions,
      seedBase: scenarioSeed,
      simulationRunsOverride: options.simulationRunsOverride,
      strategyMode: options.strategyMode,
    },
  );

  return {
    scenarioId: definition.id,
    scenarioName: definition.name,
    metrics: {
      successRate: path.successRate,
      medianEndingWealth: path.medianEndingWealth,
      p10EndingWealth: path.endingWealthPercentiles.p10,
      earliestFailureYear: getEarliestFailureYear(path),
    },
    topRecommendation: toTopRecommendation(decisionReport),
  };
}

export async function runScenarioCompare(
  baselineInput: PlannerInput,
  options: ScenarioCompareOptions = {},
): Promise<ScenarioCompareReport> {
  const strategyMode =
    options.strategyMode ?? baselineInput.strategyMode ?? 'planner_enhanced';
  const seedBase = options.seedBase ?? baselineInput.assumptions.simulationSeed ?? DEFAULT_SEED;
  const seedStrategy = options.seedStrategy ?? 'shared';
  const simulationRunsOverride =
    options.simulationRunsOverride ?? baselineInput.assumptions.simulationRuns;
  const scenarioOrder =
    options.scenarioIds?.length
      ? options.scenarioIds
      : getScenarioCompareRegistry().map((scenario) => scenario.id);

  const results: ScenarioCompareResult[] = [];
  for (const scenarioId of scenarioOrder) {
    const scenarioSeed = deriveScenarioSeed(seedBase, scenarioId, seedStrategy);
    const result = await runSingleScenario(
      {
        ...clonePlannerInput(baselineInput),
        strategyMode,
      },
      scenarioId,
      scenarioSeed,
      {
        strategyMode,
        simulationRunsOverride,
        decisionEngineOptions: options.decisionEngineOptions,
      },
    );
    results.push(result);
  }

  return {
    seed: seedBase,
    runCount: simulationRunsOverride,
    strategyMode,
    scenarioOrder,
    results,
  };
}
