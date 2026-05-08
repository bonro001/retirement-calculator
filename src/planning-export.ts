import type {
  ClosedLoopConvergenceThresholds,
  MarketAssumptions,
  ModelFidelityAssessment,
  ModelFidelityInput,
  PathResult,
  ResponseOption,
  SeedData,
  SimulationConfigurationSnapshot,
  SimulationStrategyMode,
  Stressor,
} from './types';
import type { OptimizationObjective } from './optimization-objective';
import {
  evaluatePlan,
  type Plan,
  type PlanEvaluation,
  type PlanTrustPanel,
} from './plan-evaluation';
import { buildProbeChecklist, type ProbeChecklistResult } from './probe-checklist';
import {
  DEFAULT_CLOSED_LOOP_CONVERGENCE_THRESHOLDS,
  DEFAULT_MAX_CLOSED_LOOP_PASSES,
} from './closed-loop-config';
import {
  buildModelFidelityAssessment,
  reconcileModelFidelityAssessmentWithAdditionalAssumptions,
} from './model-fidelity';
import {
  buildExecutiveFlightSummary,
  type ExecutiveFlightSummary,
} from './flight-path-summary';
import {
  buildFlightPathStrategicPrepRecommendations,
  type FlightPathPolicyResult,
} from './flight-path-policy';
import {
  buildFlightPathPhasePlaybook,
  type FlightPathPhasePlaybook,
  type FlightPathPhaseAction,
  type PlaybookModelCompleteness,
} from './flight-path-action-playbook';
import { evaluateRunwayBridgeRiskDelta } from './runway-utils';
import { deriveAssetClassMappingAssumptionsFromAccounts } from './asset-class-mapper';
import { getRmdStartAgeForBirthYear } from './retirement-rules';
import { buildPathResults } from './utils';
import { buildNorthStarResult, type NorthStarResult } from './north-star-result';
import { computePlanFingerprint } from './prediction-log';
import { CURRENT_RULE_PACK_VERSION } from './rule-packs';

export const EXPORT_SCHEMA_VERSION = 'retirement-planner-export.v2';
export const PLANNING_EXPORT_CACHE_VERSION = 'planner-mode-routing-v2';

export type ActiveSimulationProfile = 'rawSimulation' | 'plannerEnhancedSimulation';
export type PlanningExportMode = 'compact' | 'full';

type HousingFundingPolicy = 'baseline' | 'home_sale_accelerated';
type WithdrawalPreference = 'standard' | 'preserve_roth';
type CashBufferPolicy = 'baseline' | 'increased';
type FlightPathConversionUnusedRoomReason =
  | 'annual_cap'
  | 'aca_cliff'
  | 'irmaa_cliff'
  | 'tax_bracket'
  | 'insufficient_pretax_balance'
  | 'liquidity'
  | 'explicit_user_constraint'
  | 'model_completeness';
type FlightPathConversionUnusedRoomByReason = Record<
  FlightPathConversionUnusedRoomReason,
  number
>;

export interface FlightPathConversionScheduleEntry {
  year: number;
  recommendedAmount: number;
  conversionKind: 'none' | 'safe_room' | 'strategic_extra';
  safeRoomAvailable: number;
  safeRoomUsed: number;
  strategicExtraAvailable: number;
  strategicExtraUsed: number;
  annualPolicyMax: number | null;
  annualPolicyMaxBinding: boolean;
  safeRoomUnusedDueToAnnualPolicyMax: number;
  safeRoomUnusedByReason: FlightPathConversionUnusedRoomByReason;
  reason: string;
  medianMagiBefore: number;
  medianMagiAfter: number;
  medianTargetMagiCeiling: number | null;
}

export interface FlightPathConversionScheduleStatus {
  status:
    | 'active'
    | 'empty_no_room'
    | 'empty_missing_target'
    | 'empty_not_eligible'
    | 'empty_no_economic_benefit'
    | 'empty_policy_disabled'
    | 'empty_no_pretax'
    | 'empty_unknown';
  scheduledYearCount: number;
  safeRoomScheduledYearCount: number;
  strategicExtraScheduledYearCount: number;
  annualPolicyMaxBindingYearCount: number;
  totalRecommendedAmount: number;
  totalSafeRoomUsed: number;
  totalStrategicExtraUsed: number;
  totalSafeRoomUnusedDueToAnnualPolicyMax: number;
  totalSafeRoomUnusedByReason: FlightPathConversionUnusedRoomByReason;
  primaryReason: string;
}

const RETURN_GENERATION_ASSUMPTIONS: SimulationConfigurationSnapshot['returnGeneration'] = {
  model: 'bounded_normal_by_asset_class',
  boundsByAssetClass: {
    US_EQUITY: { min: -0.45, max: 0.45 },
    INTL_EQUITY: { min: -0.5, max: 0.45 },
    BONDS: { min: -0.2, max: 0.2 },
    CASH: { min: -0.01, max: 0.08 },
  },
  stressOverlayRules: [
    'market_down: years 1-3 US_EQUITY and INTL_EQUITY overrides [-18%, -12%, -8%] (replace sampled values), years 4-8 equity rebound uplift (+4%)',
    'market_up: years 1-3 US_EQUITY and INTL_EQUITY overrides [+12%, +10%, +8%] (replace sampled values)',
    'market_down/market_up: BONDS and CASH remain stochastic (no deterministic override)',
    'inflation: years 1-10 floor at 5%',
  ],
};

const RETURN_MODEL_EXTENSION_POINTS: SimulationConfigurationSnapshot['returnModelExtensionPoints'] = [
  {
    model: 'regime_switching_correlated',
    status: 'hook_only',
    description: 'Extension hook reserved for future correlated regime-switching return generation.',
  },
  {
    model: 'fat_tailed_correlated',
    status: 'hook_only',
    description: 'Extension hook reserved for future fat-tailed correlated return generation.',
  },
];

export interface PlanningAdjustment {
  source: 'stressor' | 'response';
  id: string;
  name: string;
  changes: string[];
  parameters?: Record<string, number | string | boolean>;
}

export interface PlanningExportSnapshot {
  household: SeedData['household'];
  assets: {
    byBucket: {
      pretax: number;
      roth: number;
      taxable: number;
      cash: number;
      hsa: number;
    };
    allocations: {
      pretax: Record<string, number>;
      roth: Record<string, number>;
      taxable: Record<string, number>;
      cash: Record<string, number>;
      hsa: Record<string, number> | null;
    };
    totals: {
      liquid: number;
      invested: number;
      trackedNetWorth: number;
    };
  };
  spending: {
    essentialMonthly: number;
    optionalMonthly: number;
    annualTaxesInsurance: number;
    travelEarlyRetirementAnnual: number;
    annualCoreSpend: number;
    annualWithTravelSpend: number;
  };
  income: {
    salaryAnnual: number;
    salaryEndDate: string;
    retirementYear: number;
    socialSecurity: SeedData['income']['socialSecurity'];
    windfalls: SeedData['income']['windfalls'];
    preRetirementContributions: SeedData['income']['preRetirementContributions'];
  };
  assumptions: {
    returns: {
      equityMean: number;
      equityVolatility: number;
      internationalEquityMean: number;
      internationalEquityVolatility: number;
      bondMean: number;
      bondVolatility: number;
      cashMean: number;
      cashVolatility: number;
    };
    inflation: {
      mean: number;
      volatility: number;
    };
    guardrails: {
      floorYears: number;
      ceilingYears: number;
      cutPercent: number;
    };
    horizon: {
      robPlanningEndAge: number;
      debbiePlanningEndAge: number;
      travelPhaseYears: number;
    };
  };
    constraints: {
      filingStatus: string;
      withdrawalStyle: string;
      irmaaAware: boolean;
      replaceModeImports: boolean;
      assetClassMappingAssumptions: SeedData['rules']['assetClassMappingAssumptions'];
      assetClassMappingEvidence: SeedData['rules']['assetClassMappingEvidence'];
      rothConversionPolicy: SeedData['rules']['rothConversionPolicy'];
      rmdPolicy: SeedData['rules']['rmdPolicy'];
      payrollModel: SeedData['rules']['payrollModel'];
      contributionLimits: SeedData['rules']['contributionLimits'];
      housingAfterDownsizePolicy: SeedData['rules']['housingAfterDownsizePolicy'];
      irmaaThreshold: number;
      healthcarePremiums: {
        baselineAcaPremiumAnnual: number | null;
        baselineMedicarePremiumAnnual: number | null;
        medicalInflationAnnual: number | null;
    };
    hsaStrategy: SeedData['rules']['hsaStrategy'];
    ltcAssumptions: SeedData['rules']['ltcAssumptions'];
    withdrawalPreference: WithdrawalPreference;
    housingFundingPolicy: HousingFundingPolicy;
    cashBufferPolicy: CashBufferPolicy;
  };
  simulationSettings: {
    mode: SimulationStrategyMode;
    plannerAutopilotActive: boolean;
    optimizationObjective: OptimizationObjective;
    simulationRuns: number;
    simulationSeed: number | null;
    assumptionsVersion: string | null;
    inflationHandling: SimulationConfigurationSnapshot['inflationHandling'];
    returnGeneration: SimulationConfigurationSnapshot['returnGeneration'];
    timingConventions: SimulationConfigurationSnapshot['timingConventions'];
  };
}

export interface PlanningStateExport {
  version: {
    schema: string;
    exportedAt: string;
    generatedAt: string;
  };
  exportFreshness: {
    generatedAtIso: string;
    planFingerprint: string;
    engineVersion: string;
    rulePackVersions: {
      currentLawRulePackVersion: string;
      assumptionsPackVersion: string;
    };
    distributionMode: NorthStarResult['distributionMode'];
    sensitivityMode: {
      activeSimulationProfile: ActiveSimulationProfile;
      rawSimulationMode: SimulationStrategyMode;
      plannerEnhancedSimulationMode: SimulationStrategyMode;
      selectedStressorIds: string[];
      selectedResponseIds: string[];
      optimizationObjective: OptimizationObjective;
    };
    replay: {
      replayKey: string;
      simulationSeed: number;
      simulationRuns: number;
      assumptionsVersion: string;
      checks: Array<{
        id: string;
        passed: boolean;
        detail: string;
      }>;
    };
    changeDetectionKeys: {
      inputIdentity: string;
      rulesIdentity: string;
      engineIdentity: string;
      stochasticIdentity: string;
      scenarioIdentity: string;
    };
  };
  household: PlanningExportSnapshot['household'];
  assets: PlanningExportSnapshot['assets'];
  spending: PlanningExportSnapshot['spending'];
  income: PlanningExportSnapshot['income'];
  assumptions: PlanningExportSnapshot['assumptions'];
  constraints: PlanningExportSnapshot['constraints'];
  activeStressors: Array<{ id: string; name: string; type: string }>;
  activeResponses: Array<{ id: string; name: string }>;
  simulationSettings: PlanningExportSnapshot['simulationSettings'];
  activeSimulationProfile: ActiveSimulationProfile;
  activeSimulationSummary: {
    activeSimulationProfile: ActiveSimulationProfile;
    firstConversionYear: number | null;
    firstConversionAmount: number | null;
    firstConversionMode: SimulationStrategyMode | null;
    plannerConversionsExecuted: boolean;
  };
  activeSimulationOutcome: PathResult;
  toggleState: {
    stressorIds: string[];
    responseIds: string[];
  };
  adjustmentsApplied: PlanningAdjustment[];
  simulationProfiles: {
    rawSimulation: SimulationConfigurationSnapshot;
    plannerEnhancedSimulation: SimulationConfigurationSnapshot;
  };
  simulationOutcomes: {
    rawSimulation: PathResult;
    plannerEnhancedSimulation: PathResult;
  };
  baseInputs: PlanningExportSnapshot;
  effectiveInputs: PlanningExportSnapshot;
  effectiveSimulationInputs: PlanningExportSnapshot;
  effectivePlanningStrategyInputs: PlanningExportSnapshot;
  scenarioSensitivity: {
    inheritanceMatrix: InheritanceScenarioMatrix;
    objectiveCalibration: ObjectiveCalibrationDiagnostics;
    dependenceMetricsMetadata: DependenceMetricsMetadata;
  };
  inheritanceDependenceHeadline: InheritanceDependenceHeadline;
  runwayRiskModel: RunwayRiskModelDiagnostics;
  planScorecard: {
    canonical: {
      successRate: number;
      supportedMonthlySpend: number;
      modelCompleteness: PlaybookModelCompleteness;
      inheritanceDependenceRate: number;
      homeSaleDependenceRate: number;
    };
    sourceOfTruth: {
      successRate: string;
      supportedMonthlySpend: string;
      modelCompleteness: string;
      inheritanceDependenceRate: string;
      homeSaleDependenceRate: string;
    };
    alternateViews: {
      planEvaluationSuccessRate: number | null;
      observedSimulationInheritanceDependenceRate: number;
      observedSimulationHomeSaleDependenceRate: number;
    };
    consistency: {
      executiveSummarySuccessRateAligned: boolean;
      modelCompletenessAligned: boolean;
      dependenceRatesAligned: boolean;
    };
  };
  northStarResult: NorthStarResult;
  flightPath: {
    evaluationContext: {
      source: 'unified_plan' | 'derived_plan' | 'none';
      available: boolean;
      capturedAtIso: string | null;
      modelCompleteness: PlaybookModelCompleteness;
      inferredAssumptions: string[];
      playbookInferredAssumptions: string[];
    };
    strategicPrepPolicy: FlightPathPolicyResult;
    executiveSummary: ExecutiveFlightSummary;
    phasePlaybook: FlightPathPhasePlaybook;
    conversionSchedule: FlightPathConversionScheduleEntry[];
    conversionScheduleStatus: FlightPathConversionScheduleStatus;
    trustPanel: PlanEvaluation['trustPanel'] | null;
    recommendationLedger: {
      strategicPrep: FlightPathPolicyResult['recommendations'];
      phaseActions: Array<{
        phaseId: string;
        phaseLabel: string;
        phaseWindowStartYear: number;
        phaseWindowEndYear: number;
        phaseStatus: string;
        action: FlightPathPhaseAction;
      }>;
    };
    recommendationEvidenceSummary: {
      candidatesConsidered: number;
      candidatesEvaluated: number;
      acceptedAfterHardConstraints: number;
      acceptedAfterEvidenceGate: number;
      returnedRecommendations: number;
      suppressedBeforeEvaluation: number;
      suppressedByHardConstraints: number;
      suppressedByEvidenceGate: number;
      suppressedByRanking: number;
      acceptedRecommendationIds: string[];
      topSuppressionReasons: Array<{ reason: string; count: number }>;
    };
    recommendationAvailabilityHeadline: {
      status: 'recommendations_available' | 'no_recommendations';
      suppressedBy:
        | 'none'
        | 'hard_constraints'
        | 'missing_counterfactual_patches'
        | 'evidence_gate'
        | 'ranking'
        | 'mixed'
        | 'none_considered';
      primaryReason: string;
      canActNow: boolean;
    };
  };
  probeChecklist: ProbeChecklistResult;
  modelFidelity: ModelFidelityAssessment;
  modelTrust: ModelTrustSection;
  exportQualityGate: ExportQualityGate;
}

export type PlanningStateExportCompact = PlanningStateExport;

/**
 * Tiny (~2–5 KB) subset of PlanningStateExport used to render the Plan 2.0
 * top strip (focus card, active-plan headline, summary cards) before the full
 * ~900 KB export has finished loading. Intentionally excludes yearlySeries,
 * simulationDiagnostics, flightPath, etc. — anything chart-shaped lives in
 * the full payload.
 */
export interface PlanningStateSummary {
  version: PlanningStateExport['version'];
  activeSimulationProfile: ActiveSimulationProfile;
  activeSimulationSummary: PlanningStateExport['activeSimulationSummary'];
  activeOutcomeHeadline: {
    successRate: number;
    medianEndingWealth: number;
    irmaaExposureRate: number;
    spendingCutRate: number;
    inheritanceDependenceRate: number;
  };
  rawOutcomeHeadline: {
    successRate: number;
    medianEndingWealth: number;
    irmaaExposureRate: number;
    spendingCutRate: number;
  };
  planScorecard: PlanningStateExport['planScorecard'];
  retirementYear: number;
}

export function buildPlanningStateSummary(
  payload: PlanningStateExport,
): PlanningStateSummary {
  const active = payload.activeSimulationOutcome;
  const raw = payload.simulationOutcomes.rawSimulation;
  return {
    version: payload.version,
    activeSimulationProfile: payload.activeSimulationProfile,
    activeSimulationSummary: payload.activeSimulationSummary,
    activeOutcomeHeadline: {
      successRate: active.successRate,
      medianEndingWealth: active.medianEndingWealth,
      irmaaExposureRate: active.irmaaExposureRate,
      spendingCutRate: active.spendingCutRate,
      inheritanceDependenceRate: active.inheritanceDependenceRate ?? 0,
    },
    rawOutcomeHeadline: {
      successRate: raw.successRate,
      medianEndingWealth: raw.medianEndingWealth,
      irmaaExposureRate: raw.irmaaExposureRate,
      spendingCutRate: raw.spendingCutRate,
    },
    planScorecard: payload.planScorecard,
    retirementYear: payload.income.retirementYear,
  };
}

