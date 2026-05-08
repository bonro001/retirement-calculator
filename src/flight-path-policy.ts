import type { PlanEvaluation } from './plan-evaluation';
import type { OptimizationObjective } from './optimization-objective';
import type { MarketAssumptions, PathResult, SeedData } from './types';
import { buildPathResults, formatCurrency } from './utils';
import { evaluateRunwayBridgeRiskDelta } from './runway-utils';
import { buildPreRetirementOptimizerRecommendation } from './pre-retirement-optimizer';

export const FLIGHT_PATH_POLICY_VERSION = 'v0.5.0';
export const FLIGHT_PATH_THRESHOLD_PROFILE_VERSION = '2026-04-20';
export const FLIGHT_PATH_THRESHOLD_PROFILE_REVIEW_DATE = '2026-07-20';

export type StrategicPrepPriority = 'now' | 'soon' | 'watch';
export type StrategicPrepConfidenceLabel = 'low' | 'medium' | 'high';

interface StrategicPrepPolicyFlags {
  allowTaxOnlySignal?: boolean;
}

export interface StrategicPrepImpactEstimate {
  modeledBy: 'seeded_path_counterfactual' | 'heuristic_only';
  supportedMonthlyDelta: number;
  successRateDelta: number;
  medianEndingWealthDelta: number;
  annualFederalTaxDelta: number;
  yearsFundedDelta: number;
  medianFailureYearDelta: number;
  magiDelta: number;
  downsideRiskDelta: {
    earlyFailureProbabilityDelta: number;
    worstDecileEndingWealthDelta: number;
    spendingCutRateDelta: number;
    equitySalesInAdverseEarlyYearsRateDelta: number;
    medianFailureShortfallDollarsDelta: number;
    medianDownsideSpendingCutRequiredDelta: number;
  };
}

export interface StrategicPrepConfidence {
  label: StrategicPrepConfidenceLabel;
  score: number;
  rationale: string;
}

export interface StrategicPrepEvidence {
  baseline: {
    successRate: number;
    medianEndingWealth: number;
    annualFederalTaxEstimate: number;
    supportedMonthlySpendApprox: number;
    yearsFunded: number;
    medianFailureYear: number | null;
    medianMagiEstimate: number;
    earlyFailureProbability: number;
    worstDecileEndingWealth: number;
    spendingCutRate: number;
    equitySalesInAdverseEarlyYearsRate: number;
  } | null;
  counterfactual: {
    successRate: number;
    medianEndingWealth: number;
    annualFederalTaxEstimate: number;
    supportedMonthlySpendApprox: number;
    yearsFunded: number;
    medianFailureYear: number | null;
    medianMagiEstimate: number;
    earlyFailureProbability: number;
    worstDecileEndingWealth: number;
    spendingCutRate: number;
    equitySalesInAdverseEarlyYearsRate: number;
  } | null;
  simulationRunsUsed: number | null;
  simulationSeedUsed: number | null;
  notes: string[];
}

export interface StrategicPrepRecommendation {
  id: string;
  priority: StrategicPrepPriority;
  title: string;
  action: string;
  triggerReason: string;
  estimatedImpact: StrategicPrepImpactEstimate | null;
  tradeoffs: string[];
  confidence: StrategicPrepConfidence;
  sensitivityConsistency: {
    score: number;
    consistentScenarioCount: number;
    totalScenarioCount: number;
    rationale: string;
  };
  evidence: StrategicPrepEvidence;
  amountHint?: string;
  policyFlags?: StrategicPrepPolicyFlags;
}

interface StrategicPrepCandidate {
  id: string;
  priority: StrategicPrepPriority;
  title: string;
  action: string;
  triggerReason: string;
  amountHint?: string;
  tradeoffs: string[];
  counterfactualPatch?: CounterfactualPatch;
  policyFlags?: StrategicPrepPolicyFlags;
}

interface CounterfactualPatch {
  optionalMonthlyDelta?: number;
  travelAnnualDelta?: number;
  transferToCashFromTaxable?: number;
  transferFromCashToTaxable?: number;
  rothConversionMinAnnualDollarsDelta?: number;
  rothConversionMaxPretaxBalancePercentDelta?: number;
  rothConversionMagiBufferDollarsDelta?: number;
}

interface EvaluatedCandidateResult {
  recommendation: StrategicPrepRecommendation;
  patchedDataUsed: SeedData | null;
  patchScaleUsed: number;
}

type RecommendationCategory =
  | 'spending'
  | 'liquidity'
  | 'irmaa'
  | 'aca'
  | 'conversion'
  | 'withdrawal_mix'
  | 'unlock'
  | 'other';

export interface FlightPathPolicyInput {
  evaluation: PlanEvaluation | null;
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressors: string[];
  selectedResponses: string[];
  nowYear?: number;
  maxRecommendations?: number;
  counterfactualSimulationRuns?: number;
}

export interface FlightPathPolicyResult {
  policyVersion: string;
  recommendations: StrategicPrepRecommendation[];
  diagnostics: FlightPathPolicyDiagnostics;
}

export interface FlightPathPolicyNumericSummary {
  min: number;
  median: number;
  max: number;
  mean: number;
}

export interface FlightPathPolicyImpactDeltaSummary {
  candidateCount: number;
  supportedMonthlyDelta: FlightPathPolicyNumericSummary | null;
  successRateDelta: FlightPathPolicyNumericSummary | null;
  medianEndingWealthDelta: FlightPathPolicyNumericSummary | null;
  annualFederalTaxDelta: FlightPathPolicyNumericSummary | null;
  yearsFundedDelta: FlightPathPolicyNumericSummary | null;
  magiDelta: FlightPathPolicyNumericSummary | null;
  medianFailureYearDelta: FlightPathPolicyNumericSummary | null;
  earlyFailureProbabilityDelta: FlightPathPolicyNumericSummary | null;
  worstDecileEndingWealthDelta: FlightPathPolicyNumericSummary | null;
  spendingCutRateDelta: FlightPathPolicyNumericSummary | null;
  equitySalesInAdverseEarlyYearsRateDelta: FlightPathPolicyNumericSummary | null;
  medianFailureShortfallDollarsDelta: FlightPathPolicyNumericSummary | null;
  medianDownsideSpendingCutRequiredDelta: FlightPathPolicyNumericSummary | null;
}

export interface FlightPathPolicyFilterReason {
  recommendationId: string;
  reason: string;
}

export interface FlightPathPolicyRankedCandidate {
  recommendationId: string;
  category: string;
  score: number;
}

export interface FlightPathPolicyDiagnostics {
  policyVersion: string;
  thresholdProfileVersion: string;
  thresholdProfileReviewDate: string;
  activeOptimizationObjective: OptimizationObjective | null;
  counterfactualSimulationRuns: number | null;
  counterfactualSimulationSeed: number | null;
  candidatesConsidered: number;
  candidatesEvaluated: number;
  skippedBeforeEvaluation: FlightPathPolicyFilterReason[];
  hardConstraintFiltered: FlightPathPolicyFilterReason[];
  evidenceFiltered: FlightPathPolicyFilterReason[];
  acceptedAfterHardConstraints: number;
  acceptedAfterEvidenceGate: number;
  rankedCandidates: FlightPathPolicyRankedCandidate[];
  rankingFiltered: FlightPathPolicyFilterReason[];
  acceptedRecommendationIds: string[];
  candidateDecisionTrace: Array<{
    recommendationId: string;
    evaluated: boolean;
    patchScaleUsed: number | null;
    hardConstraintReason: string | null;
    evidenceGateReason: string | null;
    acceptedAfterEvidenceGate: boolean;
    returned: boolean;
    estimatedImpact: {
      successRateDelta: number;
      supportedMonthlyDelta: number;
      yearsFundedDelta: number;
      medianEndingWealthDelta: number;
      annualFederalTaxDelta: number;
      magiDelta: number;
    } | null;
  }>;
  impactDeltaSummaryAcceptedCandidates: FlightPathPolicyImpactDeltaSummary;
  impactDeltaSummaryReturnedRecommendations: FlightPathPolicyImpactDeltaSummary;
}

const DEFAULT_MAX_RECOMMENDATIONS = 6;
const DEFAULT_COUNTERFACTUAL_SIMULATION_RUNS = 72;
const DEFAULT_SENSITIVITY_SIMULATION_RUNS = 36;

export const FLIGHT_PATH_POLICY_THRESHOLDS = {
  spendGapTriggerMonthly: 200,
  recommendedCashBufferMonths: 18,
  cashBufferLowerBoundRatio: 0.92,
  cashBufferUpperBoundRatio: 1.5,
  irmaaHeadroomPressureDollars: 8_000,
  irmaaUrgentHeadroomDollars: 3_000,
  plannedConversionSuggestionMinimumAnnual: 2_500,
  withdrawalConcentrationRatio: 0.65,
  effectSignalNormalization: {
    successRateDelta: 0.025,
    supportedMonthlyDelta: 350,
    yearsFundedDelta: 1.5,
  },
  sensitivityDirection: {
    supportedMonthlyDeltaFloor: 40,
    signTolerance: 0.08,
  },
  evidenceGate: {
    minimumAbsSuccessRateDelta: 0.001,
    minimumAbsSupportedMonthlyDelta: 25,
    minimumAbsYearsFundedDelta: 0.1,
    minimumAbsMedianEndingWealthDelta: 25_000,
    minimumAbsAnnualFederalTaxDelta: 50,
    minimumConfidenceScore: 0.45,
    minimumSensitivityConsistencyScore: 0.6,
    runwayDownsideProof: {
      earlyFailureProbabilityDelta: -0.0025,
      worstDecileEndingWealthDelta: 5_000,
      spendingCutRateDelta: -0.01,
      equitySalesInAdverseEarlyYearsRateDelta: -0.01,
      medianFailureShortfallDollarsDelta: -1_000,
      medianDownsideSpendingCutRequiredDelta: -0.005,
    },
    taxOnlySignal: {
      minimumTaxBenefitDollars: 150,
      minimumNetEconomicBenefitDollars: 50_000,
      maxSupportedMonthlyDragDollars: 50,
      maxSuccessRateDrag: 0.001,
      taxBenefitWealthEquivalentYears: 15,
    },
  },
  hardGuardrails: {
    baselineBelowFloorSuccessDeltaTolerance: 0.0025,
    baselineBelowFloorLegacyDeltaToleranceDollars: 10_000,
    downsideImprovementThresholds: {
      earlyFailureProbabilityDelta: -0.001,
      worstDecileEndingWealthDelta: 2_500,
      spendingCutRateDelta: -0.005,
      equitySalesInAdverseEarlyYearsRateDelta: -0.005,
    },
  },
  confidenceScoreThresholds: {
    high: 0.7,
    medium: 0.42,
  },
} as const;

