import type { DecisionEngineOptions, LeverScenarioResult, PlannerInput } from '../decision-engine';
import type { OptimizationObjective } from '../optimization-objective';
import type { SimulationStrategyMode } from '../types';

export interface ScenarioCompareDefinition {
  id: string;
  name: string;
  description: string;
  apply: (input: PlannerInput) => PlannerInput;
}

export interface ScenarioCompareMetrics {
  successRate: number;
  medianEndingWealth: number;
  p10EndingWealth: number;
  earliestFailureYear: number | null;
}

export interface ScenarioTopRecommendation {
  id: string;
  name: string;
  summary: string;
  successDelta: number;
}

export interface ScenarioCompareResult {
  scenarioId: string;
  scenarioName: string;
  metrics: ScenarioCompareMetrics;
  topRecommendation: ScenarioTopRecommendation | null;
}

export interface ScenarioCompareReport {
  seed: number;
  runCount: number;
  strategyMode: SimulationStrategyMode;
  optimizationObjective: OptimizationObjective;
  scenarioOrder: string[];
  results: ScenarioCompareResult[];
}

export interface ScenarioCompareOptions {
  scenarioIds?: string[];
  seedBase?: number;
  simulationRunsOverride?: number;
  strategyMode?: SimulationStrategyMode;
  seedStrategy?: 'shared' | 'scenario_derived';
  decisionEngineOptions?: Omit<
    DecisionEngineOptions,
    'seedBase' | 'simulationRunsOverride' | 'strategyMode'
  >;
}

export interface ScenarioCompareDisplayRow {
  scenarioId: string;
  scenarioName: string;
  successRate: string;
  medianEndingWealth: string;
  p10EndingWealth: string;
  earliestFailureYear: string;
  topRecommendation: string;
}