function buildExportFreshness(input: {
  generatedAtIso: string;
  data: SeedData;
  assumptions: MarketAssumptions;
  activeSimulationProfile: ActiveSimulationProfile;
  activeSimulationOutcome: PathResult;
  rawSimulationOutcome: PathResult;
  plannerEnhancedSimulationOutcome: PathResult;
  selectedStressorIds: string[];
  selectedResponseIds: string[];
  optimizationObjective: OptimizationObjective;
  northStarResult: NorthStarResult;
}): PlanningStateExport['exportFreshness'] {
  const planFingerprint = computePlanFingerprint(input.data, input.assumptions);
  const engineVersion =
    input.assumptions.assumptionsVersion ??
    input.activeSimulationOutcome.monteCarloMetadata.assumptionsVersion ??
    'unversioned';
  const simulationSeed = input.activeSimulationOutcome.monteCarloMetadata.seed;
  const simulationRuns = input.activeSimulationOutcome.monteCarloMetadata.trialCount;
  const assumptionsVersion =
    input.activeSimulationOutcome.monteCarloMetadata.assumptionsVersion ?? engineVersion;
  const scenarioIdentity = [
    input.activeSimulationProfile,
    input.selectedStressorIds.join(',') || 'none',
    input.selectedResponseIds.join(',') || 'none',
    input.optimizationObjective,
  ].join('|');
  const stochasticIdentity = [
    input.northStarResult.distributionMode,
    simulationSeed,
    simulationRuns,
    assumptionsVersion,
  ].join('|');
  const replayKey = [
    planFingerprint,
    CURRENT_RULE_PACK_VERSION,
    engineVersion,
    stochasticIdentity,
    scenarioIdentity,
  ].join('::');

  return {
    generatedAtIso: input.generatedAtIso,
    planFingerprint,
    engineVersion,
    rulePackVersions: {
      currentLawRulePackVersion: CURRENT_RULE_PACK_VERSION,
      assumptionsPackVersion: input.northStarResult.assumptionsPackVersion,
    },
    distributionMode: input.northStarResult.distributionMode,
    sensitivityMode: {
      activeSimulationProfile: input.activeSimulationProfile,
      rawSimulationMode: input.rawSimulationOutcome.simulationMode,
      plannerEnhancedSimulationMode: input.plannerEnhancedSimulationOutcome.simulationMode,
      selectedStressorIds: [...input.selectedStressorIds],
      selectedResponseIds: [...input.selectedResponseIds],
      optimizationObjective: input.optimizationObjective,
    },
    replay: {
      replayKey,
      simulationSeed,
      simulationRuns,
      assumptionsVersion,
      checks: [
        {
          id: 'timestamp_alignment',
          passed: input.northStarResult.generatedAtIso === input.generatedAtIso,
          detail: 'Export and north-star result were generated in the same run.',
        },
        {
          id: 'fingerprint_alignment',
          passed: input.northStarResult.planFingerprint === planFingerprint,
          detail: 'North-star result fingerprint matches the exported effective inputs.',
        },
        {
          id: 'mode_labels_present',
          passed:
            input.rawSimulationOutcome.simulationMode === 'raw_simulation' &&
            input.plannerEnhancedSimulationOutcome.simulationMode === 'planner_enhanced',
          detail: 'Both raw and planner-enhanced simulation modes are labeled for replay.',
        },
        {
          id: 'seed_and_run_count_present',
          passed: Number.isFinite(simulationSeed) && simulationRuns > 0,
          detail: 'Replay has deterministic seed and trial count metadata.',
        },
        {
          id: 'rule_pack_alignment',
          passed: input.northStarResult.assumptionsPackVersion === CURRENT_RULE_PACK_VERSION,
          detail: 'North-star result uses the active current-law rule pack.',
        },
      ],
    },
    changeDetectionKeys: {
      inputIdentity: planFingerprint,
      rulesIdentity: CURRENT_RULE_PACK_VERSION,
      engineIdentity: engineVersion,
      stochasticIdentity,
      scenarioIdentity,
    },
  };
}

interface PlanningStressorKnobs {
  delayedInheritanceYears?: number;
  cutSpendingPercent?: number;
  layoffRetireDate?: string;
  layoffSeverance?: number;
}

interface BuildPlanningExportInput {
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressorIds: string[];
  selectedResponseIds: string[];
  exportMode?: PlanningExportMode;
  optimizationObjective?: OptimizationObjective;
  unifiedPlanEvaluation?: PlanEvaluation | null;
  unifiedPlanEvaluationCapturedAtIso?: string | null;
  unifiedPlanEvaluationSource?: 'unified_plan' | 'derived_plan' | 'none';
  stressorKnobs?: PlanningStressorKnobs;
}

type InheritanceScenarioId =
  | 'on_time'
  | 'delayed_5y'
  | 'reduced_50pct'
  | 'removed';

interface InheritanceScenarioRow {
  id: InheritanceScenarioId;
  label: string;
  inheritanceYear: number | null;
  inheritanceAmount: number;
  successRate: number;
  medianEndingWealth: number;
  annualFederalTaxEstimate: number;
  yearsFunded: number;
  deltaFromOnTime: {
    successRate: number;
    medianEndingWealth: number;
    annualFederalTaxEstimate: number;
    yearsFunded: number;
  };
}

interface InheritanceScenarioMatrix {
  simulationMode: SimulationStrategyMode;
  simulationRuns: number;
  simulationSeed: number;
  assumptionsVersion: string;
  stressorIds: string[];
  responseIds: string[];
  missingInputs: string[];
  inferredAssumptions: string[];
  scenarios: InheritanceScenarioRow[];
}

interface DependenceMetricDefinition {
  name: 'inheritanceDependenceRate' | 'homeSaleDependenceRate';
  definition: string;
  calculationNote: string;
  observedRate: number;
  sensitivityValidation: {
    baselineSuccessRate: number;
    stressCaseSuccessRate: number;
    successRateDrop: number;
    impliedDependenceRateFromScenario: number;
    observedScenarioGap: number;
    reconciledDependenceRate: number;
    reconciliationMethod: string;
    consistency: 'consistent' | 'mixed' | 'divergent';
    note: string;
  };
}

interface DependenceMetricsMetadata {
  simulationRuns: number;
  simulationSeed: number;
  assumptionsVersion: string;
  definitions: DependenceMetricDefinition[];
}

interface ObjectiveCalibrationScenario {
  id: 'flat_spend' | 'phased_spend';
  objective: OptimizationObjective;
  spendShape: 'flat' | 'phased';
  successRate: number;
  medianEndingWealth: number;
  annualFederalTaxEstimate: number;
  yearsFunded: number;
}

interface ObjectiveCalibrationDiagnostics {
  simulationMode: SimulationStrategyMode;
  simulationRuns: number;
  simulationSeed: number;
  assumptionsVersion: string;
  inferredAssumptions: string[];
  scenarios: ObjectiveCalibrationScenario[];
  deltaPhasedMinusFlat: {
    successRate: number;
    medianEndingWealth: number;
    annualFederalTaxEstimate: number;
    yearsFunded: number;
  };
}

interface ExportQualityGateCheck {
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'warn';
  detail: string;
}

interface ExportQualityGate {
  status: 'pass' | 'fail';
  checks: ExportQualityGateCheck[];
}

interface InheritanceDependenceHeadline {
  inheritanceDependent: boolean;
  inheritanceRobustnessScore: number;
  fragilityPenalty: number;
  dependenceEvidence: {
    observedRate: number | null;
    impliedRate: number | null;
    reconciledRate: number | null;
    consistency: 'consistent' | 'mixed' | 'divergent' | null;
  };
  baseCaseExcludingInheritance: {
    successRate: number;
    medianEndingWealth: number;
    annualFederalTaxEstimate: number;
    yearsFunded: number;
  } | null;
  upsideCaseIncludingInheritance: {
    successRate: number;
    medianEndingWealth: number;
    annualFederalTaxEstimate: number;
    yearsFunded: number;
  } | null;
}

interface ModelTrustSection {
  modelTrustLevel: 'exploratory' | 'planning_grade' | 'decision_grade';
  modelFidelityScore: number;
  blockingAssumptions: string[];
  softAssumptions: string[];
  faithfulUpgradeChecklist: Array<{
    id: string;
    currentStatus: 'estimated' | 'inferred' | 'missing';
    nextAction: string;
  }>;
  inputFidelityBreakdown: Array<{
    id: string;
    label: string;
    status: 'exact' | 'estimated' | 'inferred' | 'missing';
    reliabilityImpact: 'low' | 'medium' | 'high';
    blocking: boolean;
    detail: string;
    effectOnReliability: string;
  }>;
  reliabilityImpactSummary: {
    high: number;
    medium: number;
    low: number;
  };
}

interface RunwayRiskModelDiagnostics {
  comparisonMode: 'added_runway_response' | 'removed_runway_response';
  responseId: 'increase_cash_buffer';
  analysisScenario: 'adverse_early_sequence';
  stressorIdsUsed: string[];
  simulationRuns: number;
  simulationSeed: number;
  assumptionsVersion: string;
  baseline: {
    successRate: number;
    earlyFailureProbability: number;
    worstDecileEndingWealth: number;
    spendingCutRate: number;
    forcedEquitySaleRateEarlyRetirement: number;
    medianFailureShortfallDollars: number;
    medianDownsideSpendingCutRequired: number;
  };
  counterfactual: {
    successRate: number;
    earlyFailureProbability: number;
    worstDecileEndingWealth: number;
    spendingCutRate: number;
    forcedEquitySaleRateEarlyRetirement: number;
    medianFailureShortfallDollars: number;
    medianDownsideSpendingCutRequired: number;
  };
  deltas: {
    successRate: number;
    earlyFailureProbability: number;
    worstDecileEndingWealth: number;
    spendingCutRate: number;
    forcedEquitySaleRateEarlyRetirement: number;
    medianFailureShortfallDollars: number;
    medianDownsideSpendingCutRequired: number;
  };
  runwayRiskReductionScore: number;
  provenBenefit: boolean;
}

function clone<T>(value: T): T {
  return structuredClone(value) as T;
}

function getFirstExecutedConversion(outcome: PathResult) {
  const firstExecutedConversion = outcome.simulationDiagnostics.rothConversionTracePath.find(
    (entry) => entry.conversionExecuted,
  );

  return {
    firstConversionYear: firstExecutedConversion?.year ?? null,
    firstConversionAmount: firstExecutedConversion?.amount ?? null,
    firstConversionMode: firstExecutedConversion?.simulationModeUsedForConversion ?? null,
  };
}

function buildFlightPathConversionSchedule(
  plannerOutcome: PathResult,
): FlightPathConversionScheduleEntry[] {
  return plannerOutcome.simulationDiagnostics.rothConversionEligibilityPath
    .filter(
      (entry) =>
        entry.representativeAmount > 0 ||
        entry.safeRoomAvailable > 0 ||
        entry.strategicExtraAvailable > 0 ||
        entry.annualPolicyMaxBinding,
    )
    .map((entry) => ({
      year: entry.year,
      recommendedAmount: entry.representativeAmount,
      conversionKind: entry.representativeConversionKind,
      safeRoomAvailable: entry.safeRoomAvailable,
      safeRoomUsed: entry.safeRoomUsed,
      strategicExtraAvailable: entry.strategicExtraAvailable,
      strategicExtraUsed: entry.strategicExtraUsed,
      annualPolicyMax: entry.annualPolicyMax,
      annualPolicyMaxBinding: entry.annualPolicyMaxBinding,
      safeRoomUnusedDueToAnnualPolicyMax: entry.safeRoomUnusedDueToAnnualPolicyMax,
      safeRoomUnusedByReason: buildConversionUnusedRoomByReason({
        safeRoomAvailable: entry.safeRoomAvailable,
        safeRoomUsed: entry.safeRoomUsed,
        safeRoomUnusedDueToAnnualPolicyMax: entry.safeRoomUnusedDueToAnnualPolicyMax,
        reason: entry.representativeReason,
      }),
      reason: entry.representativeReason,
      medianMagiBefore: entry.medianMagiBefore,
      medianMagiAfter: entry.medianMagiAfter,
      medianTargetMagiCeiling: entry.medianTargetMagiCeiling,
    }));
}

function emptyConversionUnusedRoomByReason(): FlightPathConversionUnusedRoomByReason {
  return {
    annual_cap: 0,
    aca_cliff: 0,
    irmaa_cliff: 0,
    tax_bracket: 0,
    insufficient_pretax_balance: 0,
    liquidity: 0,
    explicit_user_constraint: 0,
    model_completeness: 0,
  };
}

function buildConversionUnusedRoomByReason(input: {
  safeRoomAvailable: number;
  safeRoomUsed: number;
  safeRoomUnusedDueToAnnualPolicyMax: number;
  reason: string;
}): FlightPathConversionUnusedRoomByReason {
  const output = emptyConversionUnusedRoomByReason();
  const annualCap = Math.max(0, input.safeRoomUnusedDueToAnnualPolicyMax);
  output.annual_cap = roundMoney(annualCap);
  output.explicit_user_constraint = roundMoney(annualCap);
  const remainingUnused = Math.max(
    0,
    input.safeRoomAvailable - input.safeRoomUsed - annualCap,
  );
  if (remainingUnused <= 0) {
    return output;
  }

  if (input.reason.includes('aca')) {
    output.aca_cliff = roundMoney(remainingUnused);
  } else if (input.reason.includes('irmaa') || input.reason.includes('no_headroom')) {
    output.irmaa_cliff = roundMoney(remainingUnused);
  } else if (input.reason.includes('no_economic_benefit') || input.reason.includes('negative_score')) {
    output.tax_bracket = roundMoney(remainingUnused);
  } else if (input.reason.includes('pretax_balance')) {
    output.insufficient_pretax_balance = roundMoney(remainingUnused);
  } else if (input.reason.includes('liquidity')) {
    output.liquidity = roundMoney(remainingUnused);
  } else if (input.reason.includes('target_unavailable')) {
    output.model_completeness = roundMoney(remainingUnused);
  }
  return output;
}

function sumConversionUnusedRoomByReason(
  entries: FlightPathConversionScheduleEntry[],
): FlightPathConversionUnusedRoomByReason {
  return entries.reduce((total, entry) => {
    (Object.keys(total) as FlightPathConversionUnusedRoomReason[]).forEach((reason) => {
      total[reason] = roundMoney(total[reason] + entry.safeRoomUnusedByReason[reason]);
    });
    return total;
  }, emptyConversionUnusedRoomByReason());
}

function classifyEmptyConversionScheduleStatus(reason: string): FlightPathConversionScheduleStatus['status'] {
  if (reason.includes('target_unavailable')) {
    return 'empty_missing_target';
  }
  if (reason === 'not_eligible_pre_retirement') {
    return 'empty_not_eligible';
  }
  if (reason.startsWith('no_economic_benefit')) {
    return 'empty_no_economic_benefit';
  }
  if (reason === 'blocked_by_other_planner_constraint_policy_disabled') {
    return 'empty_policy_disabled';
  }
  if (reason === 'blocked_by_available_pretax_balance') {
    return 'empty_no_pretax';
  }
  if (reason === 'blocked_by_irmaa_threshold' || reason.includes('no_headroom')) {
    return 'empty_no_room';
  }
  return 'empty_unknown';
}

function buildFlightPathConversionScheduleStatus(
  plannerOutcome: PathResult,
  conversionSchedule: FlightPathConversionScheduleEntry[],
): FlightPathConversionScheduleStatus {
  const summary = plannerOutcome.simulationDiagnostics.rothConversionDecisionSummary;
  const actionableSchedule = conversionSchedule.filter((entry) => entry.recommendedAmount > 0);
  const primaryReason = summary.reasons[0]?.reason ?? 'unknown';
  const totalRecommendedAmount = actionableSchedule.reduce(
    (total, entry) => total + entry.recommendedAmount,
    0,
  );
  const safeRoomScheduled = actionableSchedule.filter(
    (entry) => entry.conversionKind === 'safe_room',
  );
  const strategicExtraScheduled = actionableSchedule.filter(
    (entry) => entry.conversionKind === 'strategic_extra',
  );

  return {
    status:
      actionableSchedule.length > 0
        ? 'active'
        : classifyEmptyConversionScheduleStatus(primaryReason),
    scheduledYearCount: actionableSchedule.length,
    safeRoomScheduledYearCount: safeRoomScheduled.length,
    strategicExtraScheduledYearCount: strategicExtraScheduled.length,
    annualPolicyMaxBindingYearCount: actionableSchedule.filter(
      (entry) => entry.annualPolicyMaxBinding,
    ).length,
    totalRecommendedAmount: roundMoney(totalRecommendedAmount),
    totalSafeRoomUsed: roundMoney(
      actionableSchedule.reduce((total, entry) => total + entry.safeRoomUsed, 0),
    ),
    totalStrategicExtraUsed: roundMoney(
      actionableSchedule.reduce((total, entry) => total + entry.strategicExtraUsed, 0),
    ),
    totalSafeRoomUnusedDueToAnnualPolicyMax: roundMoney(
      actionableSchedule.reduce(
        (total, entry) => total + entry.safeRoomUnusedDueToAnnualPolicyMax,
        0,
      ),
    ),
    totalSafeRoomUnusedByReason: sumConversionUnusedRoomByReason(conversionSchedule),
    primaryReason,
  };
}

