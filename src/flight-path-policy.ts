import type { PlanEvaluation } from './plan-evaluation';
import type { OptimizationObjective } from './optimization-objective';
import type { MarketAssumptions, PathResult, SeedData } from './types';
import { buildPathResults, formatCurrency } from './utils';

export const FLIGHT_PATH_POLICY_VERSION = 'v0.4.0';

export type StrategicPrepPriority = 'now' | 'soon' | 'watch';
export type StrategicPrepConfidenceLabel = 'low' | 'medium' | 'high';

export interface StrategicPrepImpactEstimate {
  modeledBy: 'seeded_path_counterfactual' | 'heuristic_only';
  supportedMonthlyDelta: number;
  successRateDelta: number;
  medianEndingWealthDelta: number;
  annualFederalTaxDelta: number;
  yearsFundedDelta: number;
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
  } | null;
  counterfactual: {
    successRate: number;
    medianEndingWealth: number;
    annualFederalTaxEstimate: number;
    supportedMonthlySpendApprox: number;
    yearsFunded: number;
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
  evidence: StrategicPrepEvidence;
  amountHint?: string;
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
}

interface CounterfactualPatch {
  optionalMonthlyDelta?: number;
  travelAnnualDelta?: number;
  transferToCashFromTaxable?: number;
  transferFromCashToTaxable?: number;
}

interface EvaluatedCandidateResult {
  recommendation: StrategicPrepRecommendation;
  patchedDataUsed: SeedData | null;
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
  activeOptimizationObjective: OptimizationObjective | null;
  counterfactualSimulationRuns: number | null;
  counterfactualSimulationSeed: number | null;
  candidatesConsidered: number;
  candidatesEvaluated: number;
  hardConstraintFiltered: FlightPathPolicyFilterReason[];
  acceptedAfterHardConstraints: number;
  rankedCandidates: FlightPathPolicyRankedCandidate[];
  rankingFiltered: FlightPathPolicyFilterReason[];
  acceptedRecommendationIds: string[];
  impactDeltaSummaryAcceptedCandidates: FlightPathPolicyImpactDeltaSummary;
  impactDeltaSummaryReturnedRecommendations: FlightPathPolicyImpactDeltaSummary;
}

const DEFAULT_MAX_RECOMMENDATIONS = 6;
const DEFAULT_COUNTERFACTUAL_SIMULATION_RUNS = 72;
const DEFAULT_SENSITIVITY_SIMULATION_RUNS = 36;

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
  return JSON.parse(JSON.stringify(data)) as SeedData;
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

function toPathSnapshot(path: PathResult) {
  return {
    successRate: path.successRate,
    medianEndingWealth: path.medianEndingWealth,
    annualFederalTaxEstimate: path.annualFederalTaxEstimate,
    supportedMonthlySpendApprox: firstYearSupportedMonthly(path),
    yearsFunded: path.yearsFunded,
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

  return next;
}

function estimateImpactFromPaths(
  baseline: PathResult,
  counterfactual: PathResult,
): StrategicPrepImpactEstimate {
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
  };
}

function scoreEffectSignal(impact: StrategicPrepImpactEstimate | null) {
  if (!impact) {
    return 0;
  }
  const successSignal = Math.min(1, Math.abs(impact.successRateDelta) / 0.03);
  const spendSignal = Math.min(1, Math.abs(impact.supportedMonthlyDelta) / 400);
  const fundedSignal = Math.min(1, Math.abs(impact.yearsFundedDelta) / 2);
  return Number((0.45 * successSignal + 0.4 * spendSignal + 0.15 * fundedSignal).toFixed(2));
}

function resolveSensitivityAssumptions(
  assumptions: MarketAssumptions,
  baseRuns: number,
) {
  const sensitivityRuns = Math.max(
    24,
    Math.min(baseRuns, DEFAULT_SENSITIVITY_SIMULATION_RUNS),
  );
  return [
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
    },
  ];
}

