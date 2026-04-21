import type { StrategicPrepRecommendation } from './flight-path-policy';
import type {
  FlightPathPhaseAction,
  FlightPathPhasePlaybook,
} from './flight-path-action-playbook';
import type { PlanEvaluation } from './plan-evaluation';
import type { SeedData } from './types';

export type ExecutiveActionUrgency = 'act_now' | 'soon' | 'agenda';
export type ExecutiveActionCategory = 'spending' | 'aca' | 'runway' | 'conversion' | 'other';

export interface ExecutiveActionCard {
  id: string;
  title: string;
  category: ExecutiveActionCategory;
  urgency: ExecutiveActionUrgency;
  score: number;
  amountPrimary: number | null;
  detail: string;
  whyItMatters: string;
  expectedImpact: string;
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  phaseAnchorTarget?: {
    phaseId: string;
    actionId: string | null;
  };
}

export interface ExecutiveFlightSummary {
  headlineMetrics: {
    trackedNetWorth: number;
    salaryEndDateIso: string;
    windfallTotal: number;
    windfallCount: number;
    firstWindfallYear: number | null;
    socialSecurityAnnualAtClaim: number;
  };
  planHealth: {
    successRate: number | null;
    targetMonthlySpend: number;
    supportedMonthlySpend: number;
    spendShortfallMonthly: number;
    acaBridgeYear: number | null;
    acaRequiredMagiReduction: number;
    acaProjectedMagi: number;
    acaFriendlyCeiling: number | null;
    runwayGapMonths: number;
  };
  narrative: {
    whereThingsStand: string;
    whatMattersNow: string;
  };
  actionCards: ExecutiveActionCard[];
}

interface BuildExecutiveFlightSummaryInput {
  data: SeedData;
  evaluation: PlanEvaluation | null;
  phasePlaybook: FlightPathPhasePlaybook;
  strategicPrepRecommendations: StrategicPrepRecommendation[];
}

const roundMoney = (value: number) => Number(value.toFixed(2));
const roundPercent = (value: number) => Number((value * 100).toFixed(1));

function socialSecurityBenefitFactor(claimAge: number) {
  if (claimAge < 67) {
    return Math.max(0.7, 1 - (67 - claimAge) * 0.06);
  }
  if (claimAge > 67) {
    return 1 + (claimAge - 67) * 0.08;
  }
  return 1;
}

function formatIsoDate(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toISOString().slice(0, 10);
}

function confidenceFromStrategicRecommendation(
  recommendation: StrategicPrepRecommendation | null,
): ExecutiveActionCard['confidence'] {
  if (!recommendation) {
    return 'unknown';
  }
  if (recommendation.confidence.label === 'high') {
    return 'high';
  }
  if (recommendation.confidence.label === 'medium') {
    return 'medium';
  }
  return 'low';
}

function confidenceFromPhaseAction(action: FlightPathPhaseAction | null): ExecutiveActionCard['confidence'] {
  if (!action) {
    return 'unknown';
  }
  return action.modelCompleteness === 'faithful' ? 'high' : 'medium';
}

function urgencyFromPriority(priority: 'now' | 'soon' | 'watch'): ExecutiveActionUrgency {
  if (priority === 'now') {
    return 'act_now';
  }
  if (priority === 'soon') {
    return 'soon';
  }
  return 'agenda';
}

function buildImpactSummary(input: {
  successRateDelta: number | null;
  supportedMonthlyDelta: number | null;
}) {
  if (input.successRateDelta === null && input.supportedMonthlyDelta === null) {
    return 'Impact still being quantified.';
  }
  if (input.successRateDelta !== null && input.supportedMonthlyDelta !== null) {
    return `${roundPercent(input.successRateDelta)} pts success and ${roundMoney(
      input.supportedMonthlyDelta,
    ).toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    })}/mo supported-spend change.`;
  }
  if (input.successRateDelta !== null) {
    return `${roundPercent(input.successRateDelta)} pts success impact.`;
  }
  return `${roundMoney(input.supportedMonthlyDelta ?? 0).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  })}/mo supported-spend impact.`;
}

function findTopPhaseAction(playbook: FlightPathPhasePlaybook, phaseId: string) {
  const phase = playbook.phases.find((item) => item.id === phaseId);
  if (!phase) {
    return { phase: null, action: null };
  }
  const action = phase.actions.find((item) => item.isTopRecommendation) ?? phase.actions[0] ?? null;
  return { phase, action };
}