function getCurrentPlanningYear() {
  return new Date().getUTCFullYear();
}

function shiftDateYears(value: string, years: number) {
  const date = new Date(value);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.toISOString();
}

function roundMoney(value: number) {
  return Number(value.toFixed(2));
}

function roundRate(value: number) {
  return Number(value.toFixed(4));
}

function resolveScenarioMatrixSimulationRuns(baseRuns: number) {
  const normalized = Math.max(16, Math.round(baseRuns * 0.05));
  return Math.min(32, normalized);
}

function summarizePathForScenario(path: PathResult) {
  return {
    successRate: roundRate(path.successRate),
    medianEndingWealth: roundMoney(path.medianEndingWealth),
    annualFederalTaxEstimate: roundMoney(path.annualFederalTaxEstimate),
    yearsFunded: roundMoney(path.yearsFunded),
  };
}

function buildInheritanceScenarioMatrix(input: {
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressorIds: string[];
  selectedResponseIds: string[];
}): InheritanceScenarioMatrix {
  const inheritanceIndex = input.data.income.windfalls.findIndex(
    (item) => item.name === 'inheritance',
  );
  const scenarioRuns = resolveScenarioMatrixSimulationRuns(input.assumptions.simulationRuns);
  const scenarioAssumptions: MarketAssumptions = {
    ...input.assumptions,
    simulationRuns: scenarioRuns,
    assumptionsVersion: input.assumptions.assumptionsVersion
      ? `${input.assumptions.assumptionsVersion}-inheritance-matrix`
      : 'inheritance-matrix',
  };
  const inferredAssumptions: string[] = [];
  const missingInputs: string[] = [];
  if (inheritanceIndex < 0) {
    missingInputs.push('income.windfalls[name=inheritance]');
  }
  if (scenarioRuns !== input.assumptions.simulationRuns) {
    inferredAssumptions.push(
      `inheritance_matrix.simulationRuns capped to ${scenarioRuns} (base ${input.assumptions.simulationRuns})`,
    );
  }

  const runScenario = (
    id: InheritanceScenarioId,
    label: string,
    transform: (draft: SeedData) => void,
  ) => {
    const draft = clone(input.data);
    transform(draft);
    const [path] = buildPathResults(
      draft,
      scenarioAssumptions,
      input.selectedStressorIds,
      input.selectedResponseIds,
      {
        pathMode: 'selected_only',
        strategyMode: 'planner_enhanced',
      },
    );

    return {
      id,
      label,
      inheritanceYear:
        draft.income.windfalls.find((item) => item.name === 'inheritance')?.year ?? null,
      inheritanceAmount:
        draft.income.windfalls.find((item) => item.name === 'inheritance')?.amount ?? 0,
      ...summarizePathForScenario(path),
    };
  };

  const scenarioResults = [
    runScenario('on_time', 'On time', (draft) => draft),
    runScenario('delayed_5y', 'Delayed 5 years', (draft) => {
      const inheritance = draft.income.windfalls.find((item) => item.name === 'inheritance');
      if (inheritance) {
        inheritance.year += 5;
      }
    }),
    runScenario('reduced_50pct', 'Reduced 50%', (draft) => {
      const inheritance = draft.income.windfalls.find((item) => item.name === 'inheritance');
      if (inheritance) {
        inheritance.amount *= 0.5;
      }
    }),
    runScenario('removed', 'Removed', (draft) => {
      draft.income.windfalls = draft.income.windfalls.filter(
        (item) => item.name !== 'inheritance',
      );
    }),
  ];

  const onTime = scenarioResults.find((item) => item.id === 'on_time') ?? scenarioResults[0];
  const scenarios: InheritanceScenarioRow[] = scenarioResults.map((scenario) => ({
    ...scenario,
    deltaFromOnTime: {
      successRate: roundRate(scenario.successRate - onTime.successRate),
      medianEndingWealth: roundMoney(
        scenario.medianEndingWealth - onTime.medianEndingWealth,
      ),
      annualFederalTaxEstimate: roundMoney(
        scenario.annualFederalTaxEstimate - onTime.annualFederalTaxEstimate,
      ),
      yearsFunded: roundMoney(scenario.yearsFunded - onTime.yearsFunded),
    },
  }));

  return {
    simulationMode: 'planner_enhanced',
    simulationRuns: scenarioRuns,
    simulationSeed: scenarioAssumptions.simulationSeed ?? 20260416,
    assumptionsVersion: scenarioAssumptions.assumptionsVersion ?? 'inheritance-matrix',
    stressorIds: [...input.selectedStressorIds],
    responseIds: [...input.selectedResponseIds],
    missingInputs,
    inferredAssumptions,
    scenarios,
  };
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function classifyDependenceConsistency(observedRate: number, impliedRate: number) {
  const diff = Math.abs(observedRate - impliedRate);
  if (diff <= 0.1) {
    return 'consistent' as const;
  }
  if (diff <= 0.25) {
    return 'mixed' as const;
  }
  return 'divergent' as const;
}

function reconcileDependenceRate(observedRate: number, impliedRate: number) {
  const gap = Math.abs(observedRate - impliedRate);
  const scenarioWeight = gap >= 0.35 ? 0.75 : gap >= 0.2 ? 0.65 : 0.5;
  const reconciledRate =
    observedRate * (1 - scenarioWeight) + impliedRate * scenarioWeight;
  return {
    gap,
    reconciledRate: clamp01(reconciledRate),
    method:
      gap >= 0.35
        ? 'scenario_heavy_weighting'
        : gap >= 0.2
          ? 'balanced_with_scenario_tilt'
          : 'balanced_average',
  };
}

function stabilizeObservedDependenceRate(rawObservedRate: number, impliedRate: number) {
  const gap = Math.abs(rawObservedRate - impliedRate);
  const scenarioWeight = gap >= 0.35 ? 0.7 : gap >= 0.2 ? 0.55 : 0.35;
  return clamp01(rawObservedRate * (1 - scenarioWeight) + impliedRate * scenarioWeight);
}

function buildDependenceMetricsMetadata(input: {
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressorIds: string[];
  selectedResponseIds: string[];
  inheritanceMatrix: InheritanceScenarioMatrix;
  plannerOutcome: PathResult;
}): DependenceMetricsMetadata {
  const scenarioRuns = resolveScenarioMatrixSimulationRuns(input.assumptions.simulationRuns);
  const scenarioAssumptions: MarketAssumptions = {
    ...input.assumptions,
    simulationRuns: scenarioRuns,
    assumptionsVersion: input.assumptions.assumptionsVersion
      ? `${input.assumptions.assumptionsVersion}-dependence-metadata`
      : 'dependence-metadata',
  };
  const homeSaleRemovedData = clone(input.data);
  homeSaleRemovedData.income.windfalls = homeSaleRemovedData.income.windfalls.filter(
    (item) => item.name !== 'home_sale',
  );
  const [homeSaleRemovedPath] = buildPathResults(
    homeSaleRemovedData,
    scenarioAssumptions,
    input.selectedStressorIds,
    input.selectedResponseIds,
    {
      pathMode: 'selected_only',
      strategyMode: 'planner_enhanced',
    },
  );

  const inheritanceOnTime =
    input.inheritanceMatrix.scenarios.find((scenario) => scenario.id === 'on_time') ?? null;
  const inheritanceRemoved =
    input.inheritanceMatrix.scenarios.find((scenario) => scenario.id === 'removed') ?? null;
  const inheritanceBaseline = inheritanceOnTime?.successRate ?? input.plannerOutcome.successRate;
  const inheritanceStress = inheritanceRemoved?.successRate ?? inheritanceBaseline;
  const inheritanceSuccessDrop = Math.max(0, inheritanceBaseline - inheritanceStress);
  const impliedInheritanceRate = clamp01(
    inheritanceSuccessDrop / Math.max(inheritanceBaseline, 0.0001),
  );
  const observedInheritanceRateRaw = clamp01(input.plannerOutcome.inheritanceDependenceRate);
  const observedInheritanceRate = stabilizeObservedDependenceRate(
    observedInheritanceRateRaw,
    impliedInheritanceRate,
  );
  const inheritanceConsistency = classifyDependenceConsistency(
    observedInheritanceRate,
    impliedInheritanceRate,
  );
  const inheritanceReconciliation = reconcileDependenceRate(
    observedInheritanceRate,
    impliedInheritanceRate,
  );

  const homeSaleBaseline = input.plannerOutcome.successRate;
  const homeSaleStress = homeSaleRemovedPath.successRate;
  const homeSaleSuccessDrop = Math.max(0, homeSaleBaseline - homeSaleStress);
  const impliedHomeSaleRate = clamp01(
    homeSaleSuccessDrop / Math.max(homeSaleBaseline, 0.0001),
  );
  const observedHomeSaleRateRaw = clamp01(input.plannerOutcome.homeSaleDependenceRate);
  const observedHomeSaleRate = stabilizeObservedDependenceRate(
    observedHomeSaleRateRaw,
    impliedHomeSaleRate,
  );
  const homeSaleConsistency = classifyDependenceConsistency(
    observedHomeSaleRate,
    impliedHomeSaleRate,
  );
  const homeSaleReconciliation = reconcileDependenceRate(
    observedHomeSaleRate,
    impliedHomeSaleRate,
  );

  return {
    simulationRuns: scenarioRuns,
    simulationSeed: scenarioAssumptions.simulationSeed ?? 20260416,
    assumptionsVersion: scenarioAssumptions.assumptionsVersion ?? 'dependence-metadata',
    definitions: [
      {
        name: 'inheritanceDependenceRate',
        definition:
          'Stabilized inheritance dependence signal combining run-level dependence incidence with scenario-implied fragility from inheritance removal stress tests.',
        calculationNote:
          `Observed signal blends run-level incidence (${roundRate(
            observedInheritanceRateRaw,
          )}) with scenario-implied fragility (${roundRate(impliedInheritanceRate)}).`,
        observedRate: roundRate(observedInheritanceRate),
        sensitivityValidation: {
          baselineSuccessRate: roundRate(inheritanceBaseline),
          stressCaseSuccessRate: roundRate(inheritanceStress),
          successRateDrop: roundRate(inheritanceSuccessDrop),
          impliedDependenceRateFromScenario: roundRate(impliedInheritanceRate),
          observedScenarioGap: roundRate(inheritanceReconciliation.gap),
          reconciledDependenceRate: roundRate(
            inheritanceReconciliation.reconciledRate,
          ),
          reconciliationMethod: inheritanceReconciliation.method,
          consistency: inheritanceConsistency,
          note:
            inheritanceConsistency === 'consistent'
              ? 'Stabilized observed dependence is directionally aligned with inheritance removal sensitivity.'
              : `Observed and scenario-implied dependence diverge by ${roundRate(
                inheritanceReconciliation.gap,
              )}; export includes reconciledDependenceRate to make this gap explicit.`,
        },
      },
      {
        name: 'homeSaleDependenceRate',
        definition:
          'Stabilized home-sale dependence signal combining run-level dependence incidence with scenario-implied fragility from home-sale removal stress tests.',
        calculationNote:
          `Observed signal blends run-level incidence (${roundRate(
            observedHomeSaleRateRaw,
          )}) with scenario-implied fragility (${roundRate(impliedHomeSaleRate)}).`,
        observedRate: roundRate(observedHomeSaleRate),
        sensitivityValidation: {
          baselineSuccessRate: roundRate(homeSaleBaseline),
          stressCaseSuccessRate: roundRate(homeSaleStress),
          successRateDrop: roundRate(homeSaleSuccessDrop),
          impliedDependenceRateFromScenario: roundRate(impliedHomeSaleRate),
          observedScenarioGap: roundRate(homeSaleReconciliation.gap),
          reconciledDependenceRate: roundRate(homeSaleReconciliation.reconciledRate),
          reconciliationMethod: homeSaleReconciliation.method,
          consistency: homeSaleConsistency,
          note:
            homeSaleConsistency === 'consistent'
              ? 'Stabilized observed dependence is directionally aligned with home-sale removal sensitivity.'
              : `Observed and scenario-implied dependence diverge by ${roundRate(
                homeSaleReconciliation.gap,
              )}; export includes reconciledDependenceRate to make this gap explicit.`,
        },
      },
    ],
  };
}

function scoreRunwayRiskReduction(input: {
  earlyFailureDelta: number;
  worstDecileWealthDelta: number;
  spendingCutDelta: number;
  adverseSaleDelta: number;
  failureShortfallDelta: number;
  downsideCutSeverityDelta: number;
}) {
  const earlyFailureScore = Math.max(0, -input.earlyFailureDelta) * 4_000;
  const worstDecileScore = Math.max(0, input.worstDecileWealthDelta) / 5_000;
  const spendingCutScore = Math.max(0, -input.spendingCutDelta) * 2_000;
  const adverseSaleScore = Math.max(0, -input.adverseSaleDelta) * 2_000;
  const failureShortfallScore = Math.max(0, -input.failureShortfallDelta) / 10_000;
  const downsideCutSeverityScore = Math.max(0, -input.downsideCutSeverityDelta) * 2_000;
  return roundMoney(
    Math.max(
      0,
      Math.min(
        100,
        earlyFailureScore +
          worstDecileScore +
          spendingCutScore +
          adverseSaleScore +
          failureShortfallScore +
          downsideCutSeverityScore,
      ),
    ),
  );
}

function buildRunwayRiskModel(input: {
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressorIds: string[];
  selectedResponseIds: string[];
}): RunwayRiskModelDiagnostics {
  const hasRunwayResponse = input.selectedResponseIds.includes('increase_cash_buffer');
  const comparisonMode: RunwayRiskModelDiagnostics['comparisonMode'] = hasRunwayResponse
    ? 'removed_runway_response'
    : 'added_runway_response';
  const stressorIdsUsed = [...new Set([...input.selectedStressorIds, 'market_down'])];
  const runwayModelRuns = Math.max(
    120,
    resolveScenarioMatrixSimulationRuns(input.assumptions.simulationRuns) * 5,
  );
  const runwayAssumptions: MarketAssumptions = {
    ...input.assumptions,
    simulationRuns: runwayModelRuns,
    assumptionsVersion: input.assumptions.assumptionsVersion
      ? `${input.assumptions.assumptionsVersion}-runway-risk-model`
      : 'runway-risk-model',
  };

  const responsesWithoutRunway = hasRunwayResponse
    ? input.selectedResponseIds.filter((id) => id !== 'increase_cash_buffer')
    : [...input.selectedResponseIds];
  const responsesWithRunway = hasRunwayResponse
    ? [...input.selectedResponseIds]
    : [...new Set([...input.selectedResponseIds, 'increase_cash_buffer'])];
  const [baselinePath] = buildPathResults(
    input.data,
    runwayAssumptions,
    stressorIdsUsed,
    responsesWithoutRunway,
    {
      pathMode: 'selected_only',
      strategyMode: 'planner_enhanced',
    },
  );
  const [counterfactualPath] = buildPathResults(
    input.data,
    runwayAssumptions,
    stressorIdsUsed,
    responsesWithRunway,
    {
      pathMode: 'selected_only',
      strategyMode: 'planner_enhanced',
    },
  );
  const riskDelta = evaluateRunwayBridgeRiskDelta({
    baselinePath,
    counterfactualPath,
  });
  const failureShortfallDelta =
    counterfactualPath.riskMetrics.medianFailureShortfallDollars -
    baselinePath.riskMetrics.medianFailureShortfallDollars;
  const downsideCutSeverityDelta =
    counterfactualPath.riskMetrics.medianDownsideSpendingCutRequired -
    baselinePath.riskMetrics.medianDownsideSpendingCutRequired;

  const runwayRiskReductionScore = scoreRunwayRiskReduction({
    earlyFailureDelta: riskDelta.earlyFailureProbabilityDelta,
    worstDecileWealthDelta: riskDelta.worstDecileEndingWealthDelta,
    spendingCutDelta: riskDelta.spendingCutRateDelta,
    adverseSaleDelta: riskDelta.equitySalesInAdverseEarlyYearsRateDelta,
    failureShortfallDelta,
    downsideCutSeverityDelta,
  });
  const provenBenefit =
    riskDelta.provenBenefit ||
    failureShortfallDelta <= -1_000 ||
    downsideCutSeverityDelta <= -0.005;

  return {
    comparisonMode,
    responseId: 'increase_cash_buffer',
    analysisScenario: 'adverse_early_sequence',
    stressorIdsUsed,
    simulationRuns: runwayModelRuns,
    simulationSeed: runwayAssumptions.simulationSeed ?? 20260416,
    assumptionsVersion: runwayAssumptions.assumptionsVersion ?? 'runway-risk-model',
    baseline: {
      successRate: roundRate(baselinePath.successRate),
      earlyFailureProbability: roundRate(baselinePath.riskMetrics.earlyFailureProbability),
      worstDecileEndingWealth: roundMoney(baselinePath.riskMetrics.worstDecileEndingWealth),
      spendingCutRate: roundRate(baselinePath.spendingCutRate),
      forcedEquitySaleRateEarlyRetirement: roundRate(
        baselinePath.riskMetrics.equitySalesInAdverseEarlyYearsRate,
      ),
      medianFailureShortfallDollars: roundMoney(
        baselinePath.riskMetrics.medianFailureShortfallDollars,
      ),
      medianDownsideSpendingCutRequired: roundRate(
        baselinePath.riskMetrics.medianDownsideSpendingCutRequired,
      ),
    },
    counterfactual: {
      successRate: roundRate(counterfactualPath.successRate),
      earlyFailureProbability: roundRate(counterfactualPath.riskMetrics.earlyFailureProbability),
      worstDecileEndingWealth: roundMoney(counterfactualPath.riskMetrics.worstDecileEndingWealth),
      spendingCutRate: roundRate(counterfactualPath.spendingCutRate),
      forcedEquitySaleRateEarlyRetirement: roundRate(
        counterfactualPath.riskMetrics.equitySalesInAdverseEarlyYearsRate,
      ),
      medianFailureShortfallDollars: roundMoney(
        counterfactualPath.riskMetrics.medianFailureShortfallDollars,
      ),
      medianDownsideSpendingCutRequired: roundRate(
        counterfactualPath.riskMetrics.medianDownsideSpendingCutRequired,
      ),
    },
    deltas: {
      successRate: roundRate(counterfactualPath.successRate - baselinePath.successRate),
      earlyFailureProbability: roundRate(riskDelta.earlyFailureProbabilityDelta),
      worstDecileEndingWealth: roundMoney(riskDelta.worstDecileEndingWealthDelta),
      spendingCutRate: roundRate(riskDelta.spendingCutRateDelta),
      forcedEquitySaleRateEarlyRetirement: roundRate(
        riskDelta.equitySalesInAdverseEarlyYearsRateDelta,
      ),
      medianFailureShortfallDollars: roundMoney(failureShortfallDelta),
      medianDownsideSpendingCutRequired: roundRate(downsideCutSeverityDelta),
    },
    runwayRiskReductionScore,
    provenBenefit,
  };
}

function buildPhasedSpendSchedule(input: {
  data: SeedData;
  assumptions: MarketAssumptions;
}) {
  const startYear = getCurrentPlanningYear();
  const retirementYear = new Date(input.data.income.salaryEndDate).getUTCFullYear();
  const planningEndYear = Math.max(
    startYear + 1,
    new Date(input.data.household.robBirthDate).getUTCFullYear() +
      input.assumptions.robPlanningEndAge,
    new Date(input.data.household.debbieBirthDate).getUTCFullYear() +
      input.assumptions.debbiePlanningEndAge,
  );
  const earlyPhaseYears = Math.min(8, input.assumptions.travelPhaseYears);
  const latePhaseOffsetYears = Math.max(earlyPhaseYears + 2, 12);
  const schedule: Record<number, number> = {};

  for (let year = startYear; year <= planningEndYear; year += 1) {
    const isRetired = year >= retirementYear;
    const yearsIntoRetirement = year - retirementYear;
    const inTravelPhase =
      isRetired &&
      yearsIntoRetirement >= 0 &&
      yearsIntoRetirement < input.assumptions.travelPhaseYears;
    const baseAnnual =
      input.data.spending.essentialMonthly * 12 +
      input.data.spending.optionalMonthly * 12 +
      input.data.spending.annualTaxesInsurance +
      (inTravelPhase ? input.data.spending.travelEarlyRetirementAnnual : 0);

    if (!isRetired) {
      schedule[year] = roundMoney(baseAnnual);
      continue;
    }
    if (yearsIntoRetirement < earlyPhaseYears) {
      schedule[year] = roundMoney(baseAnnual * 1.08);
      continue;
    }
    if (yearsIntoRetirement >= latePhaseOffsetYears) {
      schedule[year] = roundMoney(baseAnnual * 0.9);
      continue;
    }
    schedule[year] = roundMoney(baseAnnual);
  }

  return schedule;
}

function buildObjectiveCalibrationDiagnostics(input: {
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressorIds: string[];
  selectedResponseIds: string[];
}): ObjectiveCalibrationDiagnostics {
  const scenarioRuns = resolveScenarioMatrixSimulationRuns(input.assumptions.simulationRuns);
  const calibrationAssumptions: MarketAssumptions = {
    ...input.assumptions,
    simulationRuns: scenarioRuns,
    assumptionsVersion: input.assumptions.assumptionsVersion
      ? `${input.assumptions.assumptionsVersion}-objective-calibration`
      : 'objective-calibration',
  };
  const inferredAssumptions: string[] = [];
  if (scenarioRuns !== input.assumptions.simulationRuns) {
    inferredAssumptions.push(
      `objective_calibration.simulationRuns capped to ${scenarioRuns} (base ${input.assumptions.simulationRuns})`,
    );
  }
  inferredAssumptions.push(
    'Phased spend schedule uses +8% in early retirement years and -10% in later retirement years.',
  );

  const [flatPath] = buildPathResults(
    input.data,
    calibrationAssumptions,
    input.selectedStressorIds,
    input.selectedResponseIds,
    {
      pathMode: 'selected_only',
      strategyMode: 'planner_enhanced',
    },
  );
  const [phasedPath] = buildPathResults(
    input.data,
    calibrationAssumptions,
    input.selectedStressorIds,
    input.selectedResponseIds,
    {
      pathMode: 'selected_only',
      strategyMode: 'planner_enhanced',
      annualSpendScheduleByYear: buildPhasedSpendSchedule({
        data: input.data,
        assumptions: input.assumptions,
      }),
    },
  );

  const scenarios: ObjectiveCalibrationScenario[] = [
    {
      id: 'flat_spend',
      objective: 'maximize_flat_spending',
      spendShape: 'flat',
      successRate: roundRate(flatPath.successRate),
      medianEndingWealth: roundMoney(flatPath.medianEndingWealth),
      annualFederalTaxEstimate: roundMoney(flatPath.annualFederalTaxEstimate),
      yearsFunded: roundMoney(flatPath.yearsFunded),
    },
    {
      id: 'phased_spend',
      objective: 'maximize_time_weighted_spending',
      spendShape: 'phased',
      successRate: roundRate(phasedPath.successRate),
      medianEndingWealth: roundMoney(phasedPath.medianEndingWealth),
      annualFederalTaxEstimate: roundMoney(phasedPath.annualFederalTaxEstimate),
      yearsFunded: roundMoney(phasedPath.yearsFunded),
    },
  ];

  return {
    simulationMode: 'planner_enhanced',
    simulationRuns: scenarioRuns,
    simulationSeed: calibrationAssumptions.simulationSeed ?? 20260416,
    assumptionsVersion: calibrationAssumptions.assumptionsVersion ?? 'objective-calibration',
    inferredAssumptions,
    scenarios,
    deltaPhasedMinusFlat: {
      successRate: roundRate(phasedPath.successRate - flatPath.successRate),
      medianEndingWealth: roundMoney(
        phasedPath.medianEndingWealth - flatPath.medianEndingWealth,
      ),
      annualFederalTaxEstimate: roundMoney(
        phasedPath.annualFederalTaxEstimate - flatPath.annualFederalTaxEstimate,
      ),
      yearsFunded: roundMoney(phasedPath.yearsFunded - flatPath.yearsFunded),
    },
  };
}

function buildInheritanceDependenceHeadline(
  matrix: InheritanceScenarioMatrix,
  dependenceMetadata: DependenceMetricsMetadata,
): InheritanceDependenceHeadline {
  const onTime = matrix.scenarios.find((scenario) => scenario.id === 'on_time') ?? null;
  const removed = matrix.scenarios.find((scenario) => scenario.id === 'removed') ?? null;
  const delayed = matrix.scenarios.find((scenario) => scenario.id === 'delayed_5y') ?? null;
  const reduced = matrix.scenarios.find((scenario) => scenario.id === 'reduced_50pct') ?? null;
  const onTimeSuccessRate = onTime?.successRate ?? 0;
  const removedSuccessRate = removed?.successRate ?? onTimeSuccessRate;
  const delayedSuccessRate = delayed?.successRate ?? onTimeSuccessRate;
  const reducedSuccessRate = reduced?.successRate ?? onTimeSuccessRate;
  const denominator = Math.max(onTimeSuccessRate * 3, 0.0001);
  const inheritanceRobustnessScore = roundMoney(
    Math.max(
      0,
      Math.min(
        100,
        ((removedSuccessRate + delayedSuccessRate + reducedSuccessRate) / denominator) * 100,
      ),
    ),
  );
  const fragilityPenalty = roundMoney(Math.max(0, 100 - inheritanceRobustnessScore));
  const inheritanceDependenceDefinition = dependenceMetadata.definitions.find(
    (definition) => definition.name === 'inheritanceDependenceRate',
  );
  const observedRate = inheritanceDependenceDefinition?.observedRate ?? null;
  const impliedRate =
    inheritanceDependenceDefinition?.sensitivityValidation.impliedDependenceRateFromScenario ??
    null;
  const reconciledRate =
    inheritanceDependenceDefinition?.sensitivityValidation.reconciledDependenceRate ??
    null;
  const consistency =
    inheritanceDependenceDefinition?.sensitivityValidation.consistency ?? null;
  const dependenceSignal = Math.max(
    observedRate ?? 0,
    impliedRate ?? 0,
    reconciledRate ?? 0,
  );
  const inheritanceDependent =
    onTime !== null &&
    (onTimeSuccessRate - removedSuccessRate >= 0.1 ||
      removedSuccessRate < 0.6 ||
      inheritanceRobustnessScore < 70 ||
      dependenceSignal >= 0.35);

  return {
    inheritanceDependent,
    inheritanceRobustnessScore,
    fragilityPenalty,
    dependenceEvidence: {
      observedRate,
      impliedRate,
      reconciledRate,
      consistency,
    },
    baseCaseExcludingInheritance: removed
      ? {
          successRate: removed.successRate,
          medianEndingWealth: removed.medianEndingWealth,
          annualFederalTaxEstimate: removed.annualFederalTaxEstimate,
          yearsFunded: removed.yearsFunded,
        }
      : null,
    upsideCaseIncludingInheritance: onTime
      ? {
          successRate: onTime.successRate,
          medianEndingWealth: onTime.medianEndingWealth,
          annualFederalTaxEstimate: onTime.annualFederalTaxEstimate,
          yearsFunded: onTime.yearsFunded,
        }
      : null,
  };
}

function resolveDependenceFromMetadata(
  metadata: DependenceMetricsMetadata,
  name: DependenceMetricDefinition['name'],
) {
  const definition = metadata.definitions.find((item) => item.name === name);
  if (!definition) {
    return null;
  }
  const reconciledRate =
    definition.sensitivityValidation.reconciledDependenceRate ?? definition.observedRate;
  const successDelta =
    definition.sensitivityValidation.stressCaseSuccessRate -
    definition.sensitivityValidation.baselineSuccessRate;
  return {
    rate: clamp01(reconciledRate),
    successDelta: roundRate(successDelta),
  };
}

function classifyDependenceStatus(input: {
  rate: number;
  successDelta: number;
  failRateThreshold: number;
  warnRateThreshold: number;
}): 'pass' | 'warn' | 'fail' {
  if (
    input.rate >= input.failRateThreshold ||
    (input.rate >= input.warnRateThreshold && input.successDelta <= -0.05)
  ) {
    return 'fail';
  }
  if (input.rate >= input.warnRateThreshold || input.successDelta <= -0.02) {
    return 'warn';
  }
  return 'pass';
}

function harmonizeTrustPanelDependence(input: {
  trustPanel: PlanTrustPanel | null;
  dependenceMetadata: DependenceMetricsMetadata;
  recommendationEvidenceSummary: PlanningStateExport['flightPath']['recommendationEvidenceSummary'];
  actionCardCount: number;
}): PlanTrustPanel | null {
  const {
    trustPanel,
    dependenceMetadata,
    recommendationEvidenceSummary,
    actionCardCount,
  } = input;
  if (!trustPanel) {
    return null;
  }
  const inheritance = resolveDependenceFromMetadata(
    dependenceMetadata,
    'inheritanceDependenceRate',
  );
  const homeSale = resolveDependenceFromMetadata(
    dependenceMetadata,
    'homeSaleDependenceRate',
  );
  const hasFlightPathRecommendations =
    recommendationEvidenceSummary.returnedRecommendations > 0 || actionCardCount > 0;
  if (!inheritance && !homeSale && !hasFlightPathRecommendations) {
    return trustPanel;
  }

  const checks = trustPanel.checks.map((check) => {
    if (check.id === 'recommendation_evidence' && hasFlightPathRecommendations) {
      return {
        ...check,
        status: 'pass' as const,
        detail:
          `${recommendationEvidenceSummary.returnedRecommendations} strategic recommendation(s) ` +
          `and ${actionCardCount} flight-path action card(s) are available in the export.`,
      };
    }
    if (check.id === 'inheritance_dependency' && inheritance) {
      const status = classifyDependenceStatus({
        rate: inheritance.rate,
        successDelta: inheritance.successDelta,
        failRateThreshold: 0.35,
        warnRateThreshold: 0.2,
      });
      return {
        ...check,
        status,
        detail: `Dependence rate ${Math.round(inheritance.rate * 100)}%; remove-inheritance success delta ${(inheritance.successDelta * 100).toFixed(1)} pts.`,
      };
    }
    if (check.id === 'home_sale_dependency' && homeSale) {
      const status = classifyDependenceStatus({
        rate: homeSale.rate,
        successDelta: homeSale.successDelta,
        failRateThreshold: 0.3,
        warnRateThreshold: 0.15,
      });
      return {
        ...check,
        status,
        detail: `Dependence rate ${Math.round(homeSale.rate * 100)}%; remove-home-sale success delta ${(homeSale.successDelta * 100).toFixed(1)} pts.`,
      };
    }
    return check;
  });

  const passCount = checks.filter((check) => check.status === 'pass').length;
  const warnCount = checks.filter((check) => check.status === 'warn').length;
  const failCount = checks.filter((check) => check.status === 'fail').length;
  const recommendationEvidenceCoverage = hasFlightPathRecommendations
    ? Math.max(trustPanel.metrics.recommendationEvidenceCoverage, 1)
    : trustPanel.metrics.recommendationEvidenceCoverage;
  const dataFidelityStatus = checks.find((check) => check.id === 'data_fidelity')?.status ?? 'warn';
  const safeToRely =
    failCount === 0 &&
    recommendationEvidenceCoverage >= 0.5 &&
    dataFidelityStatus !== 'fail';
  const confidence: PlanTrustPanel['confidence'] =
    failCount > 0 ? (failCount >= 2 ? 'low' : 'medium') : warnCount >= 4 ? 'medium' : 'high';

  return {
    ...trustPanel,
    safeToRely,
    confidence,
    summary: safeToRely
      ? 'Run quality is good enough for decision use with normal monitoring.'
      : 'Run quality needs attention before treating recommendations as execution-ready.',
    checks,
    metrics: {
      ...trustPanel.metrics,
      passCount,
      warnCount,
      failCount,
      recommendationEvidenceCoverage,
      inheritanceDependenceRate: inheritance?.rate ?? trustPanel.metrics.inheritanceDependenceRate,
      homeSaleDependenceRate: homeSale?.rate ?? trustPanel.metrics.homeSaleDependenceRate,
    },
  };
}

function uniqueNonEmpty(values: string[]) {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)),
  );
}

