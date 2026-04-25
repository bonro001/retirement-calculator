import type { AutopilotPlanResult } from './autopilot-timeline';
import type { DecisionEngineReport, LeverScenarioResult } from './decision-engine';
import { perfStart } from './debug-perf';
import type {
  OptimizationObjective,
  TimePreferenceWeights,
} from './optimization-objective';
import {
  analyzeRetirementPlan,
  buildRetirementPlan,
  type DecisionImpactAssessment,
  type PlanDecisionInput,
  type IrmaaPosture,
  type RuntimeDiagnosticsMode,
  type RetirementPlanRunResult,
} from './retirement-plan';
import type { SpendSolverResult, SpendSolverSuccessRange } from './spend-solver';
import type { MarketAssumptions, PathResult, SeedData } from './types';

export type LegacyPriority = 'off' | 'nice_to_have' | 'important' | 'must_preserve';
export type TimePreferenceValue = 'high' | 'medium' | 'low';
export type SuccessFloorMode = 'conservative' | 'balanced' | 'aggressive' | 'custom';

export const SUCCESS_FLOOR_MODE_TARGETS: Record<
  Exclude<SuccessFloorMode, 'custom'>,
  number
> = {
  conservative: 0.95,
  balanced: 0.92,
  aggressive: 0.85,
};

export interface TimePreferenceProfile {
  ages60to69: TimePreferenceValue;
  ages70to79: TimePreferenceValue;
  ages80plus: TimePreferenceValue;
}

export interface PlanControls {
  selectedStressorIds: string[];
  selectedResponseIds: string[];
  toggles?: {
    preserveRoth?: boolean;
    increaseCashBuffer?: boolean;
    avoidRetirementDelayRecommendations?: boolean;
    avoidHomeSaleRecommendations?: boolean;
  };
}

export interface PlanPreferences {
  irmaaPosture?: IrmaaPosture;
  preserveLifestyleFloor?: boolean;
  timePreference?: Partial<TimePreferenceProfile>;
  calibration?: {
    targetLegacyTodayDollars?: number;
    legacyPriority?: LegacyPriority;
    successFloorMode?: SuccessFloorMode;
    minSuccessRate?: number;
    successRateRange?: SpendSolverSuccessRange;
    optimizationObjective?: OptimizationObjective;
    timePreferenceWeights?: TimePreferenceWeights;
  };
  responsePolicy?: {
    posture?: 'defensive' | 'balanced';
    optionalSpendingCutsAllowed?: boolean;
    optionalSpendingFlexPercent?: number;
    travelFlexPercent?: number;
    preserveRothPreference?: boolean;
  };
  decisionImpact?: PlanDecisionInput;
  runtime?: {
    timeoutMs?: number;
    finalEvaluationSimulationRuns?: number;
    solverSearchSimulationRuns?: number;
    solverFinalSimulationRuns?: number;
    solverMaxIterations?: number;
    solverDiagnosticsMode?: RuntimeDiagnosticsMode;
    solverEnableSuccessRelaxationProbe?: boolean;
    decisionSimulationRuns?: number;
    decisionScenarioEvaluationLimit?: number;
    decisionEvaluateExcludedScenarios?: boolean;
    stressTestComplexity?: 'full' | 'reduced';
  };
}

export interface Plan {
  data: SeedData;
  assumptions: MarketAssumptions;
  controls: PlanControls;
  preferences?: PlanPreferences;
}

export interface PlanRecommendation {
  scenarioId: string;
  name: string;
  summary: string;
  deltaSuccessRate: number;
  isPlanControl: boolean;
}

export interface PlanChangeSummary {
  successRateDelta: number;
  topRecommendationChanged: boolean;
  topRecommendationMessage: string;
  biggestDriverChanged: boolean;
  biggestDriverMessage: string;
}

export type TrustCheckStatus = 'pass' | 'warn' | 'fail';

export interface PlanTrustCheck {
  id: string;
  title: string;
  status: TrustCheckStatus;
  detail: string;
}

export interface PlanTrustPanel {
  version: 'decision_trust_v1';
  safeToRely: boolean;
  confidence: 'high' | 'medium' | 'low';
  summary: string;
  checks: PlanTrustCheck[];
  metrics: {
    passCount: number;
    warnCount: number;
    failCount: number;
    recommendationEvidenceCoverage: number;
    inheritanceDependenceRate: number;
    homeSaleDependenceRate: number;
  };
}