function buildSpendingActionCard(input: {
  spendShortfallMonthly: number;
  recommendation: StrategicPrepRecommendation | null;
}): ExecutiveActionCard | null {
  if (!(input.spendShortfallMonthly > 0)) {
    return null;
  }
  const impact = input.recommendation?.estimatedImpact ?? null;
  return {
    id: 'summary-spending-gap',
    title: 'Align monthly spending with supported level',
    category: 'spending',
    urgency: 'act_now',
    score: 100 + input.spendShortfallMonthly / 100,
    amountPrimary: roundMoney(input.spendShortfallMonthly),
    detail: `Target spending is about ${roundMoney(input.spendShortfallMonthly).toLocaleString(
      'en-US',
      {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 0,
      },
    )}/month above the currently supported path.`,
    whyItMatters:
      'Closing this gap is usually the fastest lever to improve success odds without changing retirement timing.',
    expectedImpact: buildImpactSummary({
      successRateDelta: impact?.successRateDelta ?? null,
      supportedMonthlyDelta: impact?.supportedMonthlyDelta ?? null,
    }),
    confidence: confidenceFromStrategicRecommendation(input.recommendation),
  };
}

function buildAcaActionCard(input: {
  playbook: FlightPathPhasePlaybook;
  requiredMagiReduction: number;
  bridgeYear: number | null;
  projectedMagi: number;
  acaFriendlyCeiling: number | null;
}): ExecutiveActionCard | null {
  const { phase, action } = findTopPhaseAction(input.playbook, 'aca_bridge');
  if (!(input.requiredMagiReduction > 0) && !action) {
    return null;
  }
  const urgency: ExecutiveActionUrgency =
    input.requiredMagiReduction > 0 ? 'act_now' : action ? urgencyFromPriority(action.priority) : 'soon';
  const score =
    input.requiredMagiReduction > 0
      ? 95 + input.requiredMagiReduction / 1000
      : action
        ? 70 + action.rankScore
        : 60;
  const impact = action?.estimatedImpact ?? null;
  const ceilingText =
    input.acaFriendlyCeiling === null
      ? 'an inferred ACA ceiling'
      : roundMoney(input.acaFriendlyCeiling).toLocaleString('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 0,
      });

  return {
    id: 'summary-aca-bridge',
    title: 'Protect ACA bridge subsidy eligibility',
    category: 'aca',
    urgency,
    score,
    amountPrimary: roundMoney(input.requiredMagiReduction),
    detail:
      input.requiredMagiReduction > 0
        ? `Bridge year ${input.bridgeYear ?? 'n/a'} MAGI is about ${roundMoney(
          input.requiredMagiReduction,
        ).toLocaleString('en-US', {
          style: 'currency',
          currency: 'USD',
          maximumFractionDigits: 0,
        })} over the modeled ACA-friendly ceiling (${ceilingText}).`
        : `Bridge year ${input.bridgeYear ?? 'n/a'} MAGI is ${roundMoney(
          input.projectedMagi,
        ).toLocaleString('en-US', {
          style: 'currency',
          currency: 'USD',
          maximumFractionDigits: 0,
        })}; keep a cushion under the ACA-friendly ceiling (${ceilingText}).`,
    whyItMatters:
      'Managing MAGI in bridge years protects premium support and prevents avoidable healthcare-cost spikes.',
    expectedImpact: buildImpactSummary({
      successRateDelta: impact?.successRateDelta ?? null,
      supportedMonthlyDelta: impact?.supportedMonthlyDelta ?? null,
    }),
    confidence: confidenceFromPhaseAction(action),
    phaseAnchorTarget: phase
      ? {
          phaseId: phase.id,
          actionId: action?.id ?? null,
        }
      : undefined,
  };
}

function buildRunwayActionCard(input: {
  playbook: FlightPathPhasePlaybook;
  runwayGapMonths: number;
  recommendation: StrategicPrepRecommendation | null;
}): ExecutiveActionCard | null {
  if (!(input.runwayGapMonths > 0) || !input.recommendation) {
    return null;
  }
  const { phase, action } = findTopPhaseAction(input.playbook, 'pre_retirement');
  if (!phase || !action) {
    return null;
  }
  const impact = input.recommendation.estimatedImpact ?? action.estimatedImpact;
  return {
    id: 'summary-runway-gap',
    title: 'Close pre-retirement cash runway gap',
    category: 'runway',
    urgency:
      input.runwayGapMonths >= 3
        ? 'act_now'
        : urgencyFromPriority(input.recommendation.priority),
    score: 85 + input.runwayGapMonths,
    amountPrimary: action.fullGoalDollars,
    detail: `Runway is short by about ${roundMoney(input.runwayGapMonths).toLocaleString('en-US', {
      maximumFractionDigits: 1,
    })} months versus the 18-month target.`,
    whyItMatters:
      'A stronger cash runway lowers sequence risk right as salary turns off and gives better control over taxable moves.',
    expectedImpact: buildImpactSummary({
      successRateDelta: impact.successRateDelta,
      supportedMonthlyDelta: impact.supportedMonthlyDelta,
    }),
    confidence: confidenceFromStrategicRecommendation(input.recommendation),
    phaseAnchorTarget: {
      phaseId: phase.id,
      actionId: action.id,
    },
  };
}