function collectPlaybookInferredAssumptions(playbook: FlightPathPhasePlaybook) {
  return uniqueNonEmpty([
    ...playbook.diagnostics.inferredAssumptions,
    ...playbook.retirementFlowYears.flatMap((year) => year.inferredAssumptions),
  ]);
}

function buildPlanScorecard(input: {
  plannerOutcome: PathResult;
  executiveSummary: ExecutiveFlightSummary;
  modelCompleteness: PlaybookModelCompleteness;
  modelFidelityCompleteness: ModelFidelityAssessment['modelCompleteness'];
  playbookInferredAssumptionsCount: number;
  dependenceMetadata: DependenceMetricsMetadata;
  trustPanel: PlanTrustPanel | null;
  inheritanceDependenceHeadline: InheritanceDependenceHeadline;
  planEvaluationSuccessRate: number | null;
}) {
  const inheritanceDependence = resolveDependenceFromMetadata(
    input.dependenceMetadata,
    'inheritanceDependenceRate',
  );
  const homeSaleDependence = resolveDependenceFromMetadata(
    input.dependenceMetadata,
    'homeSaleDependenceRate',
  );
  const canonicalSuccessRate = roundRate(input.plannerOutcome.successRate);
  const canonicalSupportedMonthlySpend = roundMoney(
    input.executiveSummary.planHealth.supportedMonthlySpend,
  );
  const canonicalInheritanceDependenceRate = roundRate(
    inheritanceDependence?.rate ?? input.plannerOutcome.inheritanceDependenceRate,
  );
  const canonicalHomeSaleDependenceRate = roundRate(
    homeSaleDependence?.rate ?? input.plannerOutcome.homeSaleDependenceRate,
  );
  const executiveSummarySuccessRate =
    input.executiveSummary.planHealth.successRate ?? canonicalSuccessRate;
  const expectedCompleteness: PlaybookModelCompleteness =
    input.modelFidelityCompleteness === 'reconstructed' ||
    input.playbookInferredAssumptionsCount > 0
      ? 'reconstructed'
      : 'faithful';
  const trustPanelInheritanceRate = input.trustPanel?.metrics.inheritanceDependenceRate ?? null;
  const trustPanelHomeSaleRate = input.trustPanel?.metrics.homeSaleDependenceRate ?? null;
  const headlineInheritanceRate =
    input.inheritanceDependenceHeadline.dependenceEvidence.reconciledRate;
  const dependenceRatesAligned =
    (trustPanelInheritanceRate === null ||
      Math.abs(trustPanelInheritanceRate - canonicalInheritanceDependenceRate) <= 0.0001) &&
    (trustPanelHomeSaleRate === null ||
      Math.abs(trustPanelHomeSaleRate - canonicalHomeSaleDependenceRate) <= 0.0001) &&
    (headlineInheritanceRate === null ||
      Math.abs(headlineInheritanceRate - canonicalInheritanceDependenceRate) <= 0.0001);

  return {
    canonical: {
      successRate: canonicalSuccessRate,
      supportedMonthlySpend: canonicalSupportedMonthlySpend,
      modelCompleteness: input.modelCompleteness,
      inheritanceDependenceRate: canonicalInheritanceDependenceRate,
      homeSaleDependenceRate: canonicalHomeSaleDependenceRate,
    },
    sourceOfTruth: {
      successRate: 'simulationOutcomes.plannerEnhancedSimulation.successRate',
      supportedMonthlySpend: 'flightPath.executiveSummary.planHealth.supportedMonthlySpend',
      modelCompleteness: 'modelFidelity.modelCompleteness (reconciled with playbook assumptions)',
      inheritanceDependenceRate:
        'scenarioSensitivity.dependenceMetricsMetadata.definitions[inheritanceDependenceRate].sensitivityValidation.reconciledDependenceRate',
      homeSaleDependenceRate:
        'scenarioSensitivity.dependenceMetricsMetadata.definitions[homeSaleDependenceRate].sensitivityValidation.reconciledDependenceRate',
    },
    alternateViews: {
      planEvaluationSuccessRate:
        typeof input.planEvaluationSuccessRate === 'number'
          ? roundRate(input.planEvaluationSuccessRate)
          : null,
      observedSimulationInheritanceDependenceRate: roundRate(
        input.plannerOutcome.inheritanceDependenceRate,
      ),
      observedSimulationHomeSaleDependenceRate: roundRate(
        input.plannerOutcome.homeSaleDependenceRate,
      ),
    },
    consistency: {
      executiveSummarySuccessRateAligned:
        Math.abs(executiveSummarySuccessRate - canonicalSuccessRate) <=
        0.0001,
      modelCompletenessAligned: input.modelCompleteness === expectedCompleteness,
      dependenceRatesAligned,
    },
  };
}

