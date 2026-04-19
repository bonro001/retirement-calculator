import type { MarketAssumptions, SimulationStrategyMode, SeedData } from '../types';
import type { OptimizationObjective } from '../optimization-objective';

export type LeverCategory =
  | 'spending'
  | 'timing'
  | 'allocation'
  | 'assumption'
  | 'housing'
  | 'combo';

export type LeverDisruption = 'low' | 'medium' | 'high';
export type LeverComplexity = 'simple' | 'moderate' | 'complex';

export interface PlannerInput {
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressors: string[];
  selectedResponses: string[];
  strategyMode?: SimulationStrategyMode;
  optimizationObjective?: OptimizationObjective;
}

export interface LeverScenarioDefinition {
  id: string;
  category: LeverCategory;
  name: string;
  description: string;
  disruption: LeverDisruption;
  complexity: LeverComplexity;
  isSensitivity?: boolean;
  apply: (input: PlannerInput) => PlannerInput;
  tags?: string[];
}

export interface RecommendationConstraintRules {
  allowRetirementDelay?: boolean;
  allowSocialSecurityChanges?: boolean;
  allowAllocationChanges?: boolean;
  allowEssentialSpendingCuts?: boolean;
  allowOptionalSpendingCuts?: boolean;
  allowTravelCuts?: boolean;
  allowHomeSaleChanges?: boolean;
  allowEarlierHomeSale?: boolean;
  allowLaterHomeSale?: boolean;
  allowKeepHouseScenario?: boolean;
  allowInheritanceReliance?: boolean;
  allowComboScenarios?: boolean;
}

export interface RecommendationConstraints {
  disallowedCategories?: LeverCategory[];
  disallowedScenarioIds?: string[];
  forbiddenTags?: string[];
  rules?: RecommendationConstraintRules;
  minimumTravelBudgetAnnual?: number;
  minimumOptionalMonthly?: number;
  minimumEssentialMonthly?: number;
}

export type BiggestDriverCategory =
  | 'spending'
  | 'timing'
  | 'allocation'
  | 'housing'
  | 'assumption';

export interface BiggestDriverInsight {
  category: BiggestDriverCategory;
  scenarioName: string;
  deltaSuccessRate: number;
  summary: string;
}

export interface RecommendationSummaryOutput {
  title: string;
  summary: string;
  impact: {
    deltaSuccessRate: number;
  } | null;
  reasoning: string[];
  isFallback: boolean;
}

export interface ExcludedHighImpactLever {
  scenario: string;
  deltaSuccessRate: number;
  reasonExcluded: string;
}

export interface ScenarioMetrics {
  successRate: number;
  failureRate: number;
  medianEndingWealth: number;
  p10EndingWealth: number;
  p90EndingWealth: number;
  earliestFailureYear: number | null;
  percentFailBeforeSocialSecurity: number;
  percentFailBeforeInheritance: number;
  percentFailFirst10Years: number;
}

export interface ScenarioDelta {
  deltaSuccessRate: number;
  deltaMedianEndingWealth: number;
  deltaP10EndingWealth: number;
  deltaEarliestFailureYear: number | null;
  deltaFailFirst10Years: number;
}

export interface LeverScenarioResult {
  scenarioId: string;
  name: string;
  category: LeverScenarioDefinition['category'];
  disruption: LeverScenarioDefinition['disruption'];
  complexity: LeverScenarioDefinition['complexity'];
  tags?: string[];
  isSensitivity: boolean;
  metrics: ScenarioMetrics;
  delta: ScenarioDelta;
  recommendationScore: number;
  recommendationSummary: string;
  tradeoffs: string[];
  excludedByConstraints?: boolean;
  exclusionReasons?: string[];
}

export interface RecommendationScoreWeights {
  successImprovement: number;
  earlyFailureRiskReduction: number;
  p10Improvement: number;
  failureYearDelay: number;
  disruptionPenalty: Record<LeverDisruption, number>;
  complexityPenalty: Record<LeverComplexity, number>;
}

export interface DecisionEngineOptions {
  strategyMode?: SimulationStrategyMode;
  simulationRunsOverride?: number;
  seedBase?: number;
  seedStrategy?: 'shared' | 'scenario_derived';
  maxRecommendations?: number;
  weights?: Partial<RecommendationScoreWeights>;
  constraints?: RecommendationConstraints;
  evaluateExcludedScenarios?: boolean;
}

export interface DecisionEngineReport {
  activeOptimizationObjective: OptimizationObjective;
  baseline: ScenarioMetrics;
  recommendationSummary: RecommendationSummaryOutput;
  baselineRiskWarning: string | null;
  biggestDriver: BiggestDriverInsight | null;
  excludedHighImpactLevers: ExcludedHighImpactLever[];
  activeConstraints: RecommendationConstraints | null;
  excludedScenarioCount: number;
  excludedScenarioNames: string[];
  recommendationUniverseNotes: string[];
  allScenarioResults: LeverScenarioResult[];
  rankedRecommendations: LeverScenarioResult[];
  topLowDisruption: LeverScenarioResult[];
  topHighImpact: LeverScenarioResult[];
  topDefensiveCombos: LeverScenarioResult[];
  worstSensitivityScenarios: LeverScenarioResult[];
  notes: string[];
}