export interface PlanEvaluation {
  summary: {
    planSupportsAnnual: number;
    planSupportsMonthly: number;
    successRate: number;
    planVerdict: 'Fragile' | 'Moderate' | 'Strong';
    biggestDriver: string;
    biggestRisk: string;
    bestAction: string;
    activeOptimizationObjective: OptimizationObjective;
    irmaaOutlook: string;
    legacyOutlook: string;
    /**
     * Approximate P(ending wealth >= North Star), interpolated from the
     * solver's five today-dollar percentiles. Distinct from `successRate`,
     * which only measures P(didn't run out of money). The two differ when
     * the plan is solvent but the bequest target is above $0 — a 90%
     * solvent plan can have a 60% bequest-attainment rate, and the gap is
     * what the user needs to see to decide whether to spend more, gift
     * more, or convert more pretax to Roth.
     *
     * `null` when the legacy goal is off, or when the solver hasn't
     * produced percentile data yet.
     */
    bequestAttainmentRate: number | null;
  };
  calibration: {
    userTargetMonthlySpendNow: number;
    userTargetAnnualSpendNow: number;
    supportedMonthlySpendNow: number;
    supportedAnnualSpendNow: number;
    supportedSpend60s: number;
    supportedSpend70s: number;
    supportedSpend80Plus: number;
    spendGapNowMonthly: number;
    spendGapNowAnnual: number;
    flexibleSpendingMinimum: number;
    overReservedAmount: number;
    supportedAnnualSpend: number;
    supportedMonthlySpend: number;
    safeBandAnnual: {
      lower: number;
      target: number;
      upper: number;
    };
    targetLegacyTodayDollars: number;
    effectiveLegacyTargetTodayDollars: number;
    legacyFloorTodayDollars: number;
    legacyTargetBandLowerTodayDollars: number;
    legacyTargetBandUpperTodayDollars: number;
    legacyWithinTargetBand: boolean;
    legacyPriority: LegacyPriority;
    successFloorMode: SuccessFloorMode;
    minimumSuccessRateTarget: number;
    achievedSuccessRate: number;
    successConstraintBinding: boolean;
    supportedSpendAtCurrentSuccessFloor: number;
    supportedSpendIfSuccessFloorRelaxed: number;
    successFloorRelaxationTarget: number | null;
    successFloorRelaxationDeltaAnnual: number;
    successFloorRelaxationDeltaMonthly: number;
    nextUnlockImpactMonthly: number;
    successFloorNextUnlock: string | null;
    successFloorRelaxationTradeoff: string | null;
    nextUnlock: string | null;
    supportedSpendingSchedule: Array<{
      year: number;
      age: number;
      annualSpend: number;
      monthlySpend: number;
    }>;
    projectedLegacyTodayDollars: number;
    // Bequest distribution in today's dollars. The single
    // `projectedLegacyTodayDollars` value above is just the median; surfacing
    // percentiles lets the UI show whether the plan over- or under-shoots the
    // North Star and how spread the outcomes are. All values come from the
    // solver, which already deflates the engine's nominal endingWealth
    // percentiles by the planning horizon's inflation drag.
    bequestDistributionTodayDollars: {
      p10: number;
      p25: number;
      p50: number;
      p75: number;
      p90: number;
    };
    endingWealthOneSigmaApproxTodayDollars: number;
    endingWealthOneSigmaLowerTodayDollars: number;
    endingWealthOneSigmaUpperTodayDollars: number;
    distanceFromTarget: number;
    overTargetPenalty: number;
    isTargetBinding: boolean;
    modeledSuccessRate: number;
    bindingGuardrail: string;
    bindingGuardrailExplanation: string;
    bindingConstraint: string;
    primaryTradeoff: string;
    whySupportedSpendIsNotHigher: string;
  };
  responsePolicy: {
    posture: 'defensive' | 'balanced';
    routeSummary: string;
    tradeoffSummary: string;
    primaryBindingConstraint: string;
  };
  timePreference: {
    profile: TimePreferenceProfile;
    assessment: 'early_spending_room' | 'balanced_path' | 'protective_posture';
    overConservingLateLife: boolean;
    earlySpendingCanIncreaseSafely: boolean;
    estimatedSafeEarlyAnnualShift: number;
    explanation: string;
    recommendation: string;
    indicators: {
      successBuffer: number;
      legacyBuffer: number;
      earlyFailureRate: number;
      preSocialSecurityFailureRate: number;
      p10EndingWealth: number;
      p50EndingWealth: number;
    };
  };
  irmaa: {
    posture: IrmaaPosture;
    exposureLevel: 'Low' | 'Medium' | 'High';
    likelyYearsAtRisk: number[];
    mainDrivers: string[];
    whatWouldLowerExposure: string[];
    explanation: string;
  };
  recommendations: {
    summary: string;
    top: PlanRecommendation[];
  };
  whatChangedFromLastRun: PlanChangeSummary | null;
  sensitivities: {
    biggestDownside: PlanRecommendation | null;
    worst: PlanRecommendation[];
  };
  excludedOptions: {
    activeFilters: {
      noDelayRetirement: boolean;
      noSellHouse: boolean;
    };
    highImpact: Array<{
      scenario: string;
      deltaSuccessRate: number;
      reason: string;
    }>;
  };
  trustPanel?: PlanTrustPanel;
  decisionImpact: DecisionImpactAssessment | null;
  raw: {
    baselinePath: PathResult;
    spendingCalibration: SpendSolverResult;
    autopilot: AutopilotPlanResult;
    decision: DecisionEngineReport;
    run: RetirementPlanRunResult;
  };
}

export interface EvaluatePlanOptions {
  previousEvaluation?: PlanEvaluation | null;
  onPhaseProgress?: (event: {
    phase: string;
    status: 'start' | 'end';
    durationMs?: number;
    meta?: Record<string, unknown>;
  }) => void;
}

function clampRate(value: number) {
  return Math.max(0, Math.min(1, value));
}

function ensureResponse(selectedResponses: string[], responseId: string, enabled: boolean) {
  if (!enabled) {
    return selectedResponses;
  }
  if (selectedResponses.includes(responseId)) {
    return selectedResponses;
  }
  return [...selectedResponses, responseId];
}

function resolveLegacyPriority(value: LegacyPriority | undefined): LegacyPriority {
  if (!value) {
    return 'important';
  }
  return value;
}

function resolveSuccessFloorMode(input: {
  mode?: SuccessFloorMode;
  minSuccessRate?: number;
}): SuccessFloorMode {
  if (input.mode) {
    return input.mode;
  }
  if (input.minSuccessRate === undefined) {
    return 'balanced';
  }
  const value = clampRate(input.minSuccessRate);
  if (Math.abs(value - SUCCESS_FLOOR_MODE_TARGETS.conservative) < 0.0001) {
    return 'conservative';
  }
  if (Math.abs(value - SUCCESS_FLOOR_MODE_TARGETS.balanced) < 0.0001) {
    return 'balanced';
  }
  if (Math.abs(value - SUCCESS_FLOOR_MODE_TARGETS.aggressive) < 0.0001) {
    return 'aggressive';
  }
  return 'custom';
}

function resolveRequestedMinSuccessRate(input: {
  minSuccessRate?: number;
  successFloorMode: SuccessFloorMode;
}) {
  if (input.minSuccessRate !== undefined) {
    return clampRate(input.minSuccessRate);
  }
  if (input.successFloorMode === 'custom') {
    return SUCCESS_FLOOR_MODE_TARGETS.balanced;
  }
  return SUCCESS_FLOOR_MODE_TARGETS[input.successFloorMode];
}