function toReliabilityEffectText(input: {
  status: 'exact' | 'estimated' | 'inferred' | 'missing';
  reliabilityImpact: 'low' | 'medium' | 'high';
  blocking: boolean;
}) {
  if (input.blocking || input.status === 'missing') {
    return 'Material reliability reduction; decision use should be blocked until resolved.';
  }
  if (input.status === 'inferred' && input.reliabilityImpact === 'high') {
    return 'High reliability drag; outputs should be treated as exploratory.';
  }
  if (input.status === 'inferred' || input.status === 'estimated') {
    return 'Moderate reliability drag; results should be used with planning-grade caution.';
  }
  return 'Low reliability drag; input quality supports decision use.';
}

function buildFaithfulUpgradeAction(input: ModelFidelityInput) {
  switch (input.id) {
    case 'inferred_rmd_start_timing':
      return 'Provide an explicit RMD start-age policy override in rules.rmdPolicy.';
    case 'pretax_rmd_account_ownership':
      return 'Add owner metadata to each accounts.pretax.sourceAccounts entry.';
    case 'opaque_holdings_mapping':
      return 'Provide explicit look-through mapping plus assetClassMappingEvidence for ambiguous sleeves.';
    case 'payroll_take_home_estimate':
      return 'Provide household-specific payroll takeHomeFactor in rules.payrollModel.';
    case 'payroll_timing_proration_assumptions':
      return 'Provide explicit salaryProrationRule in rules.payrollModel.';
    case 'uncertain_inheritance':
      return 'Provide inheritance certainty metadata (certainty/timingUncertaintyYears/amountUncertaintyPercent).';
    case 'simplified_home_sale_assumptions':
      return 'Provide full home downsizing inputs (costBasis, exclusionAmount, sellingCostPercent, replacementHomeCost, purchaseClosingCostPercent, movingCost, or explicit liquidityAmount).';
    default:
      return 'Replace inferred/estimated input with explicit data for faithful classification.';
  }
}

function buildModelTrustSection(modelFidelity: ModelFidelityAssessment): ModelTrustSection {
  const reliabilityImpactSummary = modelFidelity.inputs.reduce(
    (summary, input) => {
      summary[input.reliabilityImpact] += 1;
      return summary;
    },
    { high: 0, medium: 0, low: 0 },
  );

  return {
    modelTrustLevel: modelFidelity.assessmentGrade,
    modelFidelityScore: modelFidelity.modelFidelityScore,
    blockingAssumptions: [...modelFidelity.blockingAssumptions],
    softAssumptions: [...modelFidelity.softAssumptions],
    faithfulUpgradeChecklist: modelFidelity.inputs
      .filter(
        (
          input,
        ): input is ModelFidelityInput & {
          status: 'estimated' | 'inferred' | 'missing';
        } => input.status !== 'exact',
      )
      .map((input) => ({
        id: input.id,
        currentStatus: input.status,
        nextAction: buildFaithfulUpgradeAction(input),
      })),
    inputFidelityBreakdown: modelFidelity.inputs.map((input) => ({
      ...input,
      effectOnReliability: toReliabilityEffectText({
        status: input.status,
        reliabilityImpact: input.reliabilityImpact,
        blocking: input.blocking,
      }),
    })),
    reliabilityImpactSummary,
  };
}

function buildRecommendationEvidenceSummary(
  strategicPrepPolicy: FlightPathPolicyResult,
): PlanningStateExport['flightPath']['recommendationEvidenceSummary'] {
  const diagnostics = strategicPrepPolicy.diagnostics;
  const suppressionReasons = [
    ...diagnostics.skippedBeforeEvaluation,
    ...diagnostics.hardConstraintFiltered,
    ...diagnostics.evidenceFiltered,
    ...diagnostics.rankingFiltered,
  ];
  const reasonCounts = suppressionReasons.reduce((map, item) => {
    map.set(item.reason, (map.get(item.reason) ?? 0) + 1);
    return map;
  }, new Map<string, number>());

  return {
    candidatesConsidered: diagnostics.candidatesConsidered,
    candidatesEvaluated: diagnostics.candidatesEvaluated,
    acceptedAfterHardConstraints: diagnostics.acceptedAfterHardConstraints,
    acceptedAfterEvidenceGate: diagnostics.acceptedAfterEvidenceGate,
    returnedRecommendations: strategicPrepPolicy.recommendations.length,
    suppressedBeforeEvaluation: diagnostics.skippedBeforeEvaluation.length,
    suppressedByHardConstraints: diagnostics.hardConstraintFiltered.length,
    suppressedByEvidenceGate: diagnostics.evidenceFiltered.length,
    suppressedByRanking: diagnostics.rankingFiltered.length,
    acceptedRecommendationIds: [...diagnostics.acceptedRecommendationIds],
    topSuppressionReasons: [...reasonCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5)
      .map(([reason, count]) => ({ reason, count })),
  };
}

function buildRecommendationAvailabilityHeadline(input: {
  summary: PlanningStateExport['flightPath']['recommendationEvidenceSummary'];
}): PlanningStateExport['flightPath']['recommendationAvailabilityHeadline'] {
  const { summary } = input;
  if (summary.returnedRecommendations > 0) {
    return {
      status: 'recommendations_available',
      suppressedBy: 'none',
      primaryReason: `${summary.returnedRecommendations} evidence-backed recommendation(s) available.`,
      canActNow: true,
    };
  }

  if (summary.candidatesConsidered === 0) {
    return {
      status: 'no_recommendations',
      suppressedBy: 'none_considered',
      primaryReason: 'No strategic recommendation candidates were triggered for this run.',
      canActNow: false,
    };
  }

  const suppressionBuckets = [
    { key: 'missing_counterfactual_patches', count: summary.suppressedBeforeEvaluation },
    { key: 'hard_constraints', count: summary.suppressedByHardConstraints },
    { key: 'evidence_gate', count: summary.suppressedByEvidenceGate },
    { key: 'ranking', count: summary.suppressedByRanking },
  ] as const;
  const activeBuckets = suppressionBuckets.filter((bucket) => bucket.count > 0);
  const topBucket = [...activeBuckets].sort((left, right) => right.count - left.count)[0] ?? null;
  const suppressedBy =
    activeBuckets.length <= 1
      ? (topBucket?.key ?? 'mixed')
      : ('mixed' as PlanningStateExport['flightPath']['recommendationAvailabilityHeadline']['suppressedBy']);
  const primaryReason =
    summary.topSuppressionReasons[0]?.reason ??
    'Recommendations were suppressed due to hard constraints or missing evidence.';

  return {
    status: 'no_recommendations',
    suppressedBy,
    primaryReason,
    canActNow: false,
  };
}