interface ModelCompletenessAssessment {
  indicator: 'faithful' | 'reconstructed';
  score: number;
  rationale: string;
  missingInputs: string[];
  inferredAssumptions: string[];
}

interface SensitivityScenarioResult {
  name: string;
  supportedMonthlyDelta: number;
  successRateDelta: number;
}

interface SensitivityScenarioDefinition {
  name: string;
  assumptions: MarketAssumptions;
  stressors: string[];
  responses: string[];
}

interface SensitivityStabilityAssessment {
  score: number;
  consistentScenarioCount: number;
  totalScenarioCount: number;
  rationale: string;
  scenarios: SensitivityScenarioResult[];
}

interface RankedDistinctRecommendationsResult {
  recommendations: StrategicPrepRecommendation[];
  rankedCandidates: FlightPathPolicyRankedCandidate[];
  rankingFiltered: FlightPathPolicyFilterReason[];
}

function cloneSeedData(data: SeedData): SeedData {
  return structuredClone(data) as SeedData;
}

function clampMin(value: number, minimum: number) {
  return value < minimum ? minimum : value;
}

function parseDateSafe(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function signWithTolerance(value: number, tolerance: number) {
  if (value > tolerance) {
    return 1;
  }
  if (value < -tolerance) {
    return -1;
  }
  return 0;
}

function summarizeNumericDeltas(values: number[]): FlightPathPolicyNumericSummary | null {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;

  return {
    min: sorted[0],
    median,
    max: sorted[sorted.length - 1],
    mean,
  };
}

function buildImpactDeltaSummary(
  recommendations: StrategicPrepRecommendation[],
): FlightPathPolicyImpactDeltaSummary {
  const impacts = recommendations
    .map((recommendation) => recommendation.estimatedImpact)
    .filter((impact): impact is StrategicPrepImpactEstimate => Boolean(impact));

  return {
    candidateCount: impacts.length,
    supportedMonthlyDelta: summarizeNumericDeltas(
      impacts.map((impact) => impact.supportedMonthlyDelta),
    ),
    successRateDelta: summarizeNumericDeltas(impacts.map((impact) => impact.successRateDelta)),
    medianEndingWealthDelta: summarizeNumericDeltas(
      impacts.map((impact) => impact.medianEndingWealthDelta),
    ),
    annualFederalTaxDelta: summarizeNumericDeltas(
      impacts.map((impact) => impact.annualFederalTaxDelta),
    ),
    yearsFundedDelta: summarizeNumericDeltas(impacts.map((impact) => impact.yearsFundedDelta)),
    magiDelta: summarizeNumericDeltas(impacts.map((impact) => impact.magiDelta)),
    medianFailureYearDelta: summarizeNumericDeltas(
      impacts.map((impact) => impact.medianFailureYearDelta),
    ),
    earlyFailureProbabilityDelta: summarizeNumericDeltas(
      impacts.map((impact) => impact.downsideRiskDelta.earlyFailureProbabilityDelta),
    ),
    worstDecileEndingWealthDelta: summarizeNumericDeltas(
      impacts.map((impact) => impact.downsideRiskDelta.worstDecileEndingWealthDelta),
    ),
    spendingCutRateDelta: summarizeNumericDeltas(
      impacts.map((impact) => impact.downsideRiskDelta.spendingCutRateDelta),
    ),
    equitySalesInAdverseEarlyYearsRateDelta: summarizeNumericDeltas(
      impacts.map(
        (impact) => impact.downsideRiskDelta.equitySalesInAdverseEarlyYearsRateDelta,
      ),
    ),
    medianFailureShortfallDollarsDelta: summarizeNumericDeltas(
      impacts.map((impact) => impact.downsideRiskDelta.medianFailureShortfallDollarsDelta),
    ),
    medianDownsideSpendingCutRequiredDelta: summarizeNumericDeltas(
      impacts.map(
        (impact) => impact.downsideRiskDelta.medianDownsideSpendingCutRequiredDelta,
      ),
    ),
  };
}

function assessModelCompleteness(input: FlightPathPolicyInput): ModelCompletenessAssessment {
  const missingInputs: string[] = [];
  const inferredAssumptions: string[] = [];

  if (!parseDateSafe(input.data.household.robBirthDate)) {
    missingInputs.push('household.robBirthDate');
  }
  if (!parseDateSafe(input.data.household.debbieBirthDate)) {
    missingInputs.push('household.debbieBirthDate');
  }
  if (!parseDateSafe(input.data.income.salaryEndDate)) {
    missingInputs.push('income.salaryEndDate');
  }
  if (!input.data.income.socialSecurity.length) {
    missingInputs.push('income.socialSecurity');
  } else {
    input.data.income.socialSecurity.forEach((entry, index) => {
      if (!(entry.fraMonthly > 0)) {
        missingInputs.push(`income.socialSecurity[${index}].fraMonthly`);
      }
      if (!(entry.claimAge > 0)) {
        missingInputs.push(`income.socialSecurity[${index}].claimAge`);
      }
    });
  }

  if (input.assumptions.simulationSeed === undefined) {
    inferredAssumptions.push('assumptions.simulationSeed(defaulted)');
  }
  if (!input.assumptions.assumptionsVersion) {
    inferredAssumptions.push('assumptions.assumptionsVersion(defaulted)');
  }

  const hasMissing = missingInputs.length > 0;
  const hasInferred = inferredAssumptions.length > 0;
  const indicator: 'faithful' | 'reconstructed' =
    hasMissing || hasInferred ? 'reconstructed' : 'faithful';
  const score = hasMissing ? 0.35 : hasInferred ? 0.7 : 1;
  const rationale = hasMissing
    ? 'Core plan inputs are missing or invalid, so recommendations rely on reconstructed assumptions.'
    : hasInferred
      ? 'Core inputs are present but one or more assumptions were defaulted by the model.'
      : 'All required core inputs and assumptions are explicitly provided.';

  return {
    indicator,
    score,
    rationale,
    missingInputs,
    inferredAssumptions,
  };
}

function firstYearSupportedMonthly(path: PathResult) {
  return (path.yearlySeries[0]?.medianSpending ?? 0) / 12;
}

function firstYearMagi(path: PathResult) {
  return path.yearlySeries[0]?.medianMagi ?? 0;
}

function resolvePathRiskMetrics(path: PathResult) {
  return {
    earlyFailureProbability: path.riskMetrics?.earlyFailureProbability ?? 0,
    worstDecileEndingWealth:
      path.riskMetrics?.worstDecileEndingWealth ?? path.tenthPercentileEndingWealth ?? 0,
    equitySalesInAdverseEarlyYearsRate:
      path.riskMetrics?.equitySalesInAdverseEarlyYearsRate ?? 0,
  };
}

function toPathSnapshot(path: PathResult) {
  const riskMetrics = resolvePathRiskMetrics(path);
  return {
    successRate: path.successRate,
    medianEndingWealth: path.medianEndingWealth,
    annualFederalTaxEstimate: path.annualFederalTaxEstimate,
    supportedMonthlySpendApprox: firstYearSupportedMonthly(path),
    yearsFunded: path.yearsFunded,
    medianFailureYear: path.medianFailureYear,
    medianMagiEstimate: firstYearMagi(path),
    earlyFailureProbability: riskMetrics.earlyFailureProbability,
    worstDecileEndingWealth: riskMetrics.worstDecileEndingWealth,
    spendingCutRate: path.spendingCutRate,
    equitySalesInAdverseEarlyYearsRate: riskMetrics.equitySalesInAdverseEarlyYearsRate,
  };
}

function resolveCounterfactualAssumptions(
  assumptions: MarketAssumptions,
  counterfactualSimulationRuns: number | undefined,
): MarketAssumptions {
  const cappedRuns = Math.max(
    24,
    Math.min(
      assumptions.simulationRuns,
      Math.max(
        24,
        Math.round(counterfactualSimulationRuns ?? DEFAULT_COUNTERFACTUAL_SIMULATION_RUNS),
      ),
    ),
  );
  return {
    ...assumptions,
    simulationRuns: cappedRuns,
    assumptionsVersion: assumptions.assumptionsVersion
      ? `${assumptions.assumptionsVersion}-flightpath-cf`
      : 'flightpath-cf',
  };
}

function runSeededPath(input: {
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressors: string[];
  selectedResponses: string[];
}): PathResult {
  return buildPathResults(
    input.data,
    input.assumptions,
    input.selectedStressors,
    input.selectedResponses,
    {
      pathMode: 'selected_only',
      strategyMode: 'planner_enhanced',
    },
  )[0];
}

function applyCounterfactualPatch(
  data: SeedData,
  patch: CounterfactualPatch,
): SeedData {
  const next = cloneSeedData(data);

  if (patch.optionalMonthlyDelta !== undefined) {
    next.spending.optionalMonthly = clampMin(
      next.spending.optionalMonthly + patch.optionalMonthlyDelta,
      0,
    );
  }

  if (patch.travelAnnualDelta !== undefined) {
    next.spending.travelEarlyRetirementAnnual = clampMin(
      next.spending.travelEarlyRetirementAnnual + patch.travelAnnualDelta,
      0,
    );
  }

  if (patch.transferToCashFromTaxable !== undefined && patch.transferToCashFromTaxable > 0) {
    const transfer = Math.min(next.accounts.taxable.balance, patch.transferToCashFromTaxable);
    next.accounts.taxable.balance -= transfer;
    next.accounts.cash.balance += transfer;
  }

  if (patch.transferFromCashToTaxable !== undefined && patch.transferFromCashToTaxable > 0) {
    const transfer = Math.min(next.accounts.cash.balance, patch.transferFromCashToTaxable);
    next.accounts.cash.balance -= transfer;
    next.accounts.taxable.balance += transfer;
  }

  if (patch.rothConversionMinAnnualDollarsDelta !== undefined) {
    next.rules.rothConversionPolicy = {
      ...(next.rules.rothConversionPolicy ?? {}),
      enabled: true,
      minAnnualDollars: clampMin(
        (next.rules.rothConversionPolicy?.minAnnualDollars ?? 500) +
          patch.rothConversionMinAnnualDollarsDelta,
        0,
      ),
    };
  }

  if (patch.rothConversionMaxPretaxBalancePercentDelta !== undefined) {
    next.rules.rothConversionPolicy = {
      ...(next.rules.rothConversionPolicy ?? {}),
      enabled: true,
      maxPretaxBalancePercent: Math.min(
        0.5,
        Math.max(
          0,
          (next.rules.rothConversionPolicy?.maxPretaxBalancePercent ?? 0.12) +
            patch.rothConversionMaxPretaxBalancePercentDelta,
        ),
      ),
    };
  }

  if (patch.rothConversionMagiBufferDollarsDelta !== undefined) {
    next.rules.rothConversionPolicy = {
      ...(next.rules.rothConversionPolicy ?? {}),
      enabled: true,
      magiBufferDollars: clampMin(
        (next.rules.rothConversionPolicy?.magiBufferDollars ?? 2_000) +
          patch.rothConversionMagiBufferDollarsDelta,
        0,
      ),
    };
  }

  return next;
}

function scaleCounterfactualPatch(patch: CounterfactualPatch, scale: number): CounterfactualPatch {
  const clampedScale = Math.max(0, Math.min(1, scale));
  return {
    optionalMonthlyDelta:
      patch.optionalMonthlyDelta === undefined ? undefined : patch.optionalMonthlyDelta * clampedScale,
    travelAnnualDelta:
      patch.travelAnnualDelta === undefined ? undefined : patch.travelAnnualDelta * clampedScale,
    transferToCashFromTaxable:
      patch.transferToCashFromTaxable === undefined
        ? undefined
        : patch.transferToCashFromTaxable * clampedScale,
    transferFromCashToTaxable:
      patch.transferFromCashToTaxable === undefined
        ? undefined
        : patch.transferFromCashToTaxable * clampedScale,
    rothConversionMinAnnualDollarsDelta:
      patch.rothConversionMinAnnualDollarsDelta === undefined
        ? undefined
        : patch.rothConversionMinAnnualDollarsDelta * clampedScale,
    rothConversionMaxPretaxBalancePercentDelta:
      patch.rothConversionMaxPretaxBalancePercentDelta === undefined
        ? undefined
        : patch.rothConversionMaxPretaxBalancePercentDelta * clampedScale,
    rothConversionMagiBufferDollarsDelta:
      patch.rothConversionMagiBufferDollarsDelta === undefined
        ? undefined
        : patch.rothConversionMagiBufferDollarsDelta * clampedScale,
  };
}

function estimateImpactFromPaths(
  baseline: PathResult,
  counterfactual: PathResult,
): StrategicPrepImpactEstimate {
  const runwayRiskDelta = evaluateRunwayBridgeRiskDelta({
    baselinePath: baseline,
    counterfactualPath: counterfactual,
  });
  return {
    modeledBy: 'seeded_path_counterfactual',
    supportedMonthlyDelta:
      firstYearSupportedMonthly(counterfactual) - firstYearSupportedMonthly(baseline),
    successRateDelta: counterfactual.successRate - baseline.successRate,
    medianEndingWealthDelta:
      counterfactual.medianEndingWealth - baseline.medianEndingWealth,
    annualFederalTaxDelta:
      counterfactual.annualFederalTaxEstimate - baseline.annualFederalTaxEstimate,
    yearsFundedDelta: counterfactual.yearsFunded - baseline.yearsFunded,
    medianFailureYearDelta:
      (counterfactual.medianFailureYear ?? 0) - (baseline.medianFailureYear ?? 0),
    magiDelta: firstYearMagi(counterfactual) - firstYearMagi(baseline),
    downsideRiskDelta: {
      earlyFailureProbabilityDelta: runwayRiskDelta.earlyFailureProbabilityDelta,
      worstDecileEndingWealthDelta: runwayRiskDelta.worstDecileEndingWealthDelta,
      spendingCutRateDelta: runwayRiskDelta.spendingCutRateDelta,
      equitySalesInAdverseEarlyYearsRateDelta:
        runwayRiskDelta.equitySalesInAdverseEarlyYearsRateDelta,
      medianFailureShortfallDollarsDelta:
        (counterfactual.riskMetrics?.medianFailureShortfallDollars ?? 0) -
        (baseline.riskMetrics?.medianFailureShortfallDollars ?? 0),
      medianDownsideSpendingCutRequiredDelta:
        (counterfactual.riskMetrics?.medianDownsideSpendingCutRequired ?? 0) -
        (baseline.riskMetrics?.medianDownsideSpendingCutRequired ?? 0),
    },
  };
}

function scoreEffectSignal(impact: StrategicPrepImpactEstimate | null) {
  if (!impact) {
    return 0;
  }
  const successSignal = Math.min(
    1,
    Math.abs(impact.successRateDelta) /
      FLIGHT_PATH_POLICY_THRESHOLDS.effectSignalNormalization.successRateDelta,
  );
  const spendSignal = Math.min(
    1,
    Math.abs(impact.supportedMonthlyDelta) /
      FLIGHT_PATH_POLICY_THRESHOLDS.effectSignalNormalization.supportedMonthlyDelta,
  );
  const fundedSignal = Math.min(
    1,
    Math.abs(impact.yearsFundedDelta) /
      FLIGHT_PATH_POLICY_THRESHOLDS.effectSignalNormalization.yearsFundedDelta,
  );
  return Number((0.45 * successSignal + 0.4 * spendSignal + 0.15 * fundedSignal).toFixed(2));
}

function mergeUniqueValues(values: string[]) {
  return [...new Set(values)];
}

function resolveSensitivityScenarios(
  assumptions: MarketAssumptions,
  baseRuns: number,
  selectedStressors: string[],
  selectedResponses: string[],
) {
  const sensitivityRuns = Math.max(
    24,
    Math.min(baseRuns, DEFAULT_SENSITIVITY_SIMULATION_RUNS),
  );
  const baseStressors = mergeUniqueValues(selectedStressors);
  const baseResponses = mergeUniqueValues(selectedResponses);

  const scenarios: SensitivityScenarioDefinition[] = [
    {
      name: 'adverse-macro',
      assumptions: {
        ...assumptions,
        simulationRuns: sensitivityRuns,
        equityMean: assumptions.equityMean - 0.01,
        inflation: Math.max(-0.98, assumptions.inflation + 0.005),
        assumptionsVersion: assumptions.assumptionsVersion
          ? `${assumptions.assumptionsVersion}-sens-adverse`
          : 'sens-adverse',
      } satisfies MarketAssumptions,
      stressors: baseStressors,
      responses: baseResponses,
    },
    {
      name: 'benign-macro',
      assumptions: {
        ...assumptions,
        simulationRuns: sensitivityRuns,
        equityMean: assumptions.equityMean + 0.005,
        inflation: Math.max(-0.98, assumptions.inflation - 0.003),
        assumptionsVersion: assumptions.assumptionsVersion
          ? `${assumptions.assumptionsVersion}-sens-benign`
          : 'sens-benign',
      } satisfies MarketAssumptions,
      stressors: baseStressors,
      responses: baseResponses,
    },
    {
      name: 'sequence-downturn',
      assumptions: {
        ...assumptions,
        simulationRuns: sensitivityRuns,
        assumptionsVersion: assumptions.assumptionsVersion
          ? `${assumptions.assumptionsVersion}-sens-sequence-downturn`
          : 'sens-sequence-downturn',
      } satisfies MarketAssumptions,
      stressors: mergeUniqueValues([...baseStressors, 'market_down']),
      responses: baseResponses,
    },
    {
      name: 'inflation-spike',
      assumptions: {
        ...assumptions,
        simulationRuns: sensitivityRuns,
        assumptionsVersion: assumptions.assumptionsVersion
          ? `${assumptions.assumptionsVersion}-sens-inflation-spike`
          : 'sens-inflation-spike',
      } satisfies MarketAssumptions,
      stressors: mergeUniqueValues([...baseStressors, 'inflation']),
      responses: baseResponses,
    },
    {
      name: 'inheritance-delay',
      assumptions: {
        ...assumptions,
        simulationRuns: sensitivityRuns,
        assumptionsVersion: assumptions.assumptionsVersion
          ? `${assumptions.assumptionsVersion}-sens-inheritance-delay`
          : 'sens-inheritance-delay',
      } satisfies MarketAssumptions,
      stressors: mergeUniqueValues([...baseStressors, 'delayed_inheritance']),
      responses: baseResponses,
    },
  ];

  return scenarios;
}

function assessSensitivityStability(input: {
  baseImpact: StrategicPrepImpactEstimate | null;
  hasCounterfactual: boolean;
  baselineData: SeedData;
  counterfactualData: SeedData | null;
  assumptions: MarketAssumptions;
  selectedStressors: string[];
  selectedResponses: string[];
  baselineScenarioPaths?: Map<string, PathResult>;
}): SensitivityStabilityAssessment {
  if (!input.baseImpact || !input.hasCounterfactual || !input.counterfactualData) {
    return {
      score: 0,
      consistentScenarioCount: 0,
      totalScenarioCount: 0,
      rationale: 'No counterfactual patch available for sensitivity stability analysis.',
      scenarios: [],
    };
  }

  const basePrimary =
    Math.abs(input.baseImpact.supportedMonthlyDelta) >=
    FLIGHT_PATH_POLICY_THRESHOLDS.sensitivityDirection.supportedMonthlyDeltaFloor
      ? input.baseImpact.supportedMonthlyDelta
      : input.baseImpact.successRateDelta * 100;
  const baseDirection = signWithTolerance(
    basePrimary,
    FLIGHT_PATH_POLICY_THRESHOLDS.sensitivityDirection.signTolerance,
  );

  const scenarios = resolveSensitivityScenarios(
    input.assumptions,
    input.assumptions.simulationRuns,
    input.selectedStressors,
    input.selectedResponses,
  );
  const scenarioResults: SensitivityScenarioResult[] = scenarios.map((scenario) => {
    const cachedBaseline = input.baselineScenarioPaths?.get(scenario.name);
    const baselinePath =
      cachedBaseline ??
      runSeededPath({
        data: input.baselineData,
        assumptions: scenario.assumptions,
        selectedStressors: scenario.stressors,
        selectedResponses: scenario.responses,
      });
    const counterfactualPath = runSeededPath({
      data: input.counterfactualData as SeedData,
      assumptions: scenario.assumptions,
      selectedStressors: scenario.stressors,
      selectedResponses: scenario.responses,
    });
    return {
      name: scenario.name,
      supportedMonthlyDelta:
        firstYearSupportedMonthly(counterfactualPath) -
        firstYearSupportedMonthly(baselinePath),
      successRateDelta: counterfactualPath.successRate - baselinePath.successRate,
    };
  });

  const consistentScenarioCount = scenarioResults.filter((scenario) => {
    const primary =
      Math.abs(scenario.supportedMonthlyDelta) >=
      FLIGHT_PATH_POLICY_THRESHOLDS.sensitivityDirection.supportedMonthlyDeltaFloor
        ? scenario.supportedMonthlyDelta
        : scenario.successRateDelta * 100;
    const direction = signWithTolerance(
      primary,
      FLIGHT_PATH_POLICY_THRESHOLDS.sensitivityDirection.signTolerance,
    );
    if (baseDirection === 0) {
      return direction === 0;
    }
    return direction === baseDirection;
  }).length;

  const totalScenarioCount = scenarioResults.length;
  const score =
    totalScenarioCount > 0 ? consistentScenarioCount / totalScenarioCount : 0;
  const rationale =
    totalScenarioCount > 0
      ? `${consistentScenarioCount}/${totalScenarioCount} sensitivity scenarios kept the same impact direction.`
      : 'No sensitivity scenarios were executed.';

  return {
    score: Number(score.toFixed(2)),
    consistentScenarioCount,
    totalScenarioCount,
    rationale,
    scenarios: scenarioResults,
  };
}

function scoreConfidenceFromSignals(input: {
  impact: StrategicPrepImpactEstimate | null;
  hasCounterfactual: boolean;
  stability: SensitivityStabilityAssessment;
  modelCompleteness: ModelCompletenessAssessment;
}): StrategicPrepConfidence {
  if (!input.hasCounterfactual || !input.impact) {
    return {
      label: 'low',
      score: Number((0.2 * input.modelCompleteness.score).toFixed(2)),
      rationale: `No seeded counterfactual run was available. Model completeness: ${input.modelCompleteness.indicator}.`,
    };
  }

  const effectScore = scoreEffectSignal(input.impact);
  const score = Number(
    (0.5 * effectScore + 0.3 * input.stability.score + 0.2 * input.modelCompleteness.score).toFixed(2),
  );

  if (score >= FLIGHT_PATH_POLICY_THRESHOLDS.confidenceScoreThresholds.high) {
    return {
      label: 'high',
      score,
      rationale: `Strong effect, stable across sensitivities (${input.stability.rationale}), and ${input.modelCompleteness.indicator} model inputs.`,
    };
  }
  if (score >= FLIGHT_PATH_POLICY_THRESHOLDS.confidenceScoreThresholds.medium) {
    return {
      label: 'medium',
      score,
      rationale: `Moderate net signal from effect + sensitivity stability (${input.stability.rationale}); model completeness is ${input.modelCompleteness.indicator}.`,
    };
  }
  return {
    label: 'low',
    score,
    rationale: `Limited confidence from effect/stability; ${input.modelCompleteness.indicator} model inputs reduce certainty.`,
  };
}

export function buildStrategicPrepCandidates(
  input: FlightPathPolicyInput,
): StrategicPrepCandidate[] {
  const candidates: StrategicPrepCandidate[] = [];
  const nowYear = input.nowYear ?? new Date().getFullYear();
  const autopilotYears = input.evaluation?.raw.run.autopilot.years ?? [];
  const nearYears = autopilotYears.filter((year) => year.year >= nowYear && year.year <= nowYear + 3);
  const firstNearYear = nearYears[0] ?? autopilotYears[0];

  if (input.evaluation) {
    const spendGapMonthly =
      input.evaluation.calibration.userTargetMonthlySpendNow -
      input.evaluation.calibration.supportedMonthlySpendNow;
    if (spendGapMonthly > FLIGHT_PATH_POLICY_THRESHOLDS.spendGapTriggerMonthly) {
      const monthlyTrim = Math.min(spendGapMonthly, input.data.spending.optionalMonthly);
      candidates.push({
        id: 'spend-gap-reduce',
        priority: 'now',
        title: 'Align spending to supported level',
        action: `Trim monthly spending by about ${formatCurrency(spendGapMonthly)} to match today's supported level.`,
        triggerReason:
          'Input lifestyle spending currently exceeds modeled supported spending at the active guardrail settings.',
        amountHint: `${formatCurrency(spendGapMonthly)} per month reduction`,
        tradeoffs: [
          'Immediate lifestyle flexibility may decrease in discretionary categories.',
          'Can improve guardrail headroom in downside paths.',
        ],
        counterfactualPatch: {
          optionalMonthlyDelta: -monthlyTrim,
        },
      });
    } else if (spendGapMonthly < -FLIGHT_PATH_POLICY_THRESHOLDS.spendGapTriggerMonthly) {
      const room = Math.abs(spendGapMonthly);
      candidates.push({
        id: 'spend-gap-room',
        priority: 'watch',
        title: 'You have near-term spending room',
        action: `You can increase monthly spending by up to about ${formatCurrency(room)} and stay inside the current supported path.`,
        triggerReason:
          'Modeled supported spending exceeds the current lifestyle input by a meaningful margin.',
        amountHint: `${formatCurrency(room)} per month potential increase`,
        tradeoffs: [
          'Higher discretionary spend can reduce legacy surplus.',
          'Sequence-risk buffer can narrow if markets underperform early.',
        ],
        counterfactualPatch: {
          optionalMonthlyDelta: Math.min(room, input.data.spending.optionalMonthly * 0.6),
        },
      });
    }
  }

  const essentialMonthlyWithFixed =
    input.data.spending.essentialMonthly + input.data.spending.annualTaxesInsurance / 12;
  const currentCash = input.data.accounts.cash.balance;
  const recommendedCashBuffer =
    essentialMonthlyWithFixed * FLIGHT_PATH_POLICY_THRESHOLDS.recommendedCashBufferMonths;
  if (
    currentCash <
    recommendedCashBuffer * FLIGHT_PATH_POLICY_THRESHOLDS.cashBufferLowerBoundRatio
  ) {
    const transferNeeded = recommendedCashBuffer - currentCash;
    candidates.push({
      id: 'cash-buffer-top-up',
      priority: 'now',
      title: 'Top up cash buffer runway',
      action: `Move about ${formatCurrency(transferNeeded)} into cash to reach an ${FLIGHT_PATH_POLICY_THRESHOLDS.recommendedCashBufferMonths}-month essential runway.`,
      triggerReason:
        'Current liquid buffer is below the near-term runway target for rough early-retirement weather.',
      amountHint: `Current cash ${formatCurrency(currentCash)} vs target ${formatCurrency(recommendedCashBuffer)}`,
      tradeoffs: [
        'Holding more cash can reduce long-run portfolio growth.',
        'Improves near-term liquidity and sequence defense.',
      ],
      counterfactualPatch: {
        transferToCashFromTaxable: transferNeeded,
      },
    });
  } else if (
    currentCash >
    recommendedCashBuffer * FLIGHT_PATH_POLICY_THRESHOLDS.cashBufferUpperBoundRatio
  ) {
    const excessCash = currentCash - recommendedCashBuffer;
    candidates.push({
      id: 'cash-buffer-redeploy',
      priority: 'watch',
      title: 'Excess cash drag check',
      action: `Consider redeploying around ${formatCurrency(excessCash)} from cash to your intended allocation.`,
      triggerReason:
        'Cash reserves are materially above near-term runway needs and may be creating return drag.',
      amountHint: `Cash above ${FLIGHT_PATH_POLICY_THRESHOLDS.recommendedCashBufferMonths}-month buffer: ${formatCurrency(excessCash)}`,
      tradeoffs: [
        'Lower cash can reduce flexibility during a sharp short-term downturn.',
        'Can improve long-run supportable spend if invested prudently.',
      ],
      counterfactualPatch: {
        transferFromCashToTaxable: excessCash,
      },
    });
  }

  const irmaaPressureYear = nearYears.find((year) => {
    const hasMedicareMembers = year.robAge >= 65 || year.debbieAge >= 65;
    if (!hasMedicareMembers) {
      return false;
    }
    const status = year.irmaaStatus.toLowerCase();
    return (
      status.includes('surcharge') ||
      (typeof year.irmaaHeadroom === 'number' &&
        year.irmaaHeadroom < FLIGHT_PATH_POLICY_THRESHOLDS.irmaaHeadroomPressureDollars)
    );
  });
  if (irmaaPressureYear) {
    const headroom = irmaaPressureYear.irmaaHeadroom ?? 0;
    const reductionNeeded =
      headroom < 0
        ? Math.abs(headroom)
        : Math.max(0, FLIGHT_PATH_POLICY_THRESHOLDS.irmaaHeadroomPressureDollars - headroom);
    const targetMagiCap = Math.max(0, irmaaPressureYear.estimatedMAGI - reductionNeeded);
    candidates.push({
      id: 'irmaa-cap',
      priority:
        headroom <= FLIGHT_PATH_POLICY_THRESHOLDS.irmaaUrgentHeadroomDollars
          ? 'now'
          : 'soon',
      title: 'Set an IRMAA MAGI cap',
      action: `For tax year ${irmaaPressureYear.year - 2}, plan MAGI near ${formatCurrency(targetMagiCap)} and avoid crossing current IRMAA thresholds.`,
      triggerReason:
        'Near-term route shows modeled Medicare surcharge pressure based on two-year lookback MAGI.',
      amountHint: `Approx MAGI reduction need: ${formatCurrency(reductionNeeded)}`,
      tradeoffs: [
        'Keeping MAGI lower may reduce near-term conversions or discretionary withdrawals.',
        'Can reduce Medicare premium surcharges in affected years.',
      ],
      counterfactualPatch: {
        optionalMonthlyDelta: -Math.min(
          input.data.spending.optionalMonthly * 0.5,
          reductionNeeded / 12,
        ),
      },
    });
  }

  const acaPressureYear = nearYears.find(
    (year) =>
      year.regime === 'aca_bridge' &&
      typeof year.acaFriendlyMagiCeiling === 'number' &&
      year.estimatedMAGI > year.acaFriendlyMagiCeiling,
  );
  if (acaPressureYear && typeof acaPressureYear.acaFriendlyMagiCeiling === 'number') {
    const overage = acaPressureYear.estimatedMAGI - acaPressureYear.acaFriendlyMagiCeiling;
    candidates.push({
      id: 'aca-bridge-cap',
      priority: 'now',
      title: 'Protect ACA bridge eligibility',
      action: `In ${acaPressureYear.year}, keep MAGI near or below ${formatCurrency(
        acaPressureYear.acaFriendlyMagiCeiling,
      )} by shifting withdrawals away from ordinary-income sources where possible.`,
      triggerReason:
        'ACA bridge year is currently modeled above subsidy-friendly MAGI limits.',
      amountHint: `Current modeled overage: ${formatCurrency(overage)}`,
      tradeoffs: [
        'Could require lower near-term discretionary spending or altered withdrawal sourcing.',
        'Can preserve subsidy support in bridge years before Medicare.',
      ],
      counterfactualPatch: {
        optionalMonthlyDelta: -Math.min(
          input.data.spending.optionalMonthly * 0.6,
          overage / 12,
        ),
      },
    });
  }

  const plannedConversions = nearYears
    .map((year) => year.suggestedRothConversion)
    .filter(
      (value) =>
        value > FLIGHT_PATH_POLICY_THRESHOLDS.plannedConversionSuggestionMinimumAnnual,
    );
  if (plannedConversions.length) {
    const averageConversion =
      plannedConversions.reduce((sum, value) => sum + value, 0) / plannedConversions.length;
    candidates.push({
      id: 'roth-conversion-program',
      priority: 'soon',
      title: 'Run an annual Roth conversion program',
      action: `Plan annual conversions around ${formatCurrency(averageConversion)} while staying below ACA/IRMAA guardrails.`,
      triggerReason:
        'Near-term route indicates conversion room that may reduce later forced-income pressure.',
      amountHint: `Average suggested conversion (${plannedConversions.length} yrs): ${formatCurrency(
        averageConversion,
      )}/yr`,
      tradeoffs: [
        'Conversions can raise near-term taxes and MAGI.',
        'Can reduce later RMD pressure and improve tax-shape flexibility.',
      ],
      counterfactualPatch: {
        rothConversionMinAnnualDollarsDelta: 1_500,
        rothConversionMaxPretaxBalancePercentDelta: 0.02,
        rothConversionMagiBufferDollarsDelta: -500,
      },
    });
  }

  if (firstNearYear) {
    const bucketWithdrawals = [
      { key: 'cash', value: firstNearYear.withdrawalCash },
      { key: 'taxable', value: firstNearYear.withdrawalTaxable },
      { key: 'pretax', value: firstNearYear.withdrawalIra401k },
      { key: 'roth', value: firstNearYear.withdrawalRoth },
    ];
    const totalWithdrawals = bucketWithdrawals.reduce((sum, item) => sum + item.value, 0);
    const dominant = [...bucketWithdrawals].sort((left, right) => right.value - left.value)[0];
    if (
      dominant &&
      totalWithdrawals > 0 &&
      dominant.value / totalWithdrawals >=
        FLIGHT_PATH_POLICY_THRESHOLDS.withdrawalConcentrationRatio
    ) {
      candidates.push({
        id: 'withdrawal-concentration',
        priority: 'watch',
        title: 'Balance withdrawal source concentration',
        action: `Current route leans heavily on ${dominant.key} (~${Math.round(
          (dominant.value / totalWithdrawals) * 100,
        )}% of ${firstNearYear.year} withdrawals). Keep source mix diversified to manage taxes and guardrail cliffs.`,
        triggerReason:
          'Near-term withdrawal sourcing is concentrated in one bucket, reducing flexibility under changing conditions.',
        amountHint: `${formatCurrency(dominant.value)} from ${dominant.key} in ${firstNearYear.year}`,
        tradeoffs: [
          'Smoothing sources can increase planning complexity year-to-year.',
          'Can reduce threshold-cliff risk and improve optionality later.',
        ],
        counterfactualPatch: {
          optionalMonthlyDelta: -Math.min(
            input.data.spending.optionalMonthly * 0.1,
            Math.max(0, dominant.value * 0.08) / 12,
          ),
          transferToCashFromTaxable: Math.max(
            0,
            Math.min(input.data.accounts.taxable.balance, 10_000),
          ),
        },
      });
    }
  }

  if (input.evaluation?.calibration.nextUnlock) {
    candidates.push({
      id: 'next-unlock',
      priority: input.evaluation.calibration.successConstraintBinding ? 'soon' : 'watch',
      title: 'Next unlock path',
      action: input.evaluation.calibration.nextUnlock,
      triggerReason:
        input.evaluation.calibration.successFloorRelaxationTradeoff ??
        'Current solver diagnostics identify this as the nearest high-impact unlock lever.',
      amountHint: `Estimated monthly impact: ${formatCurrency(
        input.evaluation.calibration.nextUnlockImpactMonthly,
      )}`,
      tradeoffs: [
        'Unlock actions usually trade one guardrail margin for another.',
      ],
      counterfactualPatch: {
        optionalMonthlyDelta: -Math.min(
          input.data.spending.optionalMonthly * 0.15,
          Math.max(0, input.evaluation.calibration.nextUnlockImpactMonthly) * 0.5,
        ),
      },
    });
  }

  // Pre-retirement accumulation (contribution optimizer). Fires when the
  // user is still working AND has material shortfalls on the pre-tax
  // buckets. Advisory-only (no counterfactual patch) — the recommendation
  // carries exact dollar amounts from the optimizer so the simulator
  // doesn't need to apply a numerical patch.
  const preRetirementRec = buildPreRetirementOptimizerRecommendation({
    seedData: input.data,
    assumptions: input.assumptions,
  });
  if (preRetirementRec.applicable && preRetirementRec.actionSteps.length > 0) {
    const topShortfallAction = preRetirementRec.actionSteps.find((step) =>
      step.action.startsWith('Increase'),
    );
    const bridgeAction = preRetirementRec.actionSteps.find(
      (step) =>
        step.action.includes('taxable brokerage') ||
        step.action.includes('Bridge is already'),
    );
    const primary = topShortfallAction ?? bridgeAction;
    if (primary) {
      const tradeoffs: string[] = [];
      if (!preRetirementRec.bothRecommendationsCompatible) {
        tradeoffs.push(
          'Current spending leaves no surplus after maxing pre-tax; choose between bridge build-up and contribution maximization.',
        );
      } else {
        tradeoffs.push(
          'Pre-tax contributions reduce current-year lifestyle flexibility.',
        );
      }
      if (preRetirementRec.bridge.bridgeCoverageGap > 10_000) {
        tradeoffs.push(
          `Taxable bridge currently has a ${formatCurrency(
            preRetirementRec.bridge.bridgeCoverageGap,
          )} coverage gap pre-Medicare.`,
        );
      } else if (preRetirementRec.bridge.bridgeWindowWindfallTotal > 0) {
        tradeoffs.push(
          `Bridge coverage relies on ${formatCurrency(
            preRetirementRec.bridge.bridgeWindowWindfallTotal,
          )} in expected windfalls (${preRetirementRec.bridge.bridgeWindowWindfallNames.join(
            ', ',
          )}); plan resilience drops if those don't arrive.`,
        );
      }

      const totalTaxSavings = preRetirementRec.shortfalls.reduce(
        (sum, shortfall) => sum + shortfall.estimatedMarginalFederalTaxSavedPerYear,
        0,
      );

      candidates.push({
        id: 'pre-retirement-accumulation',
        priority: 'now',
        title: 'Pre-retirement contribution optimization',
        action: primary.action,
        triggerReason: preRetirementRec.headline,
        amountHint:
          totalTaxSavings > 0
            ? `~${formatCurrency(totalTaxSavings)} / yr in current-year federal tax savings at 22% marginal`
            : 'Contribution limits already fully funded; bridge coverage already sufficient.',
        tradeoffs,
        policyFlags: { allowTaxOnlySignal: true },
      });
    }
  }

  return candidates;
}

function evaluateCandidateCounterfactual(input: {
  candidate: StrategicPrepCandidate;
  baselinePath: PathResult;
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressors: string[];
  selectedResponses: string[];
  baselineScenarioPaths?: Map<string, PathResult>;
}): {
  patchedDataUsed: SeedData | null;
  estimatedImpact: StrategicPrepImpactEstimate | null;
  evidence: StrategicPrepEvidence;
  stability: SensitivityStabilityAssessment;
} {
  const baselineSnapshot = toPathSnapshot(input.baselinePath);
  const runs = input.assumptions.simulationRuns;
  const seed = input.assumptions.simulationSeed ?? 20260416;

  if (!input.candidate.counterfactualPatch) {
    return {
      patchedDataUsed: null,
      estimatedImpact: null,
      evidence: {
        baseline: baselineSnapshot,
        counterfactual: null,
        simulationRunsUsed: runs,
        simulationSeedUsed: seed,
        notes: ['No deterministic patch defined; recommendation remains directional.'],
      },
      stability: {
        score: 0,
        consistentScenarioCount: 0,
        totalScenarioCount: 0,
        rationale: 'No counterfactual patch available for sensitivity stability analysis.',
        scenarios: [],
      },
    };
  }

  const patchedData = applyCounterfactualPatch(input.data, input.candidate.counterfactualPatch);
  const counterfactualPath = runSeededPath({
    data: patchedData,
    assumptions: input.assumptions,
    selectedStressors: input.selectedStressors,
    selectedResponses: input.selectedResponses,
  });
  const impact = estimateImpactFromPaths(input.baselinePath, counterfactualPath);
  const stability = assessSensitivityStability({
    baseImpact: impact,
    hasCounterfactual: true,
    baselineData: input.data,
    counterfactualData: patchedData,
    assumptions: input.assumptions,
    selectedStressors: input.selectedStressors,
    selectedResponses: input.selectedResponses,
    baselineScenarioPaths: input.baselineScenarioPaths,
  });

  return {
    patchedDataUsed: patchedData,
    estimatedImpact: impact,
    evidence: {
      baseline: baselineSnapshot,
      counterfactual: toPathSnapshot(counterfactualPath),
      simulationRunsUsed: runs,
      simulationSeedUsed: seed,
      notes: [
        'Impact estimated via seeded planner-enhanced path counterfactual.',
        `Sensitivity stability: ${stability.rationale}`,
      ],
    },
    stability,
  };
}

function detectHardConstraintViolation(input: {
  candidate: StrategicPrepCandidate;
  evaluation: PlanEvaluation;
  patchedDataUsed: SeedData | null;
  estimatedImpact: StrategicPrepImpactEstimate | null;
  evidence: StrategicPrepEvidence;
}): string | null {
  const { candidate, evaluation } = input;

  const actionText = `${candidate.id} ${candidate.title} ${candidate.action}`.toLowerCase();
  const constraints = evaluation.raw.run.plan.constraints;
  if (
    constraints.doNotRetireLater &&
    (actionText.includes('retire later') || actionText.includes('delay retirement'))
  ) {
    return 'Blocked by explicit user constraint: do not retire later.';
  }
  if (
    constraints.doNotSellHouse &&
    (actionText.includes('sell home') || actionText.includes('sell house'))
  ) {
    return 'Blocked by explicit user constraint: do not sell house.';
  }

  const patchedData = input.patchedDataUsed;
  if (patchedData) {
    const optionalMinimum = patchedData.spending.optionalMinimumMonthly ?? 0;
    if (patchedData.spending.optionalMonthly < optionalMinimum) {
      return 'Blocked by spending minimum: optional spending would fall below minimum.';
    }
    const travelMinimum = patchedData.spending.travelMinimumAnnual ?? 0;
    if (patchedData.spending.travelEarlyRetirementAnnual < travelMinimum) {
      return 'Blocked by spending minimum: travel spending would fall below minimum.';
    }
  }

  const counterfactual = input.evidence.counterfactual;
  if (counterfactual) {
    const baselineSuccessRate = input.evidence.baseline?.successRate ?? evaluation.summary.successRate;
    const minimumSuccessRateTarget = evaluation.calibration.minimumSuccessRateTarget;
    const successRateDelta = counterfactual.successRate - baselineSuccessRate;
    const downside = input.estimatedImpact?.downsideRiskDelta;
    const economicImproved = Boolean(
      (input.estimatedImpact?.medianEndingWealthDelta ?? 0) >= 25_000 ||
        (input.estimatedImpact?.annualFederalTaxDelta ?? 0) <= -25,
    );
    const downsideImproved = Boolean(
      downside &&
        (downside.earlyFailureProbabilityDelta <=
          FLIGHT_PATH_POLICY_THRESHOLDS.hardGuardrails.downsideImprovementThresholds
            .earlyFailureProbabilityDelta ||
          downside.worstDecileEndingWealthDelta >=
            FLIGHT_PATH_POLICY_THRESHOLDS.hardGuardrails.downsideImprovementThresholds
              .worstDecileEndingWealthDelta ||
          downside.spendingCutRateDelta <=
            FLIGHT_PATH_POLICY_THRESHOLDS.hardGuardrails.downsideImprovementThresholds
              .spendingCutRateDelta ||
          downside.equitySalesInAdverseEarlyYearsRateDelta <=
            FLIGHT_PATH_POLICY_THRESHOLDS.hardGuardrails.downsideImprovementThresholds
              .equitySalesInAdverseEarlyYearsRateDelta),
    );
    if (counterfactual.successRate < minimumSuccessRateTarget) {
      const baselineMeetsFloor = baselineSuccessRate >= minimumSuccessRateTarget;
      const successDeterioratesMaterially =
        successRateDelta <
        -FLIGHT_PATH_POLICY_THRESHOLDS.hardGuardrails.baselineBelowFloorSuccessDeltaTolerance;
      const qualifiesForBelowFloorPass =
        successRateDelta >=
          -FLIGHT_PATH_POLICY_THRESHOLDS.hardGuardrails.baselineBelowFloorSuccessDeltaTolerance &&
        (successRateDelta > 0 || downsideImproved || economicImproved);
      if (baselineMeetsFloor || successDeterioratesMaterially || !qualifiesForBelowFloorPass) {
        return 'Blocked by hard guardrail: counterfactual falls below minimum success floor.';
      }
    }

    const legacyDelta = input.estimatedImpact?.medianEndingWealthDelta ?? 0;
    const baselineLegacyToday =
      input.evidence.baseline?.medianEndingWealth ??
      evaluation.calibration.projectedLegacyTodayDollars;
    const projectedLegacyTodayApprox = baselineLegacyToday + legacyDelta;
    if (projectedLegacyTodayApprox + 1 < evaluation.calibration.legacyFloorTodayDollars) {
      const baselineAboveLegacyFloor =
        baselineLegacyToday + 1 >= evaluation.calibration.legacyFloorTodayDollars;
      const legacyDeterioratesMaterially =
        projectedLegacyTodayApprox <
        baselineLegacyToday -
          FLIGHT_PATH_POLICY_THRESHOLDS.hardGuardrails
            .baselineBelowFloorLegacyDeltaToleranceDollars;
      const qualifiesForBelowLegacyFloorPass =
        projectedLegacyTodayApprox >=
          baselineLegacyToday -
            FLIGHT_PATH_POLICY_THRESHOLDS.hardGuardrails
              .baselineBelowFloorLegacyDeltaToleranceDollars &&
        (legacyDelta > 0 || downsideImproved);
      if (baselineAboveLegacyFloor || legacyDeterioratesMaterially || !qualifiesForBelowLegacyFloorPass) {
        return 'Blocked by hard guardrail: projected legacy falls below legacy floor.';
      }
    }

    const baselineInOrAboveBand =
      baselineLegacyToday >= evaluation.calibration.legacyTargetBandLowerTodayDollars;
    if (
      baselineInOrAboveBand &&
      projectedLegacyTodayApprox + 1 <
        evaluation.calibration.legacyTargetBandLowerTodayDollars
    ) {
      return 'Blocked by hard guardrail: projected legacy falls below target landing band.';
    }
  }

  return null;
}

function evaluateCandidateCounterfactualWithAdaptiveScaling(input: {
  candidate: StrategicPrepCandidate;
  baselinePath: PathResult;
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressors: string[];
  selectedResponses: string[];
  evaluation: PlanEvaluation;
  baselineScenarioPaths?: Map<string, PathResult>;
}): {
  evaluated: ReturnType<typeof evaluateCandidateCounterfactual>;
  patchScaleUsed: number;
} {
  if (!input.candidate.counterfactualPatch) {
    return {
      evaluated: evaluateCandidateCounterfactual({
        candidate: input.candidate,
        baselinePath: input.baselinePath,
        data: input.data,
        assumptions: input.assumptions,
        selectedStressors: input.selectedStressors,
        selectedResponses: input.selectedResponses,
        baselineScenarioPaths: input.baselineScenarioPaths,
      }),
      patchScaleUsed: 1,
    };
  }

  const scaleCandidates = [1, 0.75, 0.5, 0.25];
  let fallback: {
    evaluated: ReturnType<typeof evaluateCandidateCounterfactual>;
    patchScaleUsed: number;
  } | null = null;

  for (const scale of scaleCandidates) {
    const scaledCandidate: StrategicPrepCandidate =
      scale === 1
        ? input.candidate
        : {
            ...input.candidate,
            counterfactualPatch: scaleCounterfactualPatch(input.candidate.counterfactualPatch, scale),
          };
    const evaluated = evaluateCandidateCounterfactual({
      candidate: scaledCandidate,
      baselinePath: input.baselinePath,
      data: input.data,
      assumptions: input.assumptions,
      selectedStressors: input.selectedStressors,
      selectedResponses: input.selectedResponses,
      baselineScenarioPaths: input.baselineScenarioPaths,
    });
    const attempt = { evaluated, patchScaleUsed: scale };
    fallback = attempt;
    const hardConstraintReason = detectHardConstraintViolation({
      candidate: input.candidate,
      evaluation: input.evaluation,
      patchedDataUsed: evaluated.patchedDataUsed,
      estimatedImpact: evaluated.estimatedImpact,
      evidence: evaluated.evidence,
    });
    if (!hardConstraintReason) {
      return attempt;
    }
  }

  return (
    fallback ?? {
      evaluated: evaluateCandidateCounterfactual({
        candidate: input.candidate,
        baselinePath: input.baselinePath,
        data: input.data,
        assumptions: input.assumptions,
        selectedStressors: input.selectedStressors,
        selectedResponses: input.selectedResponses,
      }),
      patchScaleUsed: 1,
    }
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasRunwayDownsideProof(input: {
  downsideRiskDelta: StrategicPrepImpactEstimate['downsideRiskDelta'];
}) {
  const thresholds = FLIGHT_PATH_POLICY_THRESHOLDS.evidenceGate.runwayDownsideProof;
  const downside = input.downsideRiskDelta;
  return (
    downside.earlyFailureProbabilityDelta <= thresholds.earlyFailureProbabilityDelta ||
    downside.worstDecileEndingWealthDelta >= thresholds.worstDecileEndingWealthDelta ||
    downside.spendingCutRateDelta <= thresholds.spendingCutRateDelta ||
    downside.equitySalesInAdverseEarlyYearsRateDelta <=
      thresholds.equitySalesInAdverseEarlyYearsRateDelta ||
    downside.medianFailureShortfallDollarsDelta <=
      thresholds.medianFailureShortfallDollarsDelta ||
    downside.medianDownsideSpendingCutRequiredDelta <=
      thresholds.medianDownsideSpendingCutRequiredDelta
  );
}

function detectEvidenceGateViolation(input: {
  recommendation: StrategicPrepRecommendation;
}): string | null {
  const { recommendation } = input;
  const { evidence, estimatedImpact } = recommendation;

  if (!evidence.baseline || !evidence.counterfactual) {
    return 'Filtered by evidence gate: baseline/counterfactual snapshots are required for actionable recommendations.';
  }
  if (evidence.simulationRunsUsed === null || evidence.simulationSeedUsed === null) {
    return 'Filtered by evidence gate: deterministic run metadata is incomplete.';
  }
  if (!estimatedImpact || estimatedImpact.modeledBy !== 'seeded_path_counterfactual') {
    return 'Filtered by evidence gate: measured seeded counterfactual impact is required.';
  }
  if (
    evidence.baseline.medianMagiEstimate === undefined ||
    evidence.counterfactual.medianMagiEstimate === undefined
  ) {
    return 'Filtered by evidence gate: MAGI deltas require baseline and counterfactual MAGI snapshots.';
  }
  if (!estimatedImpact.downsideRiskDelta) {
    return 'Filtered by evidence gate: downside-risk deltas are required.';
  }
  if (
    !isFiniteNumber(estimatedImpact.successRateDelta) ||
    !isFiniteNumber(estimatedImpact.supportedMonthlyDelta) ||
    !isFiniteNumber(estimatedImpact.yearsFundedDelta) ||
    !isFiniteNumber(estimatedImpact.medianEndingWealthDelta) ||
    !isFiniteNumber(estimatedImpact.annualFederalTaxDelta) ||
    !isFiniteNumber(estimatedImpact.magiDelta)
  ) {
    return 'Filtered by evidence gate: required impact deltas must be finite numbers.';
  }
  const downside = estimatedImpact.downsideRiskDelta;
  if (
    !isFiniteNumber(downside.earlyFailureProbabilityDelta) ||
    !isFiniteNumber(downside.worstDecileEndingWealthDelta) ||
    !isFiniteNumber(downside.spendingCutRateDelta) ||
    !isFiniteNumber(downside.equitySalesInAdverseEarlyYearsRateDelta) ||
    !isFiniteNumber(downside.medianFailureShortfallDollarsDelta) ||
    !isFiniteNumber(downside.medianDownsideSpendingCutRequiredDelta)
  ) {
    return 'Filtered by evidence gate: downside-risk deltas must be fully specified and finite.';
  }
  if (
    !isFiniteNumber(recommendation.confidence.score) ||
    recommendation.confidence.score <
      FLIGHT_PATH_POLICY_THRESHOLDS.evidenceGate.minimumConfidenceScore
  ) {
    return 'Filtered by evidence gate: confidence score is below policy minimum.';
  }
  if (
    !isFiniteNumber(recommendation.sensitivityConsistency.score) ||
    recommendation.sensitivityConsistency.score <
      FLIGHT_PATH_POLICY_THRESHOLDS.evidenceGate.minimumSensitivityConsistencyScore
  ) {
    return 'Filtered by evidence gate: sensitivity consistency score is below policy minimum.';
  }

  const successSignal =
    Math.abs(estimatedImpact.successRateDelta) >=
    FLIGHT_PATH_POLICY_THRESHOLDS.evidenceGate.minimumAbsSuccessRateDelta;
  const spendSignal =
    Math.abs(estimatedImpact.supportedMonthlyDelta) >=
    FLIGHT_PATH_POLICY_THRESHOLDS.evidenceGate.minimumAbsSupportedMonthlyDelta;
  const yearsFundedSignal =
    Math.abs(estimatedImpact.yearsFundedDelta) >=
    FLIGHT_PATH_POLICY_THRESHOLDS.evidenceGate.minimumAbsYearsFundedDelta;
  const wealthSignal =
    Math.abs(estimatedImpact.medianEndingWealthDelta) >=
    FLIGHT_PATH_POLICY_THRESHOLDS.evidenceGate.minimumAbsMedianEndingWealthDelta;
  const taxSignal =
    Math.abs(estimatedImpact.annualFederalTaxDelta) >=
    FLIGHT_PATH_POLICY_THRESHOLDS.evidenceGate.minimumAbsAnnualFederalTaxDelta;

  const meetsSignalThreshold =
    successSignal || spendSignal || yearsFundedSignal || wealthSignal || taxSignal;
  if (!meetsSignalThreshold) {
    return 'Filtered by evidence gate: measured deltas are below minimum signal thresholds (success/spend/funded/wealth/tax).';
  }

  const taxOnlySignal =
    taxSignal && !(successSignal || spendSignal || yearsFundedSignal || wealthSignal);
  if (taxOnlySignal) {
    const taxBenefitDollars = Math.max(0, -estimatedImpact.annualFederalTaxDelta);
    const wealthEquivalentTaxBenefit =
      taxBenefitDollars *
      FLIGHT_PATH_POLICY_THRESHOLDS.evidenceGate.taxOnlySignal.taxBenefitWealthEquivalentYears;
    const netEconomicBenefit =
      estimatedImpact.medianEndingWealthDelta + wealthEquivalentTaxBenefit;
    const strongerNetBenefitPass =
      taxBenefitDollars >=
        FLIGHT_PATH_POLICY_THRESHOLDS.evidenceGate.taxOnlySignal.minimumTaxBenefitDollars &&
      netEconomicBenefit >=
        FLIGHT_PATH_POLICY_THRESHOLDS.evidenceGate.taxOnlySignal.minimumNetEconomicBenefitDollars &&
      estimatedImpact.supportedMonthlyDelta >=
        -FLIGHT_PATH_POLICY_THRESHOLDS.evidenceGate.taxOnlySignal.maxSupportedMonthlyDragDollars &&
      estimatedImpact.successRateDelta >=
        -FLIGHT_PATH_POLICY_THRESHOLDS.evidenceGate.taxOnlySignal.maxSuccessRateDrag;
    const explicitAllowlist = recommendation.policyFlags?.allowTaxOnlySignal === true;
    if (!explicitAllowlist && !strongerNetBenefitPass) {
      return 'Filtered by evidence gate: tax-only signal requires explicit policy allowlist or stronger net economic benefit.';
    }
  }

  if (recommendation.id.includes('cash-buffer')) {
    if (!hasRunwayDownsideProof({ downsideRiskDelta: estimatedImpact.downsideRiskDelta })) {
      return 'Filtered by evidence gate: runway recommendation did not prove downside-risk improvement.';
    }
  }

  return null;
}

function classifyRecommendationCategory(candidate: StrategicPrepCandidate): RecommendationCategory {
  if (candidate.id.includes('spend-gap')) {
    return 'spending';
  }
  if (candidate.id.includes('cash-buffer')) {
    return 'liquidity';
  }
  if (candidate.id.includes('irmaa')) {
    return 'irmaa';
  }
  if (candidate.id.includes('aca')) {
    return 'aca';
  }
  if (candidate.id.includes('conversion')) {
    return 'conversion';
  }
  if (candidate.id.includes('withdrawal')) {
    return 'withdrawal_mix';
  }
  if (candidate.id.includes('unlock')) {
    return 'unlock';
  }
  return 'other';
}

function priorityBoost(priority: StrategicPrepPriority) {
  if (priority === 'now') {
    return 0.6;
  }
  if (priority === 'soon') {
    return 0.35;
  }
  return 0.1;
}

function objectiveAlignedScore(input: {
  objective: OptimizationObjective;
  impact: StrategicPrepImpactEstimate | null;
}) {
  if (!input.impact) {
    return 0;
  }
  const spend = input.impact.supportedMonthlyDelta;
  const successPts = input.impact.successRateDelta * 100;
  const legacy = input.impact.medianEndingWealthDelta;
  const tax = input.impact.annualFederalTaxDelta;
  const funded = input.impact.yearsFundedDelta;
  const downside = input.impact.downsideRiskDelta;
  const downsideScore =
    Math.max(0, -downside.earlyFailureProbabilityDelta) * 18 +
    Math.max(0, -downside.spendingCutRateDelta) * 8 +
    Math.max(0, -downside.equitySalesInAdverseEarlyYearsRateDelta) * 8 +
    Math.max(0, downside.worstDecileEndingWealthDelta) / 120_000 +
    Math.max(0, -downside.medianFailureShortfallDollarsDelta) / 120_000 +
    Math.max(0, -downside.medianDownsideSpendingCutRequiredDelta) * 8;

  if (input.objective === 'minimize_failure_risk') {
    return (
      successPts * 0.11 +
      funded * 0.35 +
      spend / 700 +
      downsideScore * 0.7 +
      legacy / 800_000 -
      Math.max(0, tax) / 25_000
    );
  }
  if (input.objective === 'preserve_legacy') {
    return (
      legacy / 250_000 +
      successPts * 0.06 +
      spend / 2_000 -
      Math.max(0, tax) / 20_000
    );
  }
  if (input.objective === 'maximize_time_weighted_spending') {
    return (
      spend / 180 +
      successPts * 0.05 +
      funded * 0.08 -
      Math.max(0, -legacy) / 500_000 -
      Math.max(0, tax) / 40_000 +
      downsideScore * 0.22
    );
  }
  return (
    spend / 220 +
    successPts * 0.045 +
    funded * 0.06 -
    Math.max(0, -legacy) / 450_000 -
    Math.max(0, tax) / 40_000 +
    downsideScore * 0.18
  );
}

function bindingAlignmentBonus(input: {
  category: RecommendationCategory;
  evaluation: PlanEvaluation;
  impact: StrategicPrepImpactEstimate | null;
}) {
  const binding = input.evaluation.calibration.bindingConstraint.toLowerCase();
  let bonus = 0;
  if (binding.includes('success') && (input.impact?.successRateDelta ?? 0) > 0) {
    bonus += 0.45;
  }
  if (binding.includes('legacy') && (input.impact?.medianEndingWealthDelta ?? 0) > 0) {
    bonus += 0.45;
  }
  if ((binding.includes('irmaa') && input.category === 'irmaa') || (binding.includes('aca') && input.category === 'aca')) {
    bonus += 0.4;
  }
  if (binding.includes('spending') && input.category === 'spending') {
    bonus += 0.3;
  }
  return bonus;
}

function netBenefitScore(input: {
  candidate: StrategicPrepCandidate;
  recommendation: StrategicPrepRecommendation;
  evaluation: PlanEvaluation;
}) {
  const category = classifyRecommendationCategory(input.candidate);
  const objectiveScore = objectiveAlignedScore({
    objective: input.evaluation.summary.activeOptimizationObjective,
    impact: input.recommendation.estimatedImpact,
  });
  const alignmentBonus = bindingAlignmentBonus({
    category,
    evaluation: input.evaluation,
    impact: input.recommendation.estimatedImpact,
  });
  const confidenceScore = input.recommendation.confidence.score;
  const score =
    objectiveScore + alignmentBonus + priorityBoost(input.recommendation.priority) + confidenceScore * 0.35;
  return {
    category,
    score: Number(score.toFixed(3)),
  };
}

function rankAndFilterDistinctRecommendations(input: {
  evaluation: PlanEvaluation;
  evaluatedCandidates: EvaluatedCandidateResult[];
  candidateById: Map<string, StrategicPrepCandidate>;
  maxRecommendations: number;
}): RankedDistinctRecommendationsResult {
  const scored = input.evaluatedCandidates
    .map((evaluated) => {
      const candidate = input.candidateById.get(evaluated.recommendation.id);
      if (!candidate) {
        return null;
      }
      const rank = netBenefitScore({
        candidate,
        recommendation: evaluated.recommendation,
        evaluation: input.evaluation,
      });
      return {
        candidate,
        recommendation: {
          ...evaluated.recommendation,
          evidence: {
            ...evaluated.recommendation.evidence,
            notes: [
              ...evaluated.recommendation.evidence.notes,
              `Ranking: netBenefit=${rank.score.toFixed(3)} category=${rank.category} objective=${input.evaluation.summary.activeOptimizationObjective}.`,
            ],
          },
        } satisfies StrategicPrepRecommendation,
        category: rank.category,
        score: rank.score,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((left, right) => right.score - left.score);

  const usedCategories = new Set<RecommendationCategory>();
  const distinct: StrategicPrepRecommendation[] = [];
  const rankingFiltered: FlightPathPolicyFilterReason[] = [];
  const rankedCandidates: FlightPathPolicyRankedCandidate[] = [];
  for (const item of scored) {
    rankedCandidates.push({
      recommendationId: item.recommendation.id,
      category: item.category,
      score: item.score,
    });

    if (usedCategories.has(item.category)) {
      rankingFiltered.push({
        recommendationId: item.recommendation.id,
        reason: `Filtered out to keep one recommendation per category (${item.category}).`,
      });
      continue;
    }
    if (distinct.length >= input.maxRecommendations) {
      rankingFiltered.push({
        recommendationId: item.recommendation.id,
        reason: `Filtered out by max recommendation cap (${input.maxRecommendations}).`,
      });
      continue;
    }
    usedCategories.add(item.category);
    distinct.push(item.recommendation);
  }

  return {
    recommendations: distinct,
    rankedCandidates,
    rankingFiltered,
  };
}

export function buildFlightPathStrategicPrepRecommendations(
  input: FlightPathPolicyInput,
): FlightPathPolicyResult {
  const maxRecommendations = Math.max(
    1,
    Math.round(input.maxRecommendations ?? DEFAULT_MAX_RECOMMENDATIONS),
  );
  const candidates = buildStrategicPrepCandidates(input);
  const skippedWithoutCounterfactual: FlightPathPolicyFilterReason[] = candidates
    .filter((candidate) => !candidate.counterfactualPatch)
    .map((candidate) => ({
      recommendationId: candidate.id,
      reason:
        'Skipped before evaluation: deterministic counterfactual patch is missing, so evidence requirements cannot be satisfied.',
    }));
  const candidatesWithCounterfactual = candidates.filter((candidate) =>
    Boolean(candidate.counterfactualPatch),
  );

  if (!candidates.length || !input.evaluation) {
    const skippedBeforeEvaluation = input.evaluation
      ? skippedWithoutCounterfactual
      : candidates.map((candidate) => ({
          recommendationId: candidate.id,
          reason:
            'Skipped before evaluation: unified plan context is unavailable, so deterministic counterfactual evidence cannot be generated.',
        }));
    return {
      policyVersion: FLIGHT_PATH_POLICY_VERSION,
      recommendations: [],
      diagnostics: {
        policyVersion: FLIGHT_PATH_POLICY_VERSION,
        thresholdProfileVersion: FLIGHT_PATH_THRESHOLD_PROFILE_VERSION,
        thresholdProfileReviewDate: FLIGHT_PATH_THRESHOLD_PROFILE_REVIEW_DATE,
        activeOptimizationObjective: input.evaluation?.summary.activeOptimizationObjective ?? null,
        counterfactualSimulationRuns: null,
        counterfactualSimulationSeed: null,
        candidatesConsidered: candidates.length,
        candidatesEvaluated: 0,
        skippedBeforeEvaluation,
        hardConstraintFiltered: [],
        evidenceFiltered: [],
        acceptedAfterHardConstraints: 0,
        acceptedAfterEvidenceGate: 0,
        rankedCandidates: [],
        rankingFiltered: [],
        acceptedRecommendationIds: [],
        candidateDecisionTrace: candidates.map((candidate) => ({
          recommendationId: candidate.id,
          evaluated: false,
          patchScaleUsed: null,
          hardConstraintReason: null,
          evidenceGateReason: null,
          acceptedAfterEvidenceGate: false,
          returned: false,
          estimatedImpact: null,
        })),
        impactDeltaSummaryAcceptedCandidates: buildImpactDeltaSummary([]),
        impactDeltaSummaryReturnedRecommendations: buildImpactDeltaSummary([]),
      },
    };
  }
  const evaluation = input.evaluation;
  const modelCompleteness = assessModelCompleteness(input);

  const counterfactualAssumptions = resolveCounterfactualAssumptions(
    input.assumptions,
    input.counterfactualSimulationRuns,
  );
  const baselinePath = runSeededPath({
    data: input.data,
    assumptions: counterfactualAssumptions,
    selectedStressors: input.selectedStressors,
    selectedResponses: input.selectedResponses,
  });

  const sensitivityScenarios = resolveSensitivityScenarios(
    counterfactualAssumptions,
    counterfactualAssumptions.simulationRuns,
    input.selectedStressors,
    input.selectedResponses,
  );
  const baselineScenarioPaths = new Map<string, PathResult>();
  for (const scenario of sensitivityScenarios) {
    baselineScenarioPaths.set(
      scenario.name,
      runSeededPath({
        data: input.data,
        assumptions: scenario.assumptions,
        selectedStressors: scenario.stressors,
        selectedResponses: scenario.responses,
      }),
    );
  }

  const evaluatedCandidates = candidatesWithCounterfactual.map((candidate) => {
    const evaluatedResult = evaluateCandidateCounterfactualWithAdaptiveScaling({
      candidate,
      baselinePath,
      data: input.data,
      assumptions: counterfactualAssumptions,
      selectedStressors: input.selectedStressors,
      selectedResponses: input.selectedResponses,
      evaluation,
      baselineScenarioPaths,
    });
    const evaluated = evaluatedResult.evaluated;
    const patchScaleUsed = evaluatedResult.patchScaleUsed;
    const scalingNote =
      candidate.counterfactualPatch && patchScaleUsed < 1
        ? [
            `Counterfactual patch auto-scaled to ${(patchScaleUsed * 100).toFixed(
              0,
            )}% strength to preserve hard-guardrail feasibility where possible.`,
          ]
        : [];
    const recommendation = {
      id: candidate.id,
      priority: candidate.priority,
      title: candidate.title,
      action: candidate.action,
      triggerReason: candidate.triggerReason,
      estimatedImpact: evaluated.estimatedImpact,
      tradeoffs: candidate.tradeoffs,
      confidence: scoreConfidenceFromSignals({
        impact: evaluated.estimatedImpact,
        hasCounterfactual: Boolean(candidate.counterfactualPatch),
        stability: evaluated.stability,
        modelCompleteness,
      }),
      sensitivityConsistency: {
        score: evaluated.stability.score,
        consistentScenarioCount: evaluated.stability.consistentScenarioCount,
        totalScenarioCount: evaluated.stability.totalScenarioCount,
        rationale: evaluated.stability.rationale,
      },
      evidence: {
        ...evaluated.evidence,
        notes: [
          ...evaluated.evidence.notes,
          ...scalingNote,
          `Model completeness: ${modelCompleteness.indicator}. ${modelCompleteness.rationale}`,
        ],
      },
      amountHint: candidate.amountHint,
      policyFlags: candidate.policyFlags,
    } satisfies StrategicPrepRecommendation;

    return {
      recommendation,
      patchedDataUsed: evaluated.patchedDataUsed,
      patchScaleUsed,
    } satisfies EvaluatedCandidateResult;
  });

  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const hardConstraintFiltered: FlightPathPolicyFilterReason[] = [];
  const evidenceFiltered: FlightPathPolicyFilterReason[] = [];
  const acceptedEvaluatedCandidates = evaluatedCandidates.filter((evaluated) => {
    const candidate = candidateById.get(evaluated.recommendation.id);
    if (!candidate) {
      hardConstraintFiltered.push({
        recommendationId: evaluated.recommendation.id,
        reason: 'Candidate metadata missing during evaluation.',
      });
      return false;
    }
    const reason = detectHardConstraintViolation({
      candidate,
      evaluation,
      patchedDataUsed: evaluated.patchedDataUsed,
      estimatedImpact: evaluated.recommendation.estimatedImpact,
      evidence: evaluated.recommendation.evidence,
    });
    if (reason) {
      hardConstraintFiltered.push({
        recommendationId: evaluated.recommendation.id,
        reason,
      });
      return false;
    }
    return true;
  });
  const evidenceAcceptedCandidates = acceptedEvaluatedCandidates.filter((evaluated) => {
    const reason = detectEvidenceGateViolation({
      recommendation: evaluated.recommendation,
    });
    if (reason) {
      evidenceFiltered.push({
        recommendationId: evaluated.recommendation.id,
        reason,
      });
      return false;
    }
    return true;
  });

  const rankedDistinct = rankAndFilterDistinctRecommendations({
    evaluation,
    evaluatedCandidates: evidenceAcceptedCandidates,
    candidateById,
    maxRecommendations,
  });
  const acceptedRecommendationIds = rankedDistinct.recommendations.map(
    (recommendation) => recommendation.id,
  );
  const acceptedRecommendationsPreRank = evidenceAcceptedCandidates.map(
    (item) => item.recommendation,
  );
  const hardConstraintReasonById = new Map(
    hardConstraintFiltered.map((item) => [item.recommendationId, item.reason]),
  );
  const evidenceGateReasonById = new Map(
    evidenceFiltered.map((item) => [item.recommendationId, item.reason]),
  );
  const acceptedAfterEvidenceGateIds = new Set(
    evidenceAcceptedCandidates.map((item) => item.recommendation.id),
  );
  const returnedRecommendationIds = new Set(acceptedRecommendationIds);
  const evaluatedDecisionTrace = evaluatedCandidates.map((evaluated) => ({
    recommendationId: evaluated.recommendation.id,
    evaluated: true,
    patchScaleUsed: evaluated.patchScaleUsed,
    hardConstraintReason: hardConstraintReasonById.get(evaluated.recommendation.id) ?? null,
    evidenceGateReason: evidenceGateReasonById.get(evaluated.recommendation.id) ?? null,
    acceptedAfterEvidenceGate: acceptedAfterEvidenceGateIds.has(evaluated.recommendation.id),
    returned: returnedRecommendationIds.has(evaluated.recommendation.id),
    estimatedImpact: evaluated.recommendation.estimatedImpact
      ? {
          successRateDelta: evaluated.recommendation.estimatedImpact.successRateDelta,
          supportedMonthlyDelta: evaluated.recommendation.estimatedImpact.supportedMonthlyDelta,
          yearsFundedDelta: evaluated.recommendation.estimatedImpact.yearsFundedDelta,
          medianEndingWealthDelta: evaluated.recommendation.estimatedImpact.medianEndingWealthDelta,
          annualFederalTaxDelta: evaluated.recommendation.estimatedImpact.annualFederalTaxDelta,
          magiDelta: evaluated.recommendation.estimatedImpact.magiDelta,
        }
      : null,
  }));
  const skippedDecisionTrace = skippedWithoutCounterfactual.map((item) => ({
    recommendationId: item.recommendationId,
    evaluated: false,
    patchScaleUsed: null,
    hardConstraintReason: item.reason,
    evidenceGateReason: null,
    acceptedAfterEvidenceGate: false,
    returned: false,
    estimatedImpact: null,
  }));
  const candidateDecisionTrace = [...evaluatedDecisionTrace, ...skippedDecisionTrace];

  return {
    policyVersion: FLIGHT_PATH_POLICY_VERSION,
    recommendations: rankedDistinct.recommendations,
    diagnostics: {
      policyVersion: FLIGHT_PATH_POLICY_VERSION,
      thresholdProfileVersion: FLIGHT_PATH_THRESHOLD_PROFILE_VERSION,
      thresholdProfileReviewDate: FLIGHT_PATH_THRESHOLD_PROFILE_REVIEW_DATE,
      activeOptimizationObjective: evaluation.summary.activeOptimizationObjective,
      counterfactualSimulationRuns: counterfactualAssumptions.simulationRuns,
      counterfactualSimulationSeed: counterfactualAssumptions.simulationSeed ?? 20260416,
      candidatesConsidered: candidates.length,
      candidatesEvaluated: evaluatedCandidates.length,
      skippedBeforeEvaluation: skippedWithoutCounterfactual,
      hardConstraintFiltered,
      evidenceFiltered,
      acceptedAfterHardConstraints: acceptedEvaluatedCandidates.length,
      acceptedAfterEvidenceGate: evidenceAcceptedCandidates.length,
      rankedCandidates: rankedDistinct.rankedCandidates,
      rankingFiltered: rankedDistinct.rankingFiltered,
      acceptedRecommendationIds,
      candidateDecisionTrace,
      impactDeltaSummaryAcceptedCandidates: buildImpactDeltaSummary(acceptedRecommendationsPreRank),
      impactDeltaSummaryReturnedRecommendations: buildImpactDeltaSummary(
        rankedDistinct.recommendations,
      ),
    },
  };
}
