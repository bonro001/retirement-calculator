import type { AutopilotPlanResult } from './autopilot-timeline';
import type { DecisionEngineReport, LeverScenarioResult } from './decision-engine';
import {
  analyzeRetirementPlan,
  buildRetirementPlan,
  type IrmaaPosture,
  type RetirementPlanRunResult,
} from './retirement-plan';
import type { SpendSolverResult, SpendSolverSuccessRange } from './spend-solver';
import type { MarketAssumptions, PathResult, SeedData } from './types';

export type LegacyPriority = 'off' | 'nice_to_have' | 'important' | 'must_preserve';

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
  calibration?: {
    targetLegacyTodayDollars?: number;
    legacyPriority?: LegacyPriority;
    minSuccessRate?: number;
    successRateRange?: SpendSolverSuccessRange;
  };
  responsePolicy?: {
    posture?: 'defensive' | 'balanced';
    optionalSpendingCutsAllowed?: boolean;
    optionalSpendingFlexPercent?: number;
    travelFlexPercent?: number;
    preserveRothPreference?: boolean;
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

export interface PlanEvaluation {
  summary: {
    planSupportsAnnual: number;
    planSupportsMonthly: number;
    successRate: number;
    planVerdict: 'Fragile' | 'Moderate' | 'Strong';
    biggestDriver: string;
    biggestRisk: string;
    bestAction: string;
    irmaaOutlook: string;
    legacyOutlook: string;
  };
  calibration: {
    supportedAnnualSpend: number;
    supportedMonthlySpend: number;
    safeBandAnnual: {
      lower: number;
      target: number;
      upper: number;
    };
    targetLegacyTodayDollars: number;
    effectiveLegacyTargetTodayDollars: number;
    legacyPriority: LegacyPriority;
    projectedLegacyTodayDollars: number;
    modeledSuccessRate: number;
    bindingConstraint: string;
  };
  responsePolicy: {
    posture: 'defensive' | 'balanced';
    routeSummary: string;
    tradeoffSummary: string;
    primaryBindingConstraint: string;
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
      effectiveMinSuccessRate: clampRate(requestedMinSuccessRate + 0.03),
    };
  }

  return {
    effectiveLegacyTargetTodayDollars: requestedLegacyTargetTodayDollars,
    effectiveMinSuccessRate: requestedMinSuccessRate,
  };
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

export async function evaluatePlan(
  plan: Plan,
  options: EvaluatePlanOptions = {},
): Promise<PlanEvaluation> {
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
  const legacyPriority = resolveLegacyPriority(preferences.calibration?.legacyPriority);
  const requestedLegacyTargetTodayDollars = Math.max(
    0,
    preferences.calibration?.targetLegacyTodayDollars ?? 1_000_000,
  );
  const requestedMinSuccessRate = clampRate(preferences.calibration?.minSuccessRate ?? 0.8);
  const {
    effectiveLegacyTargetTodayDollars,
    effectiveMinSuccessRate,
  } = applyLegacyPriorityToTargets({
    requestedLegacyTargetTodayDollars,
    requestedMinSuccessRate,
    legacyPriority,
  });

  const planRun = await analyzeRetirementPlan(
    buildRetirementPlan({
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
      },
      irmaaPolicy: {
        posture: irmaaPosture,
      },
      decisionEngineSettings: {
        strategyMode: 'planner_enhanced',
        seedStrategy: 'shared',
      },
    }),
  );

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
  const bestAction = sanitizeRecommendationText(decision.recommendationSummary.summary);
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

  return {
    summary: {
      planSupportsAnnual: planRun.solver.recommendedAnnualSpend,
      planSupportsMonthly: planRun.solver.recommendedMonthlySpend,
      successRate: decision.baseline.successRate,
      planVerdict: toPlanVerdict(decision.baseline.successRate),
      biggestDriver,
      biggestRisk,
      bestAction,
      irmaaOutlook: `${planRun.irmaa.exposureLevel} exposure${
        planRun.irmaa.likelyYearsAtRisk.length
          ? ` (${planRun.irmaa.likelyYearsAtRisk.length} years at risk)`
          : ''
      }`,
      legacyOutlook,
    },
    calibration: {
      supportedAnnualSpend: planRun.solver.recommendedAnnualSpend,
      supportedMonthlySpend: planRun.solver.recommendedMonthlySpend,
      safeBandAnnual: {
        lower: planRun.solver.safeSpendingBand.lowerAnnual,
        target: planRun.solver.safeSpendingBand.targetAnnual,
        upper: planRun.solver.safeSpendingBand.upperAnnual,
      },
      targetLegacyTodayDollars: requestedLegacyTargetTodayDollars,
      effectiveLegacyTargetTodayDollars,
      legacyPriority,
      projectedLegacyTodayDollars: planRun.solver.projectedLegacyOutcomeTodayDollars,
      modeledSuccessRate: planRun.solver.modeledSuccessRate,
      bindingConstraint: planRun.solver.bindingConstraint,
    },
    responsePolicy: {
      posture: autopilotPosture,
      routeSummary: planRun.autopilot.summary.routeSummary,
      tradeoffSummary: planRun.autopilot.summary.tradeoffSummary,
      primaryBindingConstraint: planRun.autopilot.summary.primaryBindingConstraint,
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
      summary: `${bestAction} ${recommendationLegacyNote}`,
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
    raw: {
      baselinePath: planRun.baselinePath,
      spendingCalibration: planRun.solver,
      autopilot: planRun.autopilot,
      decision: planRun.decision,
      run: planRun,
    },
  };
}