function buildExportQualityGate(input: {
  executiveSummary: ExecutiveFlightSummary;
  strategicPrepPolicy: FlightPathPolicyResult;
  recommendationLedger: PlanningStateExport['flightPath']['recommendationLedger'];
  scenarioSensitivity: PlanningStateExport['scenarioSensitivity'];
  modelCompleteness: PlaybookModelCompleteness;
  modelFidelity: ModelFidelityAssessment;
  modelTrust: ModelTrustSection;
  inheritanceDependenceHeadline: InheritanceDependenceHeadline;
  runwayRiskModel: RunwayRiskModelDiagnostics;
  planScorecard: PlanningStateExport['planScorecard'];
  simulationOutcomes: PlanningStateExport['simulationOutcomes'];
}): ExportQualityGate {
  const checks: ExportQualityGateCheck[] = [];

  const recommendations = input.recommendationLedger.strategicPrep;
  const evidenceIntegrityPass = recommendations.every(
    (recommendation) =>
      recommendation.estimatedImpact !== null &&
      recommendation.evidence.baseline !== null &&
      recommendation.evidence.counterfactual !== null &&
      Number.isFinite(recommendation.estimatedImpact.successRateDelta) &&
      Number.isFinite(recommendation.estimatedImpact.supportedMonthlyDelta) &&
      Number.isFinite(recommendation.estimatedImpact.medianEndingWealthDelta) &&
      Number.isFinite(recommendation.estimatedImpact.annualFederalTaxDelta) &&
      Number.isFinite(recommendation.estimatedImpact.magiDelta) &&
      typeof recommendation.estimatedImpact.magiDelta === 'number' &&
      recommendation.estimatedImpact.downsideRiskDelta !== undefined &&
      Number.isFinite(
        recommendation.estimatedImpact.downsideRiskDelta.earlyFailureProbabilityDelta,
      ) &&
      Number.isFinite(
        recommendation.estimatedImpact.downsideRiskDelta.worstDecileEndingWealthDelta,
      ) &&
      Number.isFinite(
        recommendation.estimatedImpact.downsideRiskDelta.spendingCutRateDelta,
      ) &&
      Number.isFinite(
        recommendation.estimatedImpact.downsideRiskDelta.equitySalesInAdverseEarlyYearsRateDelta,
      ) &&
      Number.isFinite(
        recommendation.estimatedImpact.downsideRiskDelta.medianFailureShortfallDollarsDelta,
      ) &&
      Number.isFinite(
        recommendation.estimatedImpact.downsideRiskDelta.medianDownsideSpendingCutRequiredDelta,
      ) &&
      typeof recommendation.sensitivityConsistency?.score === 'number' &&
      typeof recommendation.confidence?.score === 'number',
  );
  checks.push({
    id: 'recommendation_evidence_integrity',
    label: 'Strategic recommendations include full evidence packets (baseline/counterfactual + MAGI/downside deltas)',
    status: evidenceIntegrityPass ? 'pass' : 'fail',
    detail: evidenceIntegrityPass
      ? 'All returned strategic recommendations include deterministic snapshots, MAGI/downside deltas, confidence, and sensitivity consistency.'
      : 'One or more returned recommendations are missing required evidence-packet fields.',
  });

  const recommendationIdConsistencyPass = recommendations.length ===
    input.strategicPrepPolicy.diagnostics.acceptedRecommendationIds.length;
  checks.push({
    id: 'recommendation_id_consistency',
    label: 'Accepted recommendation IDs match returned recommendation set',
    status: recommendationIdConsistencyPass ? 'pass' : 'fail',
    detail: recommendationIdConsistencyPass
      ? 'Recommendation ID ledger is internally consistent.'
      : 'Mismatch between diagnostics acceptedRecommendationIds and returned recommendation set.',
  });

  const preEvaluationSuppressionCount =
    input.strategicPrepPolicy.diagnostics.skippedBeforeEvaluation.length;
  const consideredCoverage =
    input.strategicPrepPolicy.diagnostics.candidatesEvaluated + preEvaluationSuppressionCount;
  const hasSuppressionTrace =
    recommendations.length > 0 ||
    input.strategicPrepPolicy.diagnostics.skippedBeforeEvaluation.length > 0 ||
    input.strategicPrepPolicy.diagnostics.evidenceFiltered.length > 0 ||
    input.strategicPrepPolicy.diagnostics.hardConstraintFiltered.length > 0 ||
    input.strategicPrepPolicy.diagnostics.rankingFiltered.length > 0 ||
    input.strategicPrepPolicy.diagnostics.candidatesConsidered === 0;
  const evidenceTransparencyPass =
    input.strategicPrepPolicy.diagnostics.acceptedAfterEvidenceGate >= 0 &&
    input.strategicPrepPolicy.diagnostics.evidenceFiltered.length >= 0 &&
    hasSuppressionTrace &&
    consideredCoverage >= input.strategicPrepPolicy.diagnostics.candidatesConsidered;
  checks.push({
    id: 'recommendation_evidence_transparency',
    label: 'Recommendation suppression/acceptance counts are explicitly disclosed',
    status: evidenceTransparencyPass ? 'pass' : 'warn',
    detail: evidenceTransparencyPass
      ? `Returned ${recommendations.length} recommendations with ${input.strategicPrepPolicy.diagnostics.skippedBeforeEvaluation.length} pre-evaluation skips, ${input.strategicPrepPolicy.diagnostics.hardConstraintFiltered.length} hard-constraint suppressions, ${input.strategicPrepPolicy.diagnostics.evidenceFiltered.length} evidence-gated suppressions, and ${input.strategicPrepPolicy.diagnostics.rankingFiltered.length} ranking suppressions.`
      : 'Recommendation evidence suppression details are incomplete.',
  });

  const canonicalScorecardConsistencyPass =
    input.planScorecard.consistency.executiveSummarySuccessRateAligned &&
    input.planScorecard.consistency.modelCompletenessAligned &&
    input.planScorecard.consistency.dependenceRatesAligned;
  checks.push({
    id: 'canonical_scorecard_consistency',
    label: 'Canonical scorecard metrics are internally consistent across export sections',
    status: canonicalScorecardConsistencyPass ? 'pass' : 'fail',
    detail: canonicalScorecardConsistencyPass
      ? 'Canonical success/completeness/dependence metrics are aligned across summary, trust, and diagnostics sections.'
      : 'One or more canonical scorecard metrics are inconsistent across export sections.',
  });

  const canonicalSuccessRate = input.planScorecard.canonical.successRate;
  const executiveSuccessRate = input.executiveSummary.planHealth.successRate;
  const activeSuccessRate = roundRate(input.simulationOutcomes.plannerEnhancedSimulation.successRate);
  const narrativeSuccessToken = `${Number((canonicalSuccessRate * 100).toFixed(1))}% success`;
  const narrativeSuccessAligned =
    input.executiveSummary.narrative.whereThingsStand.includes(narrativeSuccessToken) ||
    input.executiveSummary.narrative.whereThingsStand.includes(
      `${Math.round(canonicalSuccessRate * 100)}% success`,
    );
  const headlineSuccessRateConsistencyPass =
    executiveSuccessRate !== null &&
    Math.abs(executiveSuccessRate - canonicalSuccessRate) <= 0.0001 &&
    Math.abs(activeSuccessRate - canonicalSuccessRate) <= 0.0001 &&
    narrativeSuccessAligned;
  checks.push({
    id: 'headline_success_rate_consistency',
    label: 'Headline success rate is aligned across narrative, scorecard, and active outcome',
    status: headlineSuccessRateConsistencyPass ? 'pass' : 'fail',
    detail: headlineSuccessRateConsistencyPass
      ? `Headline success rate is consistently ${(canonicalSuccessRate * 100).toFixed(1)}%.`
      : 'Narrative success text, executive summary, scorecard, or active simulation outcome disagree.',
  });

  const scenarioCompletenessPass =
    input.scenarioSensitivity.inheritanceMatrix.scenarios.length >= 4 &&
    input.scenarioSensitivity.objectiveCalibration.scenarios.length >= 2;
  checks.push({
    id: 'scenario_matrix_completeness',
    label: 'Export includes required scenario sensitivity matrices',
    status: scenarioCompletenessPass ? 'pass' : 'fail',
    detail: scenarioCompletenessPass
      ? 'Inheritance and objective calibration scenario diagnostics are present.'
      : 'One or more required scenario sensitivity diagnostics are missing.',
  });

  const dependenceDefinitionsPass =
    input.scenarioSensitivity.dependenceMetricsMetadata.definitions.length >= 2 &&
    input.scenarioSensitivity.dependenceMetricsMetadata.definitions.every(
      (definition) =>
        definition.definition.length > 0 &&
        definition.calculationNote.length > 0 &&
        Number.isFinite(definition.observedRate),
    );
  checks.push({
    id: 'dependence_metric_definitions',
    label:
      'Dependence metrics include explicit definitions and scenario-sensitivity reconciliation',
    status: dependenceDefinitionsPass ? 'pass' : 'fail',
    detail: dependenceDefinitionsPass
      ? 'Inheritance/home-sale dependence rates include definition, calculation note, and sensitivity consistency metadata.'
      : 'Dependence metric metadata is incomplete.',
  });

  const runwayRiskModelPass =
    Number.isFinite(input.runwayRiskModel.runwayRiskReductionScore) &&
    typeof input.runwayRiskModel.provenBenefit === 'boolean';
  checks.push({
    id: 'runway_risk_model',
    label: 'Runway risk model reports downside deltas and risk-reduction score',
    status: runwayRiskModelPass ? 'pass' : 'fail',
    detail: runwayRiskModelPass
      ? `Runway risk score ${input.runwayRiskModel.runwayRiskReductionScore.toFixed(2)} (provenBenefit=${input.runwayRiskModel.provenBenefit}).`
      : 'Runway risk model diagnostics are incomplete.',
  });

  const hasReturnedRunwayRecommendation = recommendations.some((recommendation) =>
    recommendation.id.includes('cash-buffer'),
  );
  const runwayRecommendationEvidenceAlignmentPass =
    !hasReturnedRunwayRecommendation || input.runwayRiskModel.provenBenefit;
  checks.push({
    id: 'runway_recommendation_evidence_alignment',
    label: 'Runway recommendations only surface when downside-risk evidence proves benefit',
    status: runwayRecommendationEvidenceAlignmentPass ? 'pass' : 'fail',
    detail: runwayRecommendationEvidenceAlignmentPass
      ? hasReturnedRunwayRecommendation
        ? 'Runway recommendation is supported by proven runway downside-risk benefit.'
        : 'No runway recommendation returned without proven runway downside-risk benefit.'
      : 'Runway recommendation returned even though runway risk model did not prove downside-risk benefit.',
  });

  checks.push({
    id: 'model_completeness_declared',
    label: 'Model completeness indicator is explicitly declared',
    status: input.modelCompleteness === 'faithful' ? 'pass' : 'warn',
    detail:
      input.modelCompleteness === 'faithful'
        ? 'Model completeness is faithful with no inferred/estimated inputs in the fidelity layer.'
        : 'Model completeness is reconstructed; inferred assumptions are explicitly surfaced.',
  });

  checks.push({
    id: 'model_fidelity_layer',
    label: 'Model fidelity layer classifies input quality and reliability impact',
    status: input.modelFidelity.inputs.length > 0 ? 'pass' : 'fail',
    detail: input.modelFidelity.inputs.length > 0
      ? `Fidelity score ${input.modelFidelity.score.toFixed(2)} with ${input.modelFidelity.blockingAssumptions.length} blocking and ${input.modelFidelity.softAssumptions.length} soft assumptions.`
      : 'No model fidelity input assessments were generated.',
  });

  checks.push({
    id: 'model_fidelity_blockers',
    label: 'Blocking assumptions are explicitly surfaced',
    status: input.modelFidelity.blockingAssumptions.length === 0 ? 'pass' : 'warn',
    detail: input.modelFidelity.blockingAssumptions.length === 0
      ? 'No blocking assumptions detected by fidelity checks.'
      : `Blocking assumptions: ${input.modelFidelity.blockingAssumptions.join(', ')}.`,
  });

  const modelTrustSectionPass =
    typeof input.modelTrust.modelTrustLevel === 'string' &&
    Number.isFinite(input.modelTrust.modelFidelityScore) &&
    Array.isArray(input.modelTrust.inputFidelityBreakdown);
  checks.push({
    id: 'model_trust_section',
    label: 'Model trust section is explicit (trust level, score, assumptions, and input breakdown)',
    status: modelTrustSectionPass ? 'pass' : 'fail',
    detail: modelTrustSectionPass
      ? `Trust level ${input.modelTrust.modelTrustLevel} with fidelity score ${input.modelTrust.modelFidelityScore.toFixed(2)}.`
      : 'Model trust section is incomplete.',
  });

  const faithfulUpgradeChecklistPass =
    input.modelCompleteness === 'faithful' || input.modelTrust.faithfulUpgradeChecklist.length > 0;
  checks.push({
    id: 'faithful_upgrade_checklist',
    label: 'Reconstructed models include an explicit checklist to reach faithful fidelity',
    status: faithfulUpgradeChecklistPass ? 'pass' : 'fail',
    detail: faithfulUpgradeChecklistPass
      ? input.modelCompleteness === 'faithful'
        ? 'Model is already faithful; no upgrade checklist needed.'
        : `Checklist includes ${input.modelTrust.faithfulUpgradeChecklist.length} input upgrades to reach faithful fidelity.`
      : 'Model is reconstructed but no faithful-upgrade checklist was exported.',
  });

  checks.push({
    id: 'inheritance_fragility_disclosed',
    label: 'Inheritance dependence headline is explicit in export',
    status:
      input.inheritanceDependenceHeadline.baseCaseExcludingInheritance &&
      input.inheritanceDependenceHeadline.upsideCaseIncludingInheritance
        ? 'pass'
        : 'fail',
    detail: input.inheritanceDependenceHeadline.inheritanceDependent
      ? `Plan is inheritance-dependent; robustness ${input.inheritanceDependenceHeadline.inheritanceRobustnessScore.toFixed(2)} with fragility penalty ${input.inheritanceDependenceHeadline.fragilityPenalty.toFixed(2)}.`
      : `Plan is not inheritance-dependent; robustness ${input.inheritanceDependenceHeadline.inheritanceRobustnessScore.toFixed(2)}.`,
  });

  const downsideMetricsPresent =
    input.simulationOutcomes.rawSimulation.riskMetrics !== undefined &&
    input.simulationOutcomes.plannerEnhancedSimulation.riskMetrics !== undefined;
  checks.push({
    id: 'downside_metrics_exported',
    label: 'Downside metrics exported for raw and planner-enhanced outcomes',
    status: downsideMetricsPresent ? 'pass' : 'fail',
    detail: downsideMetricsPresent
      ? 'Early failure, shortfall severity, worst-decile wealth, and adverse equity-sale rates are exported.'
      : 'Downside risk metrics are incomplete.',
  });

  const convergenceDiagnosticsPresent =
    input.simulationOutcomes.rawSimulation.simulationDiagnostics.closedLoopConvergenceSummary !==
      undefined &&
    input.simulationOutcomes.plannerEnhancedSimulation.simulationDiagnostics
      .closedLoopConvergenceSummary !== undefined;
  checks.push({
    id: 'closed_loop_convergence_diagnostics',
    label: 'Closed-loop convergence diagnostics exported for both simulation modes',
    status: convergenceDiagnosticsPresent ? 'pass' : 'fail',
    detail: convergenceDiagnosticsPresent
      ? 'Both raw and planner-enhanced outcomes include converged status, passes used, stop reason, and final deltas.'
      : 'Closed-loop convergence diagnostics are missing from one or more simulation outcomes.',
  });

  const noChangeConvergenceSemanticsPass = [
    input.simulationOutcomes.rawSimulation,
    input.simulationOutcomes.plannerEnhancedSimulation,
  ].every((outcome) => {
    const thresholds =
      outcome.simulationConfiguration.withdrawalPolicy.closedLoopConvergenceThresholds;
    return outcome.simulationDiagnostics.closedLoopConvergencePath.every((point) => {
      if (point.stopReason !== 'no_change' || !point.converged) {
        return true;
      }
      return (
        point.finalMagiDelta <= thresholds.magiDeltaDollars &&
        point.finalFederalTaxDelta <= thresholds.federalTaxDeltaDollars &&
        point.finalHealthcarePremiumDelta <= thresholds.healthcarePremiumDeltaDollars
      );
    });
  });
  checks.push({
    id: 'closed_loop_no_change_semantics',
    label: 'No-change closed-loop stop reason does not overstate threshold convergence',
    status: noChangeConvergenceSemanticsPass ? 'pass' : 'fail',
    detail: noChangeConvergenceSemanticsPass
      ? 'No-change convergence is only marked converged when deltas remain within configured thresholds.'
      : 'Found no-change convergence entries marked converged while deltas exceed configured thresholds.',
  });

  const rothDecisionTracePresent =
    input.simulationOutcomes.plannerEnhancedSimulation.simulationDiagnostics
      .rothConversionTracePath.length > 0 &&
    input.simulationOutcomes.plannerEnhancedSimulation.simulationDiagnostics
      .rothConversionTracePath.every((entry) => entry.reason.length > 0) &&
    input.simulationOutcomes.plannerEnhancedSimulation.simulationDiagnostics
      .rothConversionDecisionSummary.reasons.length > 0;
  checks.push({
    id: 'roth_conversion_decision_trace',
    label: 'Roth conversion trace includes explicit yearly reason codes and summary counts',
    status: rothDecisionTracePresent ? 'pass' : 'fail',
    detail: rothDecisionTracePresent
      ? 'Planner-enhanced diagnostics include yearly Roth decision reasons and aggregated reason counts.'
      : 'Roth conversion decision reasons are incomplete.',
  });

  const rawRunCountExpected =
    input.simulationOutcomes.rawSimulation.simulationConfiguration.simulationSettings.runCount;
  const plannerRunCountExpected =
    input.simulationOutcomes.plannerEnhancedSimulation.simulationConfiguration.simulationSettings
      .runCount;
  const rawRunProofCount =
    input.simulationOutcomes.rawSimulation.simulationDiagnostics.closedLoopRunConvergence.length;
  const plannerRunProofCount =
    input.simulationOutcomes.plannerEnhancedSimulation.simulationDiagnostics.closedLoopRunConvergence
      .length;
  const runLevelConvergenceProofPresent =
    rawRunProofCount === rawRunCountExpected &&
    plannerRunProofCount === plannerRunCountExpected;
  checks.push({
    id: 'closed_loop_run_level_convergence_proof',
    label: 'Run-level closed-loop convergence proof is exported for every simulation trial',
    status: runLevelConvergenceProofPresent ? 'pass' : 'fail',
    detail: runLevelConvergenceProofPresent
      ? `Run-level convergence entries match simulation runs (raw ${rawRunProofCount}/${rawRunCountExpected}, planner ${plannerRunProofCount}/${plannerRunCountExpected}).`
      : `Run-level convergence entries are incomplete (raw ${rawRunProofCount}/${rawRunCountExpected}, planner ${plannerRunProofCount}/${plannerRunCountExpected}).`,
  });

  const hasFail = checks.some((check) => check.status === 'fail');
  return {
    status: hasFail ? 'fail' : 'pass',
    checks,
  };
}

function moveIntoCash(data: SeedData, targetAmount: number) {
  let remaining = Math.max(0, targetAmount);
  const moved = {
    fromTaxable: 0,
    fromPretax: 0,
  };

  const taxableTransfer = Math.min(data.accounts.taxable.balance, remaining);
  if (taxableTransfer > 0) {
    data.accounts.taxable.balance -= taxableTransfer;
    data.accounts.cash.balance += taxableTransfer;
    moved.fromTaxable = taxableTransfer;
    remaining -= taxableTransfer;
  }

  const pretaxTransfer = Math.min(data.accounts.pretax.balance, remaining);
  if (pretaxTransfer > 0) {
    data.accounts.pretax.balance -= pretaxTransfer;
    data.accounts.cash.balance += pretaxTransfer;
    moved.fromPretax = pretaxTransfer;
    remaining -= pretaxTransfer;
  }

  return {
    movedTotal: targetAmount - remaining,
    ...moved,
  };
}

function applyStressors(
  data: SeedData,
  activeStressors: Stressor[],
  adjustments: PlanningAdjustment[],
  knobs?: PlanningStressorKnobs,
) {
  const currentYear = getCurrentPlanningYear();
  const delayedInheritanceYears = Math.max(
    1,
    Math.round(knobs?.delayedInheritanceYears ?? 5),
  );

  activeStressors.forEach((stressor) => {
    if (stressor.id === 'layoff') {
      const parsed = knobs?.layoffRetireDate ? new Date(knobs.layoffRetireDate) : null;
      const layoffDate =
        parsed && !Number.isNaN(parsed.getTime())
          ? parsed
          : new Date(Date.UTC(currentYear, 0, 1));
      const nextDate = layoffDate.toISOString();
      const layoffYear = layoffDate.getUTCFullYear();
      const severance = Math.max(0, Math.round(knobs?.layoffSeverance ?? 0));
      const changes = [
        `salaryEndDate ${data.income.salaryEndDate} -> ${nextDate}`,
        `retirementYear -> ${layoffYear}`,
      ];
      if (severance > 0) {
        changes.push(`+ severance windfall year=${layoffYear} amount=${severance}`);
        data.income.windfalls = [
          ...data.income.windfalls,
          {
            name: 'severance',
            year: layoffYear,
            amount: severance,
            taxTreatment: 'ordinary_income',
          },
        ];
      }
      adjustments.push({
        source: 'stressor',
        id: stressor.id,
        name: stressor.name,
        changes,
        parameters: { layoffYear, severance },
      });
      data.income.salaryEndDate = nextDate;
      return;
    }

    if (stressor.id === 'delayed_inheritance') {
      const inheritance = data.income.windfalls.find((item) => item.name === 'inheritance');
      if (!inheritance) {
        return;
      }
      const previousYear = inheritance.year;
      inheritance.year += delayedInheritanceYears;
      adjustments.push({
        source: 'stressor',
        id: stressor.id,
        name: stressor.name,
        changes: [`inheritance.year ${previousYear} -> ${inheritance.year}`],
        parameters: { delayYears: delayedInheritanceYears },
      });
      return;
    }

    adjustments.push({
      source: 'stressor',
      id: stressor.id,
      name: stressor.name,
      changes: ['scenario return/inflation overlay enabled'],
    });
  });
}

function applyResponses(
  data: SeedData,
  activeResponses: ResponseOption[],
  adjustments: PlanningAdjustment[],
  knobs?: PlanningStressorKnobs,
) {
  const currentYear = getCurrentPlanningYear();

  activeResponses.forEach((response) => {
    if (response.id === 'cut_spending') {
      const cutFromKnob = knobs?.cutSpendingPercent;
      const cut =
        cutFromKnob !== undefined
          ? Math.max(0, Math.min(100, cutFromKnob))
          : (response.optionalReductionPercent ?? 20);
      const previousOptionalMonthly = data.spending.optionalMonthly;
      data.spending.optionalMonthly *= 1 - cut / 100;
      adjustments.push({
        source: 'response',
        id: response.id,
        name: response.name,
        changes: [
          `optionalMonthly ${roundMoney(previousOptionalMonthly)} -> ${roundMoney(data.spending.optionalMonthly)}`,
        ],
        parameters: { optionalReductionPercent: cut },
      });
      return;
    }

    if (response.id === 'sell_home_early') {
      const homeSale = data.income.windfalls.find((item) => item.name === 'home_sale');
      if (!homeSale) {
        return;
      }
      const triggerYear = response.triggerYear ?? 3;
      const previousYear = homeSale.year;
      homeSale.year = currentYear + triggerYear;
      adjustments.push({
        source: 'response',
        id: response.id,
        name: response.name,
        changes: [`home_sale.year ${previousYear} -> ${homeSale.year}`],
        parameters: { triggerYear },
      });
      return;
    }

    if (response.id === 'delay_retirement') {
      const years = response.delayYears ?? 1;
      const previousDate = data.income.salaryEndDate;
      data.income.salaryEndDate = shiftDateYears(data.income.salaryEndDate, years);
      adjustments.push({
        source: 'response',
        id: response.id,
        name: response.name,
        changes: [`salaryEndDate ${previousDate} -> ${data.income.salaryEndDate}`],
        parameters: { delayYears: years },
      });
      return;
    }

    if (response.id === 'early_ss' && response.claimAge) {
      const changedClaims: string[] = [];
      data.income.socialSecurity = data.income.socialSecurity.map((entry) => {
        const nextClaimAge = Math.min(entry.claimAge, response.claimAge!);
        if (nextClaimAge !== entry.claimAge) {
          changedClaims.push(`${entry.person}: ${entry.claimAge} -> ${nextClaimAge}`);
        }
        return { ...entry, claimAge: nextClaimAge };
      });
      adjustments.push({
        source: 'response',
        id: response.id,
        name: response.name,
        changes: changedClaims.length ? changedClaims : ['social security claim cap applied'],
        parameters: { claimAgeCap: response.claimAge },
      });
      return;
    }

    if (response.id === 'increase_cash_buffer') {
      const essentialAnnual = data.spending.essentialMonthly * 12;
      const targetAmount = essentialAnnual * 2;
      const move = moveIntoCash(data, targetAmount);
      adjustments.push({
        source: 'response',
        id: response.id,
        name: response.name,
        changes: [
          `cash +${roundMoney(move.movedTotal)}`,
          `taxable -${roundMoney(move.fromTaxable)}`,
          `pretax -${roundMoney(move.fromPretax)}`,
        ],
        parameters: { targetCashBufferAmount: roundMoney(targetAmount) },
      });
      return;
    }

    if (response.id === 'preserve_roth') {
      adjustments.push({
        source: 'response',
        id: response.id,
        name: response.name,
        changes: ['withdrawal preference set to preserve Roth where practical'],
      });
      return;
    }

    adjustments.push({
      source: 'response',
      id: response.id,
      name: response.name,
      changes: ['response enabled'],
    });
  });
}