function buildConversionActionCard(
  recommendation: StrategicPrepRecommendation | null,
): ExecutiveActionCard | null {
  if (!recommendation) {
    return null;
  }
  const impact = recommendation.estimatedImpact ?? null;
  const confidence = confidenceFromStrategicRecommendation(recommendation);
  return {
    id: 'summary-roth-conversion',
    title: 'Schedule the Roth conversion window',
    category: 'conversion',
    urgency: confidence === 'low' ? 'agenda' : recommendation.priority === 'now' ? 'soon' : 'agenda',
    score: confidence === 'low' ? 40 : 55,
    amountPrimary: null,
    detail: recommendation.action,
    whyItMatters:
      'Conversions can reduce future RMD and IRMAA pressure, but they need careful year-by-year MAGI pacing.',
    expectedImpact: buildImpactSummary({
      successRateDelta: impact?.successRateDelta ?? null,
      supportedMonthlyDelta: impact?.supportedMonthlyDelta ?? null,
    }),
    confidence,
  };
}

function buildFallbackActionCards(
  recommendations: StrategicPrepRecommendation[],
  existingIds: Set<string>,
) {
  return recommendations
    .filter((recommendation) => !existingIds.has(recommendation.id))
    .slice(0, 3)
    .map((recommendation, index) => ({
      id: `summary-fallback-${recommendation.id}`,
      title: recommendation.title,
      category: 'other' as const,
      urgency: urgencyFromPriority(recommendation.priority),
      score: 20 - index,
      amountPrimary: null,
      detail: recommendation.action,
      whyItMatters: recommendation.triggerReason,
      expectedImpact: buildImpactSummary({
        successRateDelta: recommendation.estimatedImpact?.successRateDelta ?? null,
        supportedMonthlyDelta: recommendation.estimatedImpact?.supportedMonthlyDelta ?? null,
      }),
      confidence: confidenceFromStrategicRecommendation(recommendation),
    }));
}

function buildNarrative(input: {
  summary: ExecutiveFlightSummary;
}) {
  const { headlineMetrics, planHealth, actionCards } = input.summary;
  const windfallTiming =
    headlineMetrics.firstWindfallYear === null
      ? 'with windfall timing not yet modeled'
      : `starting in ${headlineMetrics.firstWindfallYear}`;
  const successText =
    planHealth.successRate === null
      ? 'Latest modeled success rate is pending until analysis completes.'
      : `The latest Monte Carlo read is ${roundPercent(planHealth.successRate)}% success.`;
  const whereThingsStand = `You are tracking about ${roundMoney(
    headlineMetrics.trackedNetWorth,
  ).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  })} net worth, salary through ${headlineMetrics.salaryEndDateIso}, ${
    headlineMetrics.windfallCount
  } modeled windfall(s) totaling ${roundMoney(headlineMetrics.windfallTotal).toLocaleString(
    'en-US',
    {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    },
  )} ${windfallTiming}, and estimated Social Security of about ${roundMoney(
    headlineMetrics.socialSecurityAnnualAtClaim,
  ).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  })}/year once claims start. ${successText}`;

  const topActionTitles = actionCards.slice(0, 2).map((card) => card.title.toLowerCase());
  const actionLead = topActionTitles.length
    ? `Highest priority right now: ${topActionTitles.join(' and ')}.`
    : 'No urgent action is currently flagged.';
  const whatMattersNow = `${actionLead} The top actions are sorted by urgency and quantified gap size so execution can focus on the most material near-term moves first.`;

  return {
    whereThingsStand,
    whatMattersNow,
  };
}