function formatLegacyPriority(value: LegacyPriority) {
  if (value === 'nice_to_have') {
    return 'Nice to have';
  }
  if (value === 'must_preserve') {
    return 'Must preserve';
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function applyLegacyPriorityToTargets(input: {
  requestedLegacyTargetTodayDollars: number;
  requestedMinSuccessRate: number;
  legacyPriority: LegacyPriority;
}) {
  const { requestedLegacyTargetTodayDollars, requestedMinSuccessRate, legacyPriority } = input;

  if (legacyPriority === 'off') {
    return {
      effectiveLegacyTargetTodayDollars: 0,
      effectiveMinSuccessRate: requestedMinSuccessRate,
    };
  }
  if (legacyPriority === 'nice_to_have') {
    return {
      effectiveLegacyTargetTodayDollars: requestedLegacyTargetTodayDollars * 0.7,
      effectiveMinSuccessRate: requestedMinSuccessRate,
    };
  }
  if (legacyPriority === 'must_preserve') {
    return {
      effectiveLegacyTargetTodayDollars: requestedLegacyTargetTodayDollars * 1.15,
      effectiveMinSuccessRate: requestedMinSuccessRate,
    };
  }

  return {
    effectiveLegacyTargetTodayDollars: requestedLegacyTargetTodayDollars,
    effectiveMinSuccessRate: requestedMinSuccessRate,
  };
}

/**
 * Approximate P(ending wealth >= target) from the five known today-dollar
 * percentiles (P10, P25, P50, P75, P90).
 *
 * The engine doesn't currently expose the full sorted ending-wealth array
 * (it would bloat the cached PathResult by ~10K floats), so we interpolate
 * across the five quantiles we have. By definition, value-at-Pq means q×100%
 * of paths fall below it, so P(X >= value) = 1 - q. Linear interpolation
 * between adjacent knots gives the rate at any in-range target.
 *
 * Outside the [P10, P90] range the rate is *unmeasured* — we only know it's
 * above 0.9 or below 0.1. We clamp at 0.95 / 0.05 to make the bound explicit
 * rather than silently extrapolating into the tails.
 *
 * If precision becomes important (e.g. for solver constraints, not just UI
 * display), plumb the nominal bequest target into the engine and count the
 * exact rate from the ending-wealths array. Until then, this is good enough
 * to surface the gap between "didn't run out" and "hit the bequest target."
 */
export function approximateBequestAttainmentRate(
  targetTodayDollars: number,
  dist: { p10: number; p25: number; p50: number; p75: number; p90: number },
): number {
  if (!Number.isFinite(targetTodayDollars) || targetTodayDollars <= 0) return 1;
  const knots: Array<{ value: number; pAbove: number }> = [
    { value: dist.p10, pAbove: 0.9 },
    { value: dist.p25, pAbove: 0.75 },
    { value: dist.p50, pAbove: 0.5 },
    { value: dist.p75, pAbove: 0.25 },
    { value: dist.p90, pAbove: 0.1 },
  ];
  // Strict inequality on the clamp so that an exact-knot target returns the
  // measured pAbove (0.9 / 0.1) rather than the unmeasured-tail clamp.
  if (targetTodayDollars < knots[0].value) return 0.95;
  if (targetTodayDollars > knots[knots.length - 1].value) return 0.05;
  for (let i = 0; i < knots.length - 1; i += 1) {
    const a = knots[i];
    const b = knots[i + 1];
    if (targetTodayDollars >= a.value && targetTodayDollars <= b.value) {
      const span = b.value - a.value;
      if (span <= 0) return a.pAbove;
      const frac = (targetTodayDollars - a.value) / span;
      return a.pAbove + frac * (b.pAbove - a.pAbove);
    }
  }
  return 0.5;
}

function toLegacyOutlook(input: {
  legacyPriority: LegacyPriority;
  requestedLegacyTargetTodayDollars: number;
  effectiveLegacyTargetTodayDollars: number;
  projectedLegacyTodayDollars: number;
}) {
  const {
    legacyPriority,
    requestedLegacyTargetTodayDollars,
    effectiveLegacyTargetTodayDollars,
    projectedLegacyTodayDollars,
  } = input;

  if (legacyPriority === 'off') {
    return 'Legacy goal is off, so the plan prioritizes current spending resilience.';
  }

  const gap = projectedLegacyTodayDollars - requestedLegacyTargetTodayDollars;
  if (gap >= 0) {
    return `${formatLegacyPriority(legacyPriority)} legacy goal is on track by ${Math.round(gap).toLocaleString()} dollars.`;
  }

  const shortage = Math.abs(gap);
  if (legacyPriority === 'must_preserve') {
    return `Legacy is behind target by ${Math.round(shortage).toLocaleString()} dollars, so preserving estate remains a primary guardrail.`;
  }
  if (effectiveLegacyTargetTodayDollars < requestedLegacyTargetTodayDollars) {
    return `Legacy goal is behind by ${Math.round(shortage).toLocaleString()} dollars; this run treated legacy as flexible.`;
  }
  return `Legacy goal is behind target by ${Math.round(shortage).toLocaleString()} dollars.`;
}

function toLegacyRecommendationNote(input: {
  legacyPriority: LegacyPriority;
  requestedLegacyTargetTodayDollars: number;
  projectedLegacyTodayDollars: number;
}) {
  const { legacyPriority, requestedLegacyTargetTodayDollars, projectedLegacyTodayDollars } = input;
  if (legacyPriority === 'off') {
    return 'Legacy is currently off, so recommendations can lean toward maintaining lifestyle spend.';
  }
  if (projectedLegacyTodayDollars >= requestedLegacyTargetTodayDollars) {
    return 'Legacy target is currently on track, creating room to balance spend flexibility and resilience.';
  }
  if (legacyPriority === 'must_preserve' || legacyPriority === 'important') {
    return 'Legacy target is binding, so recommendations favor preserving estate over higher near-term spending.';
  }
  return 'Legacy is treated as flexible, so recommendations can trade some estate value for current spending stability.';
}

function sanitizeRecommendationText(text: string) {
  return text.replace(/cut essential spending/gi, 'reduce flexible spending');
}

function toPlanRecommendation(scenario: LeverScenarioResult): PlanRecommendation {
  return {
    scenarioId: scenario.scenarioId,
    name: sanitizeRecommendationText(scenario.name),
    summary: sanitizeRecommendationText(scenario.recommendationSummary),
    deltaSuccessRate: scenario.delta.deltaSuccessRate,
    isPlanControl: (scenario.tags ?? []).includes('ui_control'),
  };
}

function toPlanVerdict(successRate: number): 'Fragile' | 'Moderate' | 'Strong' {
  if (successRate >= 0.85) {
    return 'Strong';
  }
  if (successRate >= 0.7) {
    return 'Moderate';
  }
  return 'Fragile';
}

function toWhatChangedFromLastRun(
  previousEvaluation: PlanEvaluation | null | undefined,
  decision: DecisionEngineReport,
): PlanChangeSummary | null {
  if (!previousEvaluation) {
    return null;
  }
  const previousDecision = previousEvaluation.raw.decision;
  const successRateDelta = decision.baseline.successRate - previousDecision.baseline.successRate;

  const previousTop = previousDecision.rankedRecommendations[0]?.name ?? null;
  const currentTop = decision.rankedRecommendations[0]?.name ?? null;
  const topRecommendationChanged = previousTop !== currentTop;

  const previousDriver = previousDecision.biggestDriver?.scenarioName ?? null;
  const currentDriver = decision.biggestDriver?.scenarioName ?? null;
  const biggestDriverChanged = previousDriver !== currentDriver;

  return {
    successRateDelta,
    topRecommendationChanged,
    topRecommendationMessage: topRecommendationChanged
      ? `Top recommendation changed from ${sanitizeRecommendationText(previousTop ?? 'none')} to ${sanitizeRecommendationText(currentTop ?? 'none')}.`
      : 'Top recommendation unchanged.',
    biggestDriverChanged,
    biggestDriverMessage: biggestDriverChanged
      ? `Biggest driver changed from ${sanitizeRecommendationText(previousDriver ?? 'none')} to ${sanitizeRecommendationText(currentDriver ?? 'none')}.`
      : 'Biggest driver unchanged.',
  };
}

function toIrmaaExplanation(
  posture: IrmaaPosture,
  level: 'Low' | 'Medium' | 'High',
  mainDriver: string | undefined,
) {
  return `IRMAA posture is ${posture}. Exposure is ${level.toLowerCase()}${
    mainDriver ? ` because ${mainDriver.toLowerCase()}` : '.'
  }`;
}

function normalizeTimePreferenceProfile(
  value: Partial<TimePreferenceProfile> | undefined,
): TimePreferenceProfile {
  return {
    ages60to69: value?.ages60to69 ?? 'high',
    ages70to79: value?.ages70to79 ?? 'medium',
    ages80plus: value?.ages80plus ?? 'low',
  };
}

function buildTimePreferenceInterpretation(input: {
  profile: TimePreferenceProfile;
  legacyPriority: LegacyPriority;
  minSuccessRate: number;
  successRate: number;
  projectedLegacyTodayDollars: number;
  effectiveLegacyTargetTodayDollars: number;
  safeBandUpperAnnual: number;
  supportedAnnualSpend: number;
  baselineMetrics: DecisionEngineReport['baseline'];
}) {
  const successBuffer = input.successRate - input.minSuccessRate;
  const legacyBuffer =
    input.projectedLegacyTodayDollars - input.effectiveLegacyTargetTodayDollars;
  const baseline = input.baselineMetrics;
  const discretionaryRoom = Math.max(
    0,
    input.safeBandUpperAnnual - input.supportedAnnualSpend,
  );
  const earlySpendingPriority =
    input.profile.ages60to69 === 'high'
      ? 1
      : input.profile.ages60to69 === 'medium'
        ? 0.7
        : 0.45;
  const conservativeLegacyAllowance = Math.max(
    0,
    legacyBuffer * (input.legacyPriority === 'must_preserve' ? 0.03 : 0.06) * earlySpendingPriority,
  );

  const overConservingLateLife =
    successBuffer >= 0.06 &&
    legacyBuffer >= Math.max(150_000, input.effectiveLegacyTargetTodayDollars * 0.15) &&
    baseline.percentFailFirst10Years <= 0.12 &&
    baseline.percentFailBeforeSocialSecurity <= 0.1 &&
    baseline.p10EndingWealth > 0;

  const earlySpendingCanIncreaseSafely =
    overConservingLateLife && (discretionaryRoom > 0 || conservativeLegacyAllowance > 0);

  const preferredShiftCapacity = Math.max(discretionaryRoom, conservativeLegacyAllowance);
  const estimatedSafeEarlyAnnualShift = earlySpendingCanIncreaseSafely
    ? Math.max(
        0,
        Math.min(
          preferredShiftCapacity,
          input.supportedAnnualSpend * 0.12 * earlySpendingPriority,
        ),
      )
    : 0;

  if (earlySpendingCanIncreaseSafely) {
    return {
      assessment: 'early_spending_room' as const,
      overConservingLateLife,
      earlySpendingCanIncreaseSafely,
      estimatedSafeEarlyAnnualShift,
      explanation:
        'Your plan is preserving more for later life than necessary. You can shift spending earlier without materially increasing failure risk.',
      recommendation:
        estimatedSafeEarlyAnnualShift > 0
          ? `Shift about ${Math.round(estimatedSafeEarlyAnnualShift / 12).toLocaleString()} dollars per month into your 60s and 70s while keeping legacy and success guardrails intact.`
          : 'Shift a small amount of spending into your 60s and 70s while preserving legacy and success guardrails.',
    };
  }

  const protectivePosture =
    baseline.percentFailFirst10Years >= 0.25 ||
    baseline.percentFailBeforeSocialSecurity >= 0.2 ||
    successBuffer <= 0.01 ||
    legacyBuffer < 0;

  if (protectivePosture) {
    return {
      assessment: 'protective_posture' as const,
      overConservingLateLife,
      earlySpendingCanIncreaseSafely,
      estimatedSafeEarlyAnnualShift: 0,
      explanation:
        'This plan still needs a protective posture. Early years carry meaningful risk, so preserving flexibility now remains important.',
      recommendation:
        'Keep near-term spending close to current levels and improve resilience first; then revisit shifting more spend into your early retirement years.',
    };
  }

  return {
    assessment: 'balanced_path' as const,
    overConservingLateLife,
    earlySpendingCanIncreaseSafely,
    estimatedSafeEarlyAnnualShift: 0,
    explanation:
      'Your plan is reasonably balanced across decades. You can prioritize experiences earlier, but only with modest, measured increases.',
    recommendation:
      'If desired, increase flexible or travel spending gradually and recheck success and legacy buffers after each adjustment.',
  };
}

function findScenarioDelta(
  decision: DecisionEngineReport,
  scenarioId: string,
) {
  return (
    decision.allScenarioResults.find((item) => item.scenarioId === scenarioId)?.delta
      .deltaSuccessRate ?? null
  );
}

function buildTrustPanel(input: {
  plan: Plan;
  planRun: RetirementPlanRunResult;
  decision: DecisionEngineReport;
  topRecommendations: PlanRecommendation[];
}): PlanTrustPanel {
  const checks: PlanTrustCheck[] = [];
  const modelCompleteness = input.planRun.plan.modelCompleteness;
  const inferredAssumptionsCount = input.planRun.plan.inferredAssumptions.length;
  const dataFidelityStatus: TrustCheckStatus =
    modelCompleteness === 'faithful'
      ? 'pass'
      : inferredAssumptionsCount >= 4
        ? 'fail'
        : 'warn';
  checks.push({
    id: 'data_fidelity',
    title: 'Data fidelity and explicit assumptions',
    status: dataFidelityStatus,
    detail:
      modelCompleteness === 'faithful'
        ? 'Model completeness is faithful with no inferred assumptions.'
        : `Model completeness is reconstructed with ${inferredAssumptionsCount} inferred assumptions.`,
  });

  const homeSale = input.plan.data.income.windfalls.find((item) => item.name === 'home_sale');
  const homeSaleModeled =
    !homeSale ||
    (homeSale.taxTreatment === 'primary_home_sale' &&
      typeof homeSale.costBasis === 'number' &&
      typeof homeSale.liquidityAmount === 'number');
  checks.push({
    id: 'home_sale_modeling',
    title: 'Home-sale modeling completeness',
    status: homeSaleModeled ? 'pass' : homeSale ? 'warn' : 'warn',
    detail: !homeSale
      ? 'No home-sale event is modeled.'
      : homeSaleModeled
        ? 'Home-sale tax basis and net liquidity are explicitly modeled.'
        : 'Home-sale event exists but is missing cost basis and/or net liquidity modeling.',
  });

  const inheritance = input.plan.data.income.windfalls.find((item) => item.name === 'inheritance');
  const inheritanceModeled = !inheritance
    ? false
    : Boolean(inheritance.taxTreatment) &&
      (inheritance.taxTreatment !== 'inherited_ira_10y' ||
        typeof inheritance.distributionYears === 'number');
  checks.push({
    id: 'inheritance_modeling',
    title: 'Inheritance treatment explicitness',
    status: inheritanceModeled ? 'pass' : inheritance ? 'warn' : 'warn',
    detail: !inheritance
      ? 'No inheritance event is modeled.'
      : inheritanceModeled
        ? `Inheritance tax treatment is explicitly modeled as "${inheritance.taxTreatment}".`
        : 'Inheritance event is present but treatment/distribution assumptions are not fully explicit.',
  });

  const recommendationEvidenceCoverage = input.topRecommendations.length
    ? input.topRecommendations.filter((item) => Math.abs(item.deltaSuccessRate) >= 0.005).length /
      input.topRecommendations.length
    : 0;
  const recommendationEvidenceStatus: TrustCheckStatus =
    recommendationEvidenceCoverage === 1
      ? 'pass'
      : recommendationEvidenceCoverage >= 0.5
        ? 'warn'
        : 'fail';
  checks.push({
    id: 'recommendation_evidence',
    title: 'Recommendations backed by measured deltas',
    status: recommendationEvidenceStatus,
    detail:
      input.topRecommendations.length === 0
        ? 'No top recommendations were produced.'
        : `${Math.round(recommendationEvidenceCoverage * 100)}% of top recommendations exceed minimum measured impact thresholds.`,
  });

  const conversionPolicy = input.plan.data.rules.rothConversionPolicy;
  const policyExplicit = Boolean(conversionPolicy);
  const policyEnabled = conversionPolicy?.enabled ?? true;
  checks.push({
    id: 'roth_policy',
    title: 'Explicit Roth conversion policy',
    status: policyEnabled ? (policyExplicit ? 'pass' : 'warn') : 'warn',
    detail: policyEnabled
      ? policyExplicit
        ? 'Roth conversion policy is explicitly configured in model rules.'
        : 'Roth conversion policy is running on defaults; configure rules for decision-grade traceability.'
      : 'Roth conversion policy is disabled in rules.',
  });

  const withdrawalPolicy = input.planRun.baselinePath.simulationConfiguration.withdrawalPolicy;
  const closedLoopConvergencePath =
    input.planRun.baselinePath.simulationDiagnostics.closedLoopConvergencePath;
  const averageClosedLoopConvergedRate = closedLoopConvergencePath.length
    ? closedLoopConvergencePath.reduce((sum, point) => sum + point.convergedRate, 0) /
      closedLoopConvergencePath.length
    : 0;
  const closedLoopEnabled =
    withdrawalPolicy.closedLoopHealthcareTaxIteration &&
    withdrawalPolicy.maxClosedLoopPasses >= 2;
  checks.push({
    id: 'closed_loop_withdrawal',
    title: 'Closed-loop withdrawal logic',
    status: !closedLoopEnabled
      ? 'fail'
      : averageClosedLoopConvergedRate >= 0.7
        ? 'pass'
        : 'warn',
    detail: closedLoopEnabled
      ? `Closed-loop healthcare/tax solving enabled with up to ${withdrawalPolicy.maxClosedLoopPasses} passes; average yearly convergence ${(averageClosedLoopConvergedRate * 100).toFixed(0)}%.`
      : 'Closed-loop healthcare/tax withdrawal iteration is not enabled.',
  });

  const inheritanceDependenceRate = input.planRun.baselinePath.inheritanceDependenceRate;
  const inheritanceSensitivityDelta = findScenarioDelta(
    input.decision,
    'assumption_remove_inheritance',
  );
  const inheritanceDependencyStatus: TrustCheckStatus =
    inheritanceDependenceRate >= 0.35 ||
    (inheritanceSensitivityDelta !== null && inheritanceSensitivityDelta <= -0.05)
      ? 'fail'
      : inheritanceDependenceRate >= 0.2 ||
          (inheritanceSensitivityDelta !== null && inheritanceSensitivityDelta <= -0.02)
        ? 'warn'
        : 'pass';
  checks.push({
    id: 'inheritance_dependency',
    title: 'Inheritance dependency risk',
    status: inheritanceDependencyStatus,
    detail: `Dependence rate ${Math.round(inheritanceDependenceRate * 100)}%${
      inheritanceSensitivityDelta === null
        ? '.'
        : `; remove-inheritance success delta ${(inheritanceSensitivityDelta * 100).toFixed(1)} pts.`
    }`,
  });

  const homeSaleDependenceRate = input.planRun.baselinePath.homeSaleDependenceRate;
  const homeSaleSensitivityDelta =
    findScenarioDelta(input.decision, 'assumption_remove_home_sale') ??
    findScenarioDelta(input.decision, 'housing_keep_house');
  const homeSaleDependencyStatus: TrustCheckStatus =
    homeSaleDependenceRate >= 0.3 ||
    (homeSaleSensitivityDelta !== null && homeSaleSensitivityDelta <= -0.05)
      ? 'fail'
      : homeSaleDependenceRate >= 0.15 ||
          (homeSaleSensitivityDelta !== null && homeSaleSensitivityDelta <= -0.02)
        ? 'warn'
        : 'pass';
  checks.push({
    id: 'home_sale_dependency',
    title: 'Home-sale dependency risk',
    status: homeSaleDependencyStatus,
    detail: `Dependence rate ${Math.round(homeSaleDependenceRate * 100)}%${
      homeSaleSensitivityDelta === null
        ? '.'
        : `; remove-home-sale success delta ${(homeSaleSensitivityDelta * 100).toFixed(1)} pts.`
    }`,
  });

  const objective = input.planRun.solver.activeOptimizationObjective;
  const schedule = input.planRun.solver.supportedSpendingSchedule;
  const scheduleMean = schedule.length
    ? schedule.reduce((sum, row) => sum + row.annualSpend, 0) / schedule.length
    : 0;
  const scheduleSpread = schedule.length
    ? Math.max(...schedule.map((row) => row.annualSpend)) -
      Math.min(...schedule.map((row) => row.annualSpend))
    : 0;
  const phasedSignal = scheduleMean > 0 ? scheduleSpread / scheduleMean : 0;
  const phasedStatus: TrustCheckStatus =
    objective === 'maximize_time_weighted_spending'
      ? phasedSignal >= 0.05
        ? 'pass'
        : 'warn'
      : 'warn';
  checks.push({
    id: 'phased_spending_realism',
    title: 'Phased spending realism',
    status: phasedStatus,
    detail:
      objective === 'maximize_time_weighted_spending'
        ? `Time-weighted objective active; spending phase spread ${(phasedSignal * 100).toFixed(1)}%.`
        : `Objective is ${objective}; time-phased realism checks are reduced.`,
  });

  const passCount = checks.filter((check) => check.status === 'pass').length;
  const warnCount = checks.filter((check) => check.status === 'warn').length;
  const failCount = checks.filter((check) => check.status === 'fail').length;
  const confidence: PlanTrustPanel['confidence'] =
    failCount > 0 ? (failCount >= 2 ? 'low' : 'medium') : warnCount >= 4 ? 'medium' : 'high';
  const safeToRely =
    failCount === 0 &&
    recommendationEvidenceCoverage >= 0.5 &&
    dataFidelityStatus !== 'fail';

  return {
    version: 'decision_trust_v1',
    safeToRely,
    confidence,
    summary: safeToRely
      ? 'Run quality is good enough for decision use with normal monitoring.'
      : 'Run quality needs attention before treating recommendations as execution-ready.',
    checks,
    metrics: {
      passCount,
      warnCount,
      failCount,
      recommendationEvidenceCoverage,
      inheritanceDependenceRate,
      homeSaleDependenceRate,
    },
  };
}

export async function evaluatePlan(
  plan: Plan,
  options: EvaluatePlanOptions = {},
): Promise<PlanEvaluation> {
  const finishPerf = perfStart('plan-eval', 'evaluate-plan', {
    selectedStressors: plan.controls.selectedStressorIds.length,
    selectedResponses: plan.controls.selectedResponseIds.length,
  });
  const preferences = plan.preferences ?? {};
  const toggles = plan.controls.toggles ?? {};
  const selectedResponses = ensureResponse(
    ensureResponse(
      [...plan.controls.selectedResponseIds],
      'preserve_roth',
      Boolean(toggles.preserveRoth),
    ),
    'increase_cash_buffer',
    Boolean(toggles.increaseCashBuffer),
  );

  const noDelayRetirement = Boolean(toggles.avoidRetirementDelayRecommendations);
  const noSellHouse = Boolean(toggles.avoidHomeSaleRecommendations);
  const travelFlexPercent = preferences.responsePolicy?.travelFlexPercent ?? 20;
  const optionalSpendingCutsAllowed = preferences.responsePolicy?.optionalSpendingCutsAllowed ?? true;
  const optionalSpendingFlexPercent = preferences.responsePolicy?.optionalSpendingFlexPercent ?? 12;
  const autopilotPosture = preferences.responsePolicy?.posture ?? 'defensive';
  const irmaaPosture = preferences.irmaaPosture ?? 'balanced';
  const optimizationObjective =
    preferences.calibration?.optimizationObjective ?? 'maximize_time_weighted_spending';
  const legacyPriority = resolveLegacyPriority(preferences.calibration?.legacyPriority);
  const successFloorMode = resolveSuccessFloorMode({
    mode: preferences.calibration?.successFloorMode,
    minSuccessRate: preferences.calibration?.minSuccessRate,
  });
  const requestedLegacyTargetTodayDollars = Math.max(
    0,
    preferences.calibration?.targetLegacyTodayDollars ?? 1_000_000,
  );
  const requestedMinSuccessRate = resolveRequestedMinSuccessRate({
    minSuccessRate: preferences.calibration?.minSuccessRate,
    successFloorMode,
  });
  const {
    effectiveLegacyTargetTodayDollars,
    effectiveMinSuccessRate,
  } = applyLegacyPriorityToTargets({
    requestedLegacyTargetTodayDollars,
    requestedMinSuccessRate,
    legacyPriority,
  });
  const runtimePreferences = preferences.runtime;
  options.onPhaseProgress?.({
    phase: 'plan_evaluation_start',
    status: 'start',
    meta: {
      stressorCount: plan.controls.selectedStressorIds.length,
      responseCount: plan.controls.selectedResponseIds.length,
    },
  });
  options.onPhaseProgress?.({
    phase: 'build_plan',
    status: 'start',
  });

  const builtPlan = buildRetirementPlan({
    data: plan.data,
    assumptions: plan.assumptions,
    selectedStressors: [...plan.controls.selectedStressorIds],
    selectedResponses,
    constraints: {
      doNotRetireLater: noDelayRetirement,
      doNotSellHouse: noSellHouse,
      minimumTravelBudgetAnnual: Math.max(
        0,
        plan.data.spending.travelEarlyRetirementAnnual * (1 - travelFlexPercent / 100),
      ),
    },
    autopilotPolicy: {
      posture: autopilotPosture,
      optionalSpendingCutsAllowed,
      optionalSpendingFlexPercent,
      travelFlexPercent,
      defensiveResponses: autopilotPosture === 'defensive' ? ['cut_spending'] : [],
    },
    withdrawalPolicy: {
      preserveRothPreference: preferences.responsePolicy?.preserveRothPreference ?? false,
      dynamicDefenseOrdering: autopilotPosture === 'defensive',
      irmaaAware: irmaaPosture !== 'ignore',
    },
    targets: {
      exitTargetTodayDollars: effectiveLegacyTargetTodayDollars,
      spendingTargetAnnual:
        plan.data.spending.essentialMonthly * 12 +
        plan.data.spending.optionalMonthly * 12 +
        plan.data.spending.annualTaxesInsurance +
        plan.data.spending.travelEarlyRetirementAnnual,
      minSuccessRate: effectiveMinSuccessRate,
      successRateRange: preferences.calibration?.successRateRange,
      optimizationObjective,
      timePreferenceWeights: preferences.calibration?.timePreferenceWeights,
    },
    irmaaPolicy: {
      posture: irmaaPosture,
    },
    decisionEngineSettings: {
      strategyMode: 'planner_enhanced',
      seedStrategy: 'shared',
      simulationRunsOverride: runtimePreferences?.decisionSimulationRuns,
      scenarioEvaluationLimit: runtimePreferences?.decisionScenarioEvaluationLimit,
      evaluateExcludedScenarios: runtimePreferences?.decisionEvaluateExcludedScenarios,
    },
    runtimeBudgets: runtimePreferences
      ? {
          timeoutMs: runtimePreferences.timeoutMs,
          finalEvaluationSimulationRuns: runtimePreferences.finalEvaluationSimulationRuns,
          solverSearchSimulationRuns: runtimePreferences.solverSearchSimulationRuns,
          solverFinalSimulationRuns: runtimePreferences.solverFinalSimulationRuns,
          solverMaxIterations: runtimePreferences.solverMaxIterations,
          solverDiagnosticsMode: runtimePreferences.solverDiagnosticsMode,
          solverEnableSuccessRelaxationProbe:
            runtimePreferences.solverEnableSuccessRelaxationProbe,
          decisionSimulationRuns: runtimePreferences.decisionSimulationRuns,
          decisionScenarioEvaluationLimit:
            runtimePreferences.decisionScenarioEvaluationLimit,
          decisionEvaluateExcludedScenarios:
            runtimePreferences.decisionEvaluateExcludedScenarios,
          stressTestComplexity: runtimePreferences.stressTestComplexity,
        }
      : undefined,
    decisionImpactRequest: preferences.decisionImpact,
  });
  options.onPhaseProgress?.({
    phase: 'build_plan',
    status: 'end',
  });
  options.onPhaseProgress?.({
    phase: 'retirement_analysis',
    status: 'start',
  });

  const planRun = await analyzeRetirementPlan(
    builtPlan,
    {
      onPhaseProgress: options.onPhaseProgress,
    },
  );
  options.onPhaseProgress?.({
    phase: 'retirement_analysis',
    status: 'end',
  });
  options.onPhaseProgress?.({
    phase: 'result_shaping',
    status: 'start',
  });

  const decision = planRun.decision;
  const topRecommendations = decision.rankedRecommendations.slice(0, 3).map(toPlanRecommendation);
  const biggestDownside = decision.worstSensitivityScenarios[0]
    ? toPlanRecommendation(decision.worstSensitivityScenarios[0])
    : null;

  const whatChanged = toWhatChangedFromLastRun(options.previousEvaluation, decision);
  const irmaaExplanation = toIrmaaExplanation(
    planRun.irmaa.posture,
    planRun.irmaa.exposureLevel,
    planRun.irmaa.mainDrivers[0],
  );
  const legacyOutlook = toLegacyOutlook({
    legacyPriority,
    requestedLegacyTargetTodayDollars,
    effectiveLegacyTargetTodayDollars,
    projectedLegacyTodayDollars: planRun.solver.projectedLegacyOutcomeTodayDollars,
  });
  const recommendationLegacyNote = toLegacyRecommendationNote({
    legacyPriority,
    requestedLegacyTargetTodayDollars,
    projectedLegacyTodayDollars: planRun.solver.projectedLegacyOutcomeTodayDollars,
  });
  const biggestDriver = sanitizeRecommendationText(
    decision.biggestDriver?.summary ?? 'No single dominant improvement driver yet.',
  );
  const biggestRisk = sanitizeRecommendationText(
    decision.baselineRiskWarning ??
      decision.worstSensitivityScenarios[0]?.recommendationSummary ??
      'Main risk is early sequence pressure before later income support arrives.',
  );
  const timePreferenceProfile = normalizeTimePreferenceProfile(
    preferences.timePreference,
  );
  const timePreference = buildTimePreferenceInterpretation({
    profile: timePreferenceProfile,
    legacyPriority,
    minSuccessRate: effectiveMinSuccessRate,
    successRate: decision.baseline.successRate,
    projectedLegacyTodayDollars: planRun.solver.projectedLegacyOutcomeTodayDollars,
    effectiveLegacyTargetTodayDollars,
    safeBandUpperAnnual: planRun.solver.safeSpendingBand.upperAnnual,
    supportedAnnualSpend: planRun.solver.recommendedAnnualSpend,
    baselineMetrics: decision.baseline,
  });
  const bestAction = sanitizeRecommendationText(
    timePreference.earlySpendingCanIncreaseSafely
      ? timePreference.recommendation
      : decision.recommendationSummary.summary,
  );
  const trustPanel = buildTrustPanel({
    plan,
    planRun,
    decision,
    topRecommendations,
  });

  const evaluation: PlanEvaluation = {
    summary: {
      planSupportsAnnual: planRun.solver.supportedAnnualSpendNow,
      planSupportsMonthly: planRun.solver.supportedMonthlySpendNow,
      successRate: planRun.solver.modeledSuccessRate,
      planVerdict: toPlanVerdict(planRun.solver.modeledSuccessRate),
      biggestDriver,
      biggestRisk,
      bestAction,
      activeOptimizationObjective: planRun.solver.activeOptimizationObjective,
      irmaaOutlook: `${planRun.irmaa.exposureLevel} exposure${
        planRun.irmaa.likelyYearsAtRisk.length
          ? ` (${planRun.irmaa.likelyYearsAtRisk.length} years at risk)`
          : ''
      }`,
      legacyOutlook,
      bequestAttainmentRate:
        legacyPriority === 'off'
          ? null
          : approximateBequestAttainmentRate(requestedLegacyTargetTodayDollars, {
              p10: planRun.solver.p10EndingWealthTodayDollars,
              p25: planRun.solver.p25EndingWealthTodayDollars,
              p50: planRun.solver.medianEndingWealthTodayDollars,
              p75: planRun.solver.p75EndingWealthTodayDollars,
              p90: planRun.solver.p90EndingWealthTodayDollars,
            }),
    },
    calibration: {
      userTargetMonthlySpendNow: planRun.solver.userTargetSpendNowMonthly,
      userTargetAnnualSpendNow: planRun.solver.userTargetSpendNowAnnual,
      supportedMonthlySpendNow: planRun.solver.supportedMonthlySpendNow,
      supportedAnnualSpendNow: planRun.solver.supportedAnnualSpendNow,
      supportedSpend60s: planRun.solver.supportedSpend60s,
      supportedSpend70s: planRun.solver.supportedSpend70s,
      supportedSpend80Plus: planRun.solver.supportedSpend80Plus,
      spendGapNowMonthly: planRun.solver.spendGapNowMonthly,
      spendGapNowAnnual: planRun.solver.spendGapNowAnnual,
      flexibleSpendingMinimum: planRun.solver.flexibleSpendingMinimum,
      overReservedAmount: planRun.solver.overReservedAmount,
      supportedAnnualSpend: planRun.solver.supportedAnnualSpendNow,
      supportedMonthlySpend: planRun.solver.supportedMonthlySpendNow,
      safeBandAnnual: {
        lower: planRun.solver.safeSpendingBand.lowerAnnual,
        target: planRun.solver.safeSpendingBand.targetAnnual,
        upper: planRun.solver.safeSpendingBand.upperAnnual,
      },
      targetLegacyTodayDollars: requestedLegacyTargetTodayDollars,
      effectiveLegacyTargetTodayDollars,
      legacyFloorTodayDollars: planRun.solver.legacyFloorTodayDollars,
      legacyTargetBandLowerTodayDollars: planRun.solver.legacyTargetBandLowerTodayDollars,
      legacyTargetBandUpperTodayDollars: planRun.solver.legacyTargetBandUpperTodayDollars,
      legacyWithinTargetBand: planRun.solver.legacyWithinTargetBand,
      legacyPriority,
      successFloorMode,
      minimumSuccessRateTarget: planRun.solver.minimumSuccessRateTarget,
      achievedSuccessRate: planRun.solver.achievedSuccessRate,
      successConstraintBinding: planRun.solver.successConstraintBinding,
      supportedSpendAtCurrentSuccessFloor: planRun.solver.supportedSpendAtCurrentSuccessFloor,
      supportedSpendIfSuccessFloorRelaxed: planRun.solver.supportedSpendIfSuccessFloorRelaxed,
      successFloorRelaxationTarget: planRun.solver.successFloorRelaxationTarget,
      successFloorRelaxationDeltaAnnual: planRun.solver.successFloorRelaxationDeltaAnnual,
      successFloorRelaxationDeltaMonthly: planRun.solver.successFloorRelaxationDeltaMonthly,
      nextUnlockImpactMonthly: planRun.solver.nextUnlockImpactMonthly,
      successFloorNextUnlock: planRun.solver.successFloorNextUnlock,
      successFloorRelaxationTradeoff: planRun.solver.successFloorRelaxationTradeoff,
      nextUnlock: planRun.solver.nextUnlock,
      supportedSpendingSchedule: planRun.solver.supportedSpendingSchedule,
      projectedLegacyTodayDollars: planRun.solver.projectedLegacyOutcomeTodayDollars,
      bequestDistributionTodayDollars: {
        p10: planRun.solver.p10EndingWealthTodayDollars,
        p25: planRun.solver.p25EndingWealthTodayDollars,
        p50: planRun.solver.medianEndingWealthTodayDollars,
        p75: planRun.solver.p75EndingWealthTodayDollars,
        p90: planRun.solver.p90EndingWealthTodayDollars,
      },
      endingWealthOneSigmaApproxTodayDollars:
        planRun.solver.endingWealthOneSigmaApproxTodayDollars,
      endingWealthOneSigmaLowerTodayDollars:
        planRun.solver.endingWealthOneSigmaLowerTodayDollars,
      endingWealthOneSigmaUpperTodayDollars:
        planRun.solver.endingWealthOneSigmaUpperTodayDollars,
      distanceFromTarget: planRun.solver.distanceFromTarget,
      overTargetPenalty: planRun.solver.overTargetPenalty,
      isTargetBinding: planRun.solver.isTargetBinding,
      modeledSuccessRate: planRun.solver.modeledSuccessRate,
      bindingGuardrail: planRun.solver.bindingGuardrail,
      bindingGuardrailExplanation: planRun.solver.bindingGuardrailExplanation,
      bindingConstraint: planRun.solver.bindingConstraint,
      primaryTradeoff: planRun.solver.primaryTradeoff,
      whySupportedSpendIsNotHigher: planRun.solver.whySupportedSpendIsNotHigher,
    },
    responsePolicy: {
      posture: autopilotPosture,
      routeSummary: planRun.autopilot.summary.routeSummary,
      tradeoffSummary: planRun.autopilot.summary.tradeoffSummary,
      primaryBindingConstraint: planRun.autopilot.summary.primaryBindingConstraint,
    },
    timePreference: {
      profile: timePreferenceProfile,
      assessment: timePreference.assessment,
      overConservingLateLife: timePreference.overConservingLateLife,
      earlySpendingCanIncreaseSafely: timePreference.earlySpendingCanIncreaseSafely,
      estimatedSafeEarlyAnnualShift: timePreference.estimatedSafeEarlyAnnualShift,
      explanation: timePreference.explanation,
      recommendation: timePreference.recommendation,
      indicators: {
        successBuffer:
          decision.baseline.successRate - effectiveMinSuccessRate,
        legacyBuffer:
          planRun.solver.projectedLegacyOutcomeTodayDollars -
          effectiveLegacyTargetTodayDollars,
        earlyFailureRate: decision.baseline.percentFailFirst10Years,
        preSocialSecurityFailureRate:
          decision.baseline.percentFailBeforeSocialSecurity,
        p10EndingWealth: decision.baseline.p10EndingWealth,
        p50EndingWealth: decision.baseline.medianEndingWealth,
      },
    },
    irmaa: {
      posture: planRun.irmaa.posture,
      exposureLevel: planRun.irmaa.exposureLevel,
      likelyYearsAtRisk: planRun.irmaa.likelyYearsAtRisk,
      mainDrivers: planRun.irmaa.mainDrivers,
      whatWouldLowerExposure: planRun.irmaa.whatToChangeToLowerExposure,
      explanation: irmaaExplanation,
    },
    recommendations: {
      summary: `${bestAction} ${timePreference.explanation} ${recommendationLegacyNote}`,
      top: topRecommendations,
    },
    whatChangedFromLastRun: whatChanged,
    sensitivities: {
      biggestDownside,
      worst: decision.worstSensitivityScenarios.slice(0, 3).map(toPlanRecommendation),
    },
    excludedOptions: {
      activeFilters: {
        noDelayRetirement,
        noSellHouse,
      },
      highImpact: decision.excludedHighImpactLevers.map((item) => ({
        scenario: sanitizeRecommendationText(item.scenario),
        deltaSuccessRate: item.deltaSuccessRate,
        reason: sanitizeRecommendationText(item.reasonExcluded),
      })),
    },
    trustPanel,
    decisionImpact: planRun.decisionImpact,
    raw: {
      baselinePath: planRun.baselinePath,
      spendingCalibration: planRun.solver,
      autopilot: planRun.autopilot,
      decision: planRun.decision,
      run: planRun,
    },
  };
  options.onPhaseProgress?.({
    phase: 'result_shaping',
    status: 'end',
  });
  options.onPhaseProgress?.({
    phase: 'plan_evaluation_complete',
    status: 'end',
    meta: {
      successRate: decision.baseline.successRate,
      objective: optimizationObjective,
    },
  });
  finishPerf('ok', {
    successRate: decision.baseline.successRate,
    objective: optimizationObjective,
  });
  return evaluation;
}