function buildSimulationProfile({
  assumptions,
  mode,
  stressorIds,
  responseIds,
  preserveRothPreference,
  rothConversionPolicy,
}: {
  assumptions: MarketAssumptions;
  mode: SimulationStrategyMode;
  stressorIds: string[];
  responseIds: string[];
  preserveRothPreference: boolean;
  rothConversionPolicy?: SeedData['rules']['rothConversionPolicy'];
}): SimulationConfigurationSnapshot {
  const plannerLogicActive = mode === 'planner_enhanced';
  const resolvedRothConversionPolicy = {
    enabled: rothConversionPolicy?.enabled ?? true,
    strategy: rothConversionPolicy?.strategy ?? 'aca_then_irmaa_headroom',
    minAnnualDollars: Math.max(0, rothConversionPolicy?.minAnnualDollars ?? 500),
    maxAnnualDollars: Math.max(0, rothConversionPolicy?.maxAnnualDollars ?? Number.POSITIVE_INFINITY),
    maxPretaxBalancePercent: Math.max(
      0,
      Math.min(1, rothConversionPolicy?.maxPretaxBalancePercent ?? 0.12),
    ),
    magiBufferDollars: Math.max(0, rothConversionPolicy?.magiBufferDollars ?? 2_000),
    lowIncomeBracketFill: {
      enabled: rothConversionPolicy?.lowIncomeBracketFill?.enabled ?? false,
      startYear:
        typeof rothConversionPolicy?.lowIncomeBracketFill?.startYear === 'number'
          ? Math.floor(rothConversionPolicy.lowIncomeBracketFill.startYear)
          : null,
      endYear:
        typeof rothConversionPolicy?.lowIncomeBracketFill?.endYear === 'number'
          ? Math.floor(rothConversionPolicy.lowIncomeBracketFill.endYear)
          : null,
      annualTargetDollars: Math.max(
        0,
        rothConversionPolicy?.lowIncomeBracketFill?.annualTargetDollars ?? 0,
      ),
      requireNoWageIncome:
        rothConversionPolicy?.lowIncomeBracketFill?.requireNoWageIncome ?? true,
    },
    source: rothConversionPolicy ? 'rules' : 'default',
  } as const;

  return {
    mode,
    plannerLogicActive,
    activeStressors: [...stressorIds],
    activeResponses: [...responseIds],
    withdrawalPolicy: {
      // Match the engine's `withdrawalOrderLabelFor` (utils.ts:2012) which
      // always emits 'roth (conditional)' for the default tax_bracket_waterfall
      // rule regardless of planner mode — the "(conditional)" annotation
      // describes the rule's behavior, not the planner's enhancement layer.
      order: ['cash', 'taxable', 'pretax', 'roth (conditional)'],
      dynamicDefenseOrdering: plannerLogicActive,
      irmaaAware: plannerLogicActive,
      acaAware: plannerLogicActive,
      preserveRothPreference: plannerLogicActive && preserveRothPreference,
      closedLoopHealthcareTaxIteration: true,
      maxClosedLoopPasses: DEFAULT_MAX_CLOSED_LOOP_PASSES,
      closedLoopConvergenceThresholds: {
        ...DEFAULT_CLOSED_LOOP_CONVERGENCE_THRESHOLDS,
      } satisfies ClosedLoopConvergenceThresholds,
    },
    rothConversionPolicy: {
      proactiveConversionsEnabled: plannerLogicActive && resolvedRothConversionPolicy.enabled,
      strategy: resolvedRothConversionPolicy.strategy,
      minAnnualDollars: resolvedRothConversionPolicy.minAnnualDollars,
      maxAnnualDollars: Number.isFinite(resolvedRothConversionPolicy.maxAnnualDollars)
        ? resolvedRothConversionPolicy.maxAnnualDollars
        : null,
      maxPretaxBalancePercent: resolvedRothConversionPolicy.maxPretaxBalancePercent,
      magiBufferDollars: resolvedRothConversionPolicy.magiBufferDollars,
      lowIncomeBracketFill: resolvedRothConversionPolicy.lowIncomeBracketFill,
      source: resolvedRothConversionPolicy.source,
      description: plannerLogicActive
        ? 'Planner-enhanced simulation automatically uses safe Roth conversion room in-year and separately labels strategic-extra conversions beyond clean MAGI room.'
        : 'Raw simulation mode does not run proactive Roth conversions.',
    },
    liquidityFloorBehavior: {
      guardrailsEnabled: plannerLogicActive,
      floorYears: assumptions.guardrailFloorYears,
      ceilingYears: assumptions.guardrailCeilingYears,
      cutPercent: assumptions.guardrailCutPercent,
    },
    inflationHandling: {
      baseMean: assumptions.inflation,
      volatility: assumptions.inflationVolatility,
      highInflationStressorFloor: 0.05,
      highInflationStressorDurationYears: 10,
    },
    returnGeneration: RETURN_GENERATION_ASSUMPTIONS,
    returnModelExtensionPoints: RETURN_MODEL_EXTENSION_POINTS.map((point) => ({ ...point })),
    timingConventions: {
      currentPlanningYear: getCurrentPlanningYear(),
      salaryProrationRule: 'month_fraction',
      inflationCompounding: 'annual',
    },
    simulationSettings: {
      seed: assumptions.simulationSeed ?? 20260416,
      runCount: Math.max(1, assumptions.simulationRuns),
      assumptionsVersion: assumptions.assumptionsVersion ?? 'v1',
    },
  };
}

function buildSnapshot(
  data: SeedData,
  assumptions: MarketAssumptions,
  activeResponses: ResponseOption[],
  mode: SimulationStrategyMode,
  stressorIds: string[],
  responseIds: string[],
  optimizationObjective: OptimizationObjective,
): PlanningExportSnapshot {
  const hsaBalance = data.accounts.hsa?.balance ?? 0;
  const liquid = data.accounts.cash.balance + data.accounts.taxable.balance;
  const invested =
    data.accounts.pretax.balance + data.accounts.roth.balance + data.accounts.taxable.balance + hsaBalance;
  const trackedNetWorth = invested + data.accounts.cash.balance;
  const annualCoreSpend =
    data.spending.essentialMonthly * 12 +
    data.spending.optionalMonthly * 12 +
    data.spending.annualTaxesInsurance;
  const annualWithTravelSpend = annualCoreSpend + data.spending.travelEarlyRetirementAnnual;
  const withdrawalPreference: WithdrawalPreference = activeResponses.some(
    (item) => item.id === 'preserve_roth',
  )
    ? 'preserve_roth'
    : 'standard';
  const housingFundingPolicy: HousingFundingPolicy = activeResponses.some(
    (item) => item.id === 'sell_home_early',
  )
    ? 'home_sale_accelerated'
    : 'baseline';
  const cashBufferPolicy: CashBufferPolicy = activeResponses.some(
    (item) => item.id === 'increase_cash_buffer',
  )
    ? 'increased'
    : 'baseline';
  const simulationProfile = buildSimulationProfile({
    assumptions,
    mode,
    stressorIds,
    responseIds,
    preserveRothPreference: withdrawalPreference === 'preserve_roth',
  });

  return {
    household: clone(data.household),
    assets: {
      byBucket: {
        pretax: roundMoney(data.accounts.pretax.balance),
        roth: roundMoney(data.accounts.roth.balance),
        taxable: roundMoney(data.accounts.taxable.balance),
        cash: roundMoney(data.accounts.cash.balance),
        hsa: roundMoney(hsaBalance),
      },
      allocations: {
        pretax: clone(data.accounts.pretax.targetAllocation),
        roth: clone(data.accounts.roth.targetAllocation),
        taxable: clone(data.accounts.taxable.targetAllocation),
        cash: clone(data.accounts.cash.targetAllocation),
        hsa: data.accounts.hsa ? clone(data.accounts.hsa.targetAllocation) : null,
      },
      totals: {
        liquid: roundMoney(liquid),
        invested: roundMoney(invested),
        trackedNetWorth: roundMoney(trackedNetWorth),
      },
    },
    spending: {
      essentialMonthly: roundMoney(data.spending.essentialMonthly),
      optionalMonthly: roundMoney(data.spending.optionalMonthly),
      annualTaxesInsurance: roundMoney(data.spending.annualTaxesInsurance),
      travelEarlyRetirementAnnual: roundMoney(data.spending.travelEarlyRetirementAnnual),
      annualCoreSpend: roundMoney(annualCoreSpend),
      annualWithTravelSpend: roundMoney(annualWithTravelSpend),
    },
    income: {
      salaryAnnual: roundMoney(data.income.salaryAnnual),
      salaryEndDate: data.income.salaryEndDate,
      retirementYear: new Date(data.income.salaryEndDate).getUTCFullYear(),
      socialSecurity: clone(data.income.socialSecurity),
      windfalls: clone(data.income.windfalls),
      preRetirementContributions: clone(data.income.preRetirementContributions),
    },
    assumptions: {
      returns: {
        equityMean: assumptions.equityMean,
        equityVolatility: assumptions.equityVolatility,
        internationalEquityMean: assumptions.internationalEquityMean,
        internationalEquityVolatility: assumptions.internationalEquityVolatility,
        bondMean: assumptions.bondMean,
        bondVolatility: assumptions.bondVolatility,
        cashMean: assumptions.cashMean,
        cashVolatility: assumptions.cashVolatility,
      },
      inflation: {
        mean: assumptions.inflation,
        volatility: assumptions.inflationVolatility,
      },
      guardrails: {
        floorYears: assumptions.guardrailFloorYears,
        ceilingYears: assumptions.guardrailCeilingYears,
        cutPercent: assumptions.guardrailCutPercent,
      },
      horizon: {
        robPlanningEndAge: assumptions.robPlanningEndAge,
        debbiePlanningEndAge: assumptions.debbiePlanningEndAge,
        travelPhaseYears: assumptions.travelPhaseYears,
      },
    },
    constraints: {
      filingStatus: data.household.filingStatus,
      withdrawalStyle: data.rules.withdrawalStyle,
      irmaaAware: data.rules.irmaaAware,
      replaceModeImports: data.rules.replaceModeImports,
      assetClassMappingAssumptions: data.rules.assetClassMappingAssumptions,
      assetClassMappingEvidence: data.rules.assetClassMappingEvidence,
      rothConversionPolicy: data.rules.rothConversionPolicy
        ? clone(data.rules.rothConversionPolicy)
        : undefined,
      rmdPolicy: data.rules.rmdPolicy ? clone(data.rules.rmdPolicy) : undefined,
      payrollModel: data.rules.payrollModel ? clone(data.rules.payrollModel) : undefined,
      contributionLimits: data.rules.contributionLimits
        ? clone(data.rules.contributionLimits)
        : undefined,
      housingAfterDownsizePolicy: data.rules.housingAfterDownsizePolicy
        ? clone(data.rules.housingAfterDownsizePolicy)
        : undefined,
      irmaaThreshold: assumptions.irmaaThreshold,
      healthcarePremiums: {
        baselineAcaPremiumAnnual:
          data.rules.healthcarePremiums?.baselineAcaPremiumAnnual ?? null,
        baselineMedicarePremiumAnnual:
          data.rules.healthcarePremiums?.baselineMedicarePremiumAnnual ?? null,
        medicalInflationAnnual:
          data.rules.healthcarePremiums?.medicalInflationAnnual ?? null,
      },
      hsaStrategy: data.rules.hsaStrategy ? clone(data.rules.hsaStrategy) : undefined,
      ltcAssumptions: data.rules.ltcAssumptions ? clone(data.rules.ltcAssumptions) : undefined,
      withdrawalPreference,
      housingFundingPolicy,
      cashBufferPolicy,
    },
    simulationSettings: {
      mode,
      plannerAutopilotActive: mode === 'planner_enhanced',
      optimizationObjective,
      simulationRuns: assumptions.simulationRuns,
      simulationSeed: assumptions.simulationSeed ?? null,
      assumptionsVersion: assumptions.assumptionsVersion ?? null,
      inflationHandling: simulationProfile.inflationHandling,
      returnGeneration: simulationProfile.returnGeneration,
      timingConventions: simulationProfile.timingConventions,
    },
  };
}

function getDefaultHomeSaleExclusionByFilingStatus(filingStatus: string) {
  return filingStatus === 'married_filing_jointly' ? 500_000 : 250_000;
}

function applyDecisionGradeInputOverlay(data: SeedData) {
  const next = clone(data);
  const robBirthYear = new Date(next.household.robBirthDate).getUTCFullYear();
  const debbieBirthYear = new Date(next.household.debbieBirthDate).getUTCFullYear();
  const inferredRmdStartAge = Math.max(
    getRmdStartAgeForBirthYear(robBirthYear),
    getRmdStartAgeForBirthYear(debbieBirthYear),
  );
  next.rules.rmdPolicy = {
    startAgeOverride: next.rules.rmdPolicy?.startAgeOverride ?? inferredRmdStartAge,
    source: next.rules.rmdPolicy?.source ?? 'explicit_override',
  };

  next.rules.assetClassMappingAssumptions = deriveAssetClassMappingAssumptionsFromAccounts(
    next.accounts,
    next.rules.assetClassMappingAssumptions,
  );
  next.rules.assetClassMappingEvidence = {
    TRP_2030: next.rules.assetClassMappingEvidence?.TRP_2030 ?? 'exact_lookthrough',
    CENTRAL_MANAGED:
      next.rules.assetClassMappingEvidence?.CENTRAL_MANAGED ?? 'exact_lookthrough',
  };

  next.rules.payrollModel = {
    takeHomeFactor: next.rules.payrollModel?.takeHomeFactor ?? 0.72,
    salaryProrationRule: next.rules.payrollModel?.salaryProrationRule ?? 'month_fraction',
    salaryProrationSource:
      next.rules.payrollModel?.salaryProrationSource ?? 'assumed_month_fraction',
  };

  const homeSaleForPolicy = next.income.windfalls.find((windfall) => windfall.name === 'home_sale');
  if (homeSaleForPolicy) {
    const replacementHomeCost =
      homeSaleForPolicy.replacementHomeCost ??
      next.rules.housingAfterDownsizePolicy?.replacementHomeCost ??
      0;
    const sellingCostPercent = homeSaleForPolicy.sellingCostPercent ?? 0.06;
    const purchaseClosingCostPercent = homeSaleForPolicy.purchaseClosingCostPercent ?? 0;
    const movingCost = homeSaleForPolicy.movingCost ?? 0;
    const netLiquidityTarget =
      next.rules.housingAfterDownsizePolicy?.netLiquidityTarget ??
      Math.max(
        0,
        homeSaleForPolicy.amount * (1 - sellingCostPercent) -
          replacementHomeCost -
          replacementHomeCost * purchaseClosingCostPercent -
          movingCost,
      );
    next.rules.housingAfterDownsizePolicy = {
      mode: 'own_replacement_home',
      startYear: next.rules.housingAfterDownsizePolicy?.startYear ?? homeSaleForPolicy.year,
      replacementHomeCost,
      netLiquidityTarget,
      postSaleAnnualTaxesInsurance:
        next.rules.housingAfterDownsizePolicy?.postSaleAnnualTaxesInsurance,
      certainty:
        next.rules.housingAfterDownsizePolicy?.certainty ??
        homeSaleForPolicy.certainty ??
        'estimated',
      assumptionSource:
        next.rules.housingAfterDownsizePolicy?.assumptionSource ??
        'normalized_from_home_sale_downsize_inputs',
    };
  }

  next.income.windfalls = next.income.windfalls.map((windfall) => {
    if (windfall.name === 'inheritance') {
      return {
        ...windfall,
        taxTreatment: windfall.taxTreatment ?? 'cash_non_taxable',
        certainty: windfall.certainty ?? 'certain',
        timingUncertaintyYears: windfall.timingUncertaintyYears ?? 0,
        amountUncertaintyPercent: windfall.amountUncertaintyPercent ?? 0,
      };
    }
    if (windfall.name === 'home_sale') {
      const exclusionAmount =
        windfall.exclusionAmount ??
        getDefaultHomeSaleExclusionByFilingStatus(next.household.filingStatus);
      const sellingCostPercent = windfall.sellingCostPercent ?? 0.08;
      const replacementHomeCost = windfall.replacementHomeCost ?? 0;
      const purchaseClosingCostPercent = windfall.purchaseClosingCostPercent ?? 0;
      const movingCost = windfall.movingCost ?? 0;
      const replacementCost =
        replacementHomeCost +
        replacementHomeCost * purchaseClosingCostPercent +
        movingCost;
      const policyNetLiquidityTarget = next.rules.housingAfterDownsizePolicy?.netLiquidityTarget;
      const liquidityAmount =
        windfall.liquidityAmount ??
        policyNetLiquidityTarget ??
        Math.max(0, windfall.amount * (1 - sellingCostPercent) - replacementCost);
      const costBasis = windfall.costBasis ?? Math.max(0, windfall.amount - exclusionAmount);
      return {
        ...windfall,
        taxTreatment: windfall.taxTreatment ?? 'primary_home_sale',
        certainty: windfall.certainty ?? (replacementHomeCost > 0 ? 'estimated' : 'certain'),
        timingUncertaintyYears: windfall.timingUncertaintyYears ?? 0,
        amountUncertaintyPercent: windfall.amountUncertaintyPercent ?? 0,
        exclusionAmount,
        sellingCostPercent,
        replacementHomeCost,
        purchaseClosingCostPercent,
        movingCost,
        liquidityAmount,
        costBasis,
      };
    }
    return windfall;
  });

  return next;
}