function assessSensitivityStability(input: {
  baseImpact: StrategicPrepImpactEstimate | null;
  hasCounterfactual: boolean;
  baselineData: SeedData;
  counterfactualData: SeedData | null;
  assumptions: MarketAssumptions;
  selectedStressors: string[];
  selectedResponses: string[];
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
    Math.abs(input.baseImpact.supportedMonthlyDelta) >= 25
      ? input.baseImpact.supportedMonthlyDelta
      : input.baseImpact.successRateDelta * 100;
  const baseDirection = signWithTolerance(basePrimary, 0.05);

  const scenarios = resolveSensitivityAssumptions(
    input.assumptions,
    input.assumptions.simulationRuns,
  );
  const scenarioResults: SensitivityScenarioResult[] = scenarios.map((scenario) => {
    const baselinePath = runSeededPath({
      data: input.baselineData,
      assumptions: scenario.assumptions,
      selectedStressors: input.selectedStressors,
      selectedResponses: input.selectedResponses,
    });
    const counterfactualPath = runSeededPath({
      data: input.counterfactualData as SeedData,
      assumptions: scenario.assumptions,
      selectedStressors: input.selectedStressors,
      selectedResponses: input.selectedResponses,
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
      Math.abs(scenario.supportedMonthlyDelta) >= 25
        ? scenario.supportedMonthlyDelta
        : scenario.successRateDelta * 100;
    const direction = signWithTolerance(primary, 0.05);
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

  if (score >= 0.72) {
    return {
      label: 'high',
      score,
      rationale: `Strong effect, stable across sensitivities (${input.stability.rationale}), and ${input.modelCompleteness.indicator} model inputs.`,
    };
  }
  if (score >= 0.45) {
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
    if (spendGapMonthly > 150) {
      const monthlyTrim = Math.min(spendGapMonthly, input.data.spending.optionalMonthly);
      candidates.push({
        id: 'spend-gap-reduce',
        priority: 'now',
        title: 'Align spending to supported level',
        action: `Trim monthly spending by about ${formatCurrency(spendGapMonthly)} to match today's supported level.`,
        triggerReason:
          'Target spending currently exceeds modeled supported spending at the active guardrail settings.',
        amountHint: `${formatCurrency(spendGapMonthly)} per month reduction`,
        tradeoffs: [
          'Immediate lifestyle flexibility may decrease in discretionary categories.',
          'Can improve guardrail headroom in downside paths.',
        ],
        counterfactualPatch: {
          optionalMonthlyDelta: -monthlyTrim,
        },
      });
    } else if (spendGapMonthly < -150) {
      const room = Math.abs(spendGapMonthly);
      candidates.push({
        id: 'spend-gap-room',
        priority: 'watch',
        title: 'You have near-term spending room',
        action: `You can increase monthly spending by up to about ${formatCurrency(room)} and stay inside the current supported path.`,
        triggerReason:
          'Current supported spending exceeds your stated target by a meaningful margin.',
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
  const recommendedCashBuffer = essentialMonthlyWithFixed * 18;
  if (currentCash < recommendedCashBuffer * 0.9) {
    const transferNeeded = recommendedCashBuffer - currentCash;
    candidates.push({
      id: 'cash-buffer-top-up',
      priority: 'now',
      title: 'Top up cash buffer runway',
      action: `Move about ${formatCurrency(transferNeeded)} into cash to reach an 18-month essential runway.`,
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
  } else if (currentCash > recommendedCashBuffer * 1.6) {
    const excessCash = currentCash - recommendedCashBuffer;
    candidates.push({
      id: 'cash-buffer-redeploy',
      priority: 'watch',
      title: 'Excess cash drag check',
      action: `Consider redeploying around ${formatCurrency(excessCash)} from cash to your intended allocation.`,
      triggerReason:
        'Cash reserves are materially above near-term runway needs and may be creating return drag.',
      amountHint: `Cash above 18-month buffer: ${formatCurrency(excessCash)}`,
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
      (typeof year.irmaaHeadroom === 'number' && year.irmaaHeadroom < 10_000)
    );
  });
  if (irmaaPressureYear) {
    const headroom = irmaaPressureYear.irmaaHeadroom ?? 0;
    const reductionNeeded = headroom < 0 ? Math.abs(headroom) : Math.max(0, 10_000 - headroom);
    const targetMagiCap = Math.max(0, irmaaPressureYear.estimatedMAGI - reductionNeeded);
    candidates.push({
      id: 'irmaa-cap',
      priority: headroom <= 2_500 ? 'now' : 'soon',
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
    .filter((value) => value > 1_000);
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
    if (dominant && totalWithdrawals > 0 && dominant.value / totalWithdrawals >= 0.6) {
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
    });
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
  evaluated: EvaluatedCandidateResult;
  evaluation: PlanEvaluation;
}): string | null {
  const { candidate, evaluated, evaluation } = input;

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

  const patchedData = evaluated.patchedDataUsed;
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

  const counterfactual = evaluated.recommendation.evidence.counterfactual;
  if (counterfactual) {
    if (counterfactual.successRate + 1e-9 < evaluation.calibration.minimumSuccessRateTarget) {
      return 'Blocked by hard guardrail: counterfactual falls below minimum success floor.';
    }

    const legacyDelta = evaluated.recommendation.estimatedImpact?.medianEndingWealthDelta ?? 0;
    const projectedLegacyTodayApprox =
      evaluation.calibration.projectedLegacyTodayDollars + legacyDelta;
    if (projectedLegacyTodayApprox + 1 < evaluation.calibration.legacyFloorTodayDollars) {
      return 'Blocked by hard guardrail: projected legacy falls below legacy floor.';
    }

    const baselineInOrAboveBand =
      evaluation.calibration.projectedLegacyTodayDollars >=
      evaluation.calibration.legacyTargetBandLowerTodayDollars;
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

  if (input.objective === 'minimize_failure_risk') {
    return (
      successPts * 0.11 +
      funded * 0.35 +
      spend / 700 +
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
      Math.max(0, tax) / 40_000
    );
  }
  return (
    spend / 220 +
    successPts * 0.045 +
    funded * 0.06 -
    Math.max(0, -legacy) / 450_000 -
    Math.max(0, tax) / 40_000
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

  if (!candidates.length || !input.evaluation) {
    return {
      policyVersion: FLIGHT_PATH_POLICY_VERSION,
      recommendations: [],
      diagnostics: {
        policyVersion: FLIGHT_PATH_POLICY_VERSION,
        activeOptimizationObjective: input.evaluation?.summary.activeOptimizationObjective ?? null,
        counterfactualSimulationRuns: null,
        counterfactualSimulationSeed: null,
        candidatesConsidered: candidates.length,
        candidatesEvaluated: 0,
        hardConstraintFiltered: [],
        acceptedAfterHardConstraints: 0,
        rankedCandidates: [],
        rankingFiltered: [],
        acceptedRecommendationIds: [],
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

  const evaluatedCandidates = candidates.map((candidate) => {
    const evaluated = evaluateCandidateCounterfactual({
      candidate,
      baselinePath,
      data: input.data,
      assumptions: counterfactualAssumptions,
      selectedStressors: input.selectedStressors,
      selectedResponses: input.selectedResponses,
    });
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
      evidence: {
        ...evaluated.evidence,
        notes: [
          ...evaluated.evidence.notes,
          `Model completeness: ${modelCompleteness.indicator}. ${modelCompleteness.rationale}`,
        ],
      },
      amountHint: candidate.amountHint,
    } satisfies StrategicPrepRecommendation;

    return {
      recommendation,
      patchedDataUsed: evaluated.patchedDataUsed,
    } satisfies EvaluatedCandidateResult;
  });

  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const hardConstraintFiltered: FlightPathPolicyFilterReason[] = [];
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
      evaluated,
      evaluation,
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

  const rankedDistinct = rankAndFilterDistinctRecommendations({
    evaluation,
    evaluatedCandidates: acceptedEvaluatedCandidates,
    candidateById,
    maxRecommendations,
  });
  const acceptedRecommendationIds = rankedDistinct.recommendations.map(
    (recommendation) => recommendation.id,
  );
  const acceptedRecommendationsPreRank = acceptedEvaluatedCandidates.map(
    (item) => item.recommendation,
  );

  return {
    policyVersion: FLIGHT_PATH_POLICY_VERSION,
    recommendations: rankedDistinct.recommendations,
    diagnostics: {
      policyVersion: FLIGHT_PATH_POLICY_VERSION,
      activeOptimizationObjective: evaluation.summary.activeOptimizationObjective,
      counterfactualSimulationRuns: counterfactualAssumptions.simulationRuns,
      counterfactualSimulationSeed: counterfactualAssumptions.simulationSeed ?? 20260416,
      candidatesConsidered: candidates.length,
      candidatesEvaluated: evaluatedCandidates.length,
      hardConstraintFiltered,
      acceptedAfterHardConstraints: acceptedEvaluatedCandidates.length,
      rankedCandidates: rankedDistinct.rankedCandidates,
      rankingFiltered: rankedDistinct.rankingFiltered,
      acceptedRecommendationIds,
      impactDeltaSummaryAcceptedCandidates: buildImpactDeltaSummary(acceptedRecommendationsPreRank),
      impactDeltaSummaryReturnedRecommendations: buildImpactDeltaSummary(
        rankedDistinct.recommendations,
      ),
    },
  };
}