export function buildExecutiveFlightSummary(
  input: BuildExecutiveFlightSummaryInput,
): ExecutiveFlightSummary {
  const trackedNetWorth = Object.values(input.data.accounts).reduce(
    (sum, bucket) => sum + bucket.balance,
    0,
  );
  const windfallTotal = input.data.income.windfalls.reduce((sum, windfall) => sum + windfall.amount, 0);
  const firstWindfallYear =
    input.data.income.windfalls.length > 0
      ? Math.min(...input.data.income.windfalls.map((windfall) => windfall.year))
      : null;
  const socialSecurityAnnualAtClaim = roundMoney(
    input.data.income.socialSecurity.reduce(
      (sum, entry) => sum + entry.fraMonthly * 12 * socialSecurityBenefitFactor(entry.claimAge),
      0,
    ),
  );

  const userTargetMonthlySpend =
    input.evaluation?.calibration.userTargetMonthlySpendNow ??
    (input.data.spending.essentialMonthly +
      input.data.spending.optionalMonthly +
      input.data.spending.travelEarlyRetirementAnnual / 12 +
      input.data.spending.annualTaxesInsurance / 12);
  const supportedMonthlySpend = input.evaluation?.calibration.supportedMonthlySpendNow ?? userTargetMonthlySpend;
  const spendGapMonthlyRaw = input.evaluation?.calibration.spendGapNowMonthly ?? (supportedMonthlySpend - userTargetMonthlySpend);
  const spendShortfallMonthly = roundMoney(Math.max(0, -spendGapMonthlyRaw));

  const acaBridgeMetrics = input.phasePlaybook.phases.find((phase) => phase.id === 'aca_bridge')?.acaMetrics;
  const requiredMagiReduction = roundMoney(
    input.phasePlaybook.diagnostics.acaGuardrailAdjustment.requiredMagiReduction,
  );
  const runwayGapMonths = roundMoney(input.phasePlaybook.diagnostics.acaGuardrailAdjustment.runwayGapMonths);

  const spendRecommendation =
    input.strategicPrepRecommendations.find((item) => item.id === 'spend-gap-reduce') ?? null;
  const runwayRecommendation =
    input.strategicPrepRecommendations.find((item) => item.id.includes('cash-buffer')) ??
    null;
  const conversionRecommendation =
    input.strategicPrepRecommendations.find((item) => item.id === 'roth-conversion-program') ?? null;

  const primaryCandidates = [
    buildSpendingActionCard({
      spendShortfallMonthly,
      recommendation: spendRecommendation,
    }),
    buildAcaActionCard({
      playbook: input.phasePlaybook,
      requiredMagiReduction,
      bridgeYear: acaBridgeMetrics?.bridgeYear ?? null,
      projectedMagi: acaBridgeMetrics?.projectedMagi ?? 0,
      acaFriendlyCeiling: acaBridgeMetrics?.acaFriendlyMagiCeiling ?? null,
    }),
    buildRunwayActionCard({
      playbook: input.phasePlaybook,
      runwayGapMonths,
      recommendation: runwayRecommendation,
    }),
    buildConversionActionCard(conversionRecommendation),
  ].filter((item): item is ExecutiveActionCard => Boolean(item));

  const existingIds = new Set(primaryCandidates.map((item) => item.id.replace(/^summary-/, '')));
  const fallbackCards = buildFallbackActionCards(input.strategicPrepRecommendations, existingIds);
  const actionCards = [...primaryCandidates, ...fallbackCards]
    .sort((left, right) => right.score - left.score)
    .slice(0, 3);

  const summary: ExecutiveFlightSummary = {
    headlineMetrics: {
      trackedNetWorth: roundMoney(trackedNetWorth),
      salaryEndDateIso: formatIsoDate(input.data.income.salaryEndDate),
      windfallTotal: roundMoney(windfallTotal),
      windfallCount: input.data.income.windfalls.length,
      firstWindfallYear,
      socialSecurityAnnualAtClaim,
    },
    planHealth: {
      successRate: input.evaluation?.summary.successRate ?? null,
      targetMonthlySpend: roundMoney(userTargetMonthlySpend),
      supportedMonthlySpend: roundMoney(supportedMonthlySpend),
      spendShortfallMonthly,
      acaBridgeYear: acaBridgeMetrics?.bridgeYear ?? null,
      acaRequiredMagiReduction: requiredMagiReduction,
      acaProjectedMagi: roundMoney(acaBridgeMetrics?.projectedMagi ?? 0),
      acaFriendlyCeiling: acaBridgeMetrics?.acaFriendlyMagiCeiling ?? null,
      runwayGapMonths,
    },
    narrative: {
      whereThingsStand: '',
      whatMattersNow: '',
    },
    actionCards,
  };

  summary.narrative = buildNarrative({ summary });
  return summary;
}