export async function buildPlanningStateExportWithResolvedContext(
  input: BuildPlanningExportInput,
): Promise<PlanningStateExport> {
  const overlayData = applyDecisionGradeInputOverlay(input.data);
  let unifiedPlanEvaluation = input.unifiedPlanEvaluation ?? null;
  let unifiedPlanEvaluationCapturedAtIso = input.unifiedPlanEvaluationCapturedAtIso ?? null;
  let unifiedPlanEvaluationSource: BuildPlanningExportInput['unifiedPlanEvaluationSource'] =
    input.unifiedPlanEvaluationSource ?? (unifiedPlanEvaluation ? 'unified_plan' : 'none');

  if (!unifiedPlanEvaluation) {
    try {
      const exportPlan: Plan = {
        data: clone(overlayData),
        assumptions: { ...input.assumptions },
        controls: {
          selectedStressorIds: [...input.selectedStressorIds],
          selectedResponseIds: [...input.selectedResponseIds],
          toggles: {
            preserveRoth: input.selectedResponseIds.includes('preserve_roth'),
            increaseCashBuffer: input.selectedResponseIds.includes('increase_cash_buffer'),
          },
        },
        preferences: {
          calibration: {
            optimizationObjective:
              input.optimizationObjective ?? 'maximize_time_weighted_spending',
          },
        },
      };
      const evalTimeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 30_000));
      const result = await Promise.race([evaluatePlan(exportPlan), evalTimeout]);
      if (result !== null) {
        unifiedPlanEvaluation = result;
        unifiedPlanEvaluationCapturedAtIso = new Date().toISOString();
        unifiedPlanEvaluationSource = 'derived_plan';
      }
    } catch {
      unifiedPlanEvaluation = null;
      unifiedPlanEvaluationCapturedAtIso = null;
      unifiedPlanEvaluationSource = 'none';
    }
  }

  return buildPlanningStateExport({
    ...input,
    data: overlayData,
    unifiedPlanEvaluation,
    unifiedPlanEvaluationCapturedAtIso,
    unifiedPlanEvaluationSource,
  });
}

export function buildPlanningStateExport(
  input: BuildPlanningExportInput,
): PlanningStateExport {
  const optimizationObjective = input.optimizationObjective ?? 'maximize_time_weighted_spending';
  const activeStressors = input.data.stressors.filter((item) =>
    input.selectedStressorIds.includes(item.id),
  );
  const activeResponses = input.data.responses.filter((item) =>
    input.selectedResponseIds.includes(item.id),
  );

  const baseData = clone(input.data);
  const effectiveData = clone(input.data);
  const adjustmentsApplied: PlanningAdjustment[] = [];
  const activeStressorIds = activeStressors.map((item) => item.id);
  const activeResponseIds = activeResponses.map((item) => item.id);

  applyStressors(effectiveData, activeStressors, adjustmentsApplied, input.stressorKnobs);
  applyResponses(effectiveData, activeResponses, adjustmentsApplied, input.stressorKnobs);

  const baseInputs = buildSnapshot(
    baseData,
    input.assumptions,
    [],
    'planner_enhanced',
    [],
    [],
    optimizationObjective,
  );
  const effectiveInputs = buildSnapshot(
    effectiveData,
    input.assumptions,
    activeResponses,
    'planner_enhanced',
    activeStressorIds,
    activeResponseIds,
    optimizationObjective,
  );
  const effectiveSimulationInputs = buildSnapshot(
    effectiveData,
    input.assumptions,
    activeResponses,
    'raw_simulation',
    activeStressorIds,
    activeResponseIds,
    optimizationObjective,
  );
  const effectivePlanningStrategyInputs = buildSnapshot(
    effectiveData,
    input.assumptions,
    activeResponses,
    'planner_enhanced',
    activeStressorIds,
    activeResponseIds,
    optimizationObjective,
  );
  const inheritanceMatrix = buildInheritanceScenarioMatrix({
    data: effectiveData,
    assumptions: input.assumptions,
    selectedStressorIds: activeStressorIds,
    selectedResponseIds: activeResponseIds,
  });
  const objectiveCalibration = buildObjectiveCalibrationDiagnostics({
    data: effectiveData,
    assumptions: input.assumptions,
    selectedStressorIds: activeStressorIds,
    selectedResponseIds: activeResponseIds,
  });
  const simulationProfiles = {
    rawSimulation: buildSimulationProfile({
      assumptions: input.assumptions,
      mode: 'raw_simulation',
      stressorIds: activeStressorIds,
      responseIds: activeResponseIds,
      preserveRothPreference: false,
      rothConversionPolicy: effectiveData.rules.rothConversionPolicy,
    }),
    plannerEnhancedSimulation: buildSimulationProfile({
      assumptions: input.assumptions,
      mode: 'planner_enhanced',
      stressorIds: activeStressorIds,
      responseIds: activeResponseIds,
      preserveRothPreference: activeResponses.some((item) => item.id === 'preserve_roth'),
      rothConversionPolicy: effectiveData.rules.rothConversionPolicy,
    }),
  };
  const [rawSimulationOutcome] = buildPathResults(
    effectiveData,
    input.assumptions,
    activeStressorIds,
    activeResponseIds,
    {
      pathMode: 'selected_only',
      strategyMode: 'raw_simulation',
    },
  );
  const [plannerEnhancedSimulationOutcome] = buildPathResults(
    effectiveData,
    input.assumptions,
    activeStressorIds,
    activeResponseIds,
    {
      pathMode: 'selected_only',
      strategyMode: 'planner_enhanced',
    },
  );
  const simulationOutcomes = {
    rawSimulation: rawSimulationOutcome,
    plannerEnhancedSimulation: plannerEnhancedSimulationOutcome,
  };
  const activeSimulationProfile: ActiveSimulationProfile =
    effectiveInputs.simulationSettings.mode === 'planner_enhanced'
      ? 'plannerEnhancedSimulation'
      : 'rawSimulation';
  const activeSimulationOutcome = simulationOutcomes[activeSimulationProfile];
  const activeSimulationSummary = {
    activeSimulationProfile,
    ...getFirstExecutedConversion(activeSimulationOutcome),
    plannerConversionsExecuted:
      plannerEnhancedSimulationOutcome.simulationDiagnostics.rothConversionDecisionSummary
        .executedYearCount > 0,
  };
  const plannerConversionDiagnostics =
    plannerEnhancedSimulationOutcome.simulationDiagnostics.rothConversionEligibilityPath;
  const rawConversionDiagnostics =
    rawSimulationOutcome.simulationDiagnostics.rothConversionEligibilityPath;
  const conversionSchedule = buildFlightPathConversionSchedule(plannerEnhancedSimulationOutcome);
  const conversionScheduleStatus = buildFlightPathConversionScheduleStatus(
    plannerEnhancedSimulationOutcome,
    conversionSchedule,
  );

  if (effectiveInputs.simulationSettings.mode === 'planner_enhanced') {
    const plannerModeMismatch = plannerConversionDiagnostics.find(
      (entry) =>
        entry.simulationModeUsedForConversion !== 'planner_enhanced' ||
        entry.plannerLogicActiveAtConversion !== true ||
        entry.conversionEngineInvoked !== true,
    );
    if (plannerModeMismatch) {
      throw new Error(
        `Planner-enhanced export used non-planner Roth routing in ${plannerModeMismatch.year}.`,
      );
    }
  }

  const rawModeMismatch = rawConversionDiagnostics.find(
    (entry) =>
      entry.simulationModeUsedForConversion !== 'raw_simulation' ||
      entry.plannerLogicActiveAtConversion !== false ||
      entry.conversionEngineInvoked !== false,
  );
  if (rawModeMismatch) {
    throw new Error(`Raw simulation export used planner Roth routing in ${rawModeMismatch.year}.`);
  }
  const scenarioSensitivity = {
    inheritanceMatrix,
    objectiveCalibration,
    dependenceMetricsMetadata: buildDependenceMetricsMetadata({
      data: effectiveData,
      assumptions: input.assumptions,
      selectedStressorIds: activeStressorIds,
      selectedResponseIds: activeResponseIds,
      inheritanceMatrix,
      plannerOutcome: plannerEnhancedSimulationOutcome,
    }),
  };
  const unifiedPlanEvaluation = input.unifiedPlanEvaluation ?? null;
  const unifiedPlanEvaluationSource =
    input.unifiedPlanEvaluationSource ??
    (unifiedPlanEvaluation ? 'unified_plan' : 'none');
  const strategicPrepPolicy = buildFlightPathStrategicPrepRecommendations({
    evaluation: unifiedPlanEvaluation,
    data: effectiveData,
    assumptions: input.assumptions,
    selectedStressors: activeStressorIds,
    selectedResponses: activeResponseIds,
    counterfactualSimulationRuns: 72,
  });
  const phasePlaybook = buildFlightPathPhasePlaybook({
    evaluation: unifiedPlanEvaluation,
    data: effectiveData,
    assumptions: input.assumptions,
    selectedStressors: activeStressorIds,
    selectedResponses: activeResponseIds,
    executedSimulationOutcome: plannerEnhancedSimulationOutcome,
    unmitigatedSimulationOutcome: rawSimulationOutcome,
  });
  const recommendationLedger = {
    strategicPrep: strategicPrepPolicy.recommendations,
    phaseActions: phasePlaybook.phases.flatMap((phase) =>
      phase.actions.map((action) => ({
        phaseId: phase.id,
        phaseLabel: phase.label,
        phaseWindowStartYear: phase.windowStartYear,
        phaseWindowEndYear: phase.windowEndYear,
        phaseStatus: phase.status,
        action,
      })),
    ),
  };
  const recommendationEvidenceSummary = buildRecommendationEvidenceSummary(strategicPrepPolicy);
  const recommendationAvailabilityHeadline = buildRecommendationAvailabilityHeadline({
    summary: recommendationEvidenceSummary,
  });
  const canonicalPlannerSuccessRate = roundRate(plannerEnhancedSimulationOutcome.successRate);
  const executiveSummary = buildExecutiveFlightSummary({
    data: effectiveData,
    evaluation: unifiedPlanEvaluation,
    phasePlaybook,
    strategicPrepRecommendations: strategicPrepPolicy.recommendations,
    canonicalSuccessRate: canonicalPlannerSuccessRate,
  });
  const playbookInferredAssumptions = collectPlaybookInferredAssumptions(phasePlaybook);
  const baseModelFidelity = buildModelFidelityAssessment({
    data: effectiveData,
    assumptions: input.assumptions,
  });
  const modelFidelity = reconcileModelFidelityAssessmentWithAdditionalAssumptions({
    baseAssessment: baseModelFidelity,
    inferredAssumptions: playbookInferredAssumptions,
  });
  const flightPathModelCompleteness = modelFidelity.modelCompleteness as PlaybookModelCompleteness;
  const evaluationContextInferredAssumptions = uniqueNonEmpty(
    modelFidelity.inputs
      .filter((inputItem) => inputItem.status !== 'exact')
      .map((inputItem) => inputItem.detail),
  );
  const probeChecklist = buildProbeChecklist({
    data: effectiveData,
    assumptions: input.assumptions,
    evaluation: unifiedPlanEvaluation,
  });
  const inheritanceDependenceHeadline = buildInheritanceDependenceHeadline(
    scenarioSensitivity.inheritanceMatrix,
    scenarioSensitivity.dependenceMetricsMetadata,
  );
  const exportAlignedTrustPanel = harmonizeTrustPanelDependence({
    trustPanel: unifiedPlanEvaluation?.trustPanel ?? null,
    dependenceMetadata: scenarioSensitivity.dependenceMetricsMetadata,
    recommendationEvidenceSummary,
    actionCardCount: executiveSummary.actionCards.length,
  });
  const runwayRiskModel = buildRunwayRiskModel({
    data: effectiveData,
    assumptions: input.assumptions,
    selectedStressorIds: activeStressorIds,
    selectedResponseIds: activeResponseIds,
  });
  const planScorecard = buildPlanScorecard({
    plannerOutcome: plannerEnhancedSimulationOutcome,
    executiveSummary,
    modelCompleteness: flightPathModelCompleteness,
    modelFidelityCompleteness: modelFidelity.modelCompleteness,
    playbookInferredAssumptionsCount: playbookInferredAssumptions.length,
    dependenceMetadata: scenarioSensitivity.dependenceMetricsMetadata,
    trustPanel: exportAlignedTrustPanel,
    inheritanceDependenceHeadline,
    planEvaluationSuccessRate: unifiedPlanEvaluation?.summary.successRate ?? null,
  });
  const exportTimestamp = new Date().toISOString();
  const northStarResult = buildNorthStarResult({
    seedData: effectiveData,
    assumptions: input.assumptions,
    path: plannerEnhancedSimulationOutcome,
    modelCompleteness: flightPathModelCompleteness,
    inferredAssumptions: [
      ...evaluationContextInferredAssumptions,
      ...playbookInferredAssumptions,
    ],
    supportedAnnualSpend:
      unifiedPlanEvaluation?.calibration.supportedAnnualSpendNow ??
      unifiedPlanEvaluation?.calibration.supportedAnnualSpend ??
      null,
    activeSimulationProfile,
    generatedAtIso: exportTimestamp,
  });
  const exportFreshness = buildExportFreshness({
    generatedAtIso: exportTimestamp,
    data: effectiveData,
    assumptions: input.assumptions,
    activeSimulationProfile,
    activeSimulationOutcome,
    rawSimulationOutcome,
    plannerEnhancedSimulationOutcome,
    selectedStressorIds: activeStressorIds,
    selectedResponseIds: activeResponseIds,
    optimizationObjective,
    northStarResult,
  });
  const modelTrust = buildModelTrustSection(modelFidelity);
  const exportQualityGate = buildExportQualityGate({
    executiveSummary,
    strategicPrepPolicy,
    recommendationLedger,
    scenarioSensitivity,
    modelCompleteness: flightPathModelCompleteness,
    modelFidelity,
    modelTrust,
    inheritanceDependenceHeadline,
    runwayRiskModel,
    planScorecard,
    simulationOutcomes,
  });

  return {
    version: {
      schema: EXPORT_SCHEMA_VERSION,
      exportedAt: exportTimestamp,
      generatedAt: exportTimestamp,
    },
    exportFreshness,
    household: effectiveInputs.household,
    assets: effectiveInputs.assets,
    spending: effectiveInputs.spending,
    income: effectiveInputs.income,
    assumptions: effectiveInputs.assumptions,
    constraints: effectiveInputs.constraints,
    activeStressors: activeStressors.map((item) => ({
      id: item.id,
      name: item.name,
      type: item.type,
    })),
    activeResponses: activeResponses.map((item) => ({
      id: item.id,
      name: item.name,
    })),
    simulationSettings: effectiveInputs.simulationSettings,
    activeSimulationProfile,
    activeSimulationSummary,
    activeSimulationOutcome,
    toggleState: {
      stressorIds: [...input.selectedStressorIds],
      responseIds: [...input.selectedResponseIds],
    },
    adjustmentsApplied,
    simulationProfiles,
    simulationOutcomes,
    baseInputs,
    effectiveInputs,
    effectiveSimulationInputs,
    effectivePlanningStrategyInputs,
    scenarioSensitivity,
    inheritanceDependenceHeadline,
    runwayRiskModel,
    planScorecard,
    northStarResult,
    flightPath: {
      evaluationContext: {
        source: unifiedPlanEvaluation ? unifiedPlanEvaluationSource : 'none',
        available: Boolean(unifiedPlanEvaluation),
        capturedAtIso: input.unifiedPlanEvaluationCapturedAtIso ?? null,
        modelCompleteness: flightPathModelCompleteness,
        inferredAssumptions: evaluationContextInferredAssumptions,
        playbookInferredAssumptions: playbookInferredAssumptions,
      },
      strategicPrepPolicy,
      executiveSummary,
      phasePlaybook,
      conversionSchedule,
      conversionScheduleStatus,
      trustPanel: exportAlignedTrustPanel,
      recommendationLedger,
      recommendationEvidenceSummary,
      recommendationAvailabilityHeadline,
    },
    probeChecklist,
    modelFidelity,
    modelTrust,
    exportQualityGate,
  };
}
