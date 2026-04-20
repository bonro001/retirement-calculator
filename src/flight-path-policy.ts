import type { PlanEvaluation } from './plan-evaluation';
import type { SeedData } from './types';
import { formatCurrency } from './utils';

export const FLIGHT_PATH_POLICY_VERSION = 'v0.1.0';

export type StrategicPrepPriority = 'now' | 'soon' | 'watch';

export interface StrategicPrepRecommendation {
  id: string;
  priority: StrategicPrepPriority;
  title: string;
  action: string;
  why: string;
  amountHint?: string;
}

export interface FlightPathPolicyInput {
  evaluation: PlanEvaluation | null;
  data: SeedData;
  nowYear?: number;
  maxRecommendations?: number;
}

export interface FlightPathPolicyResult {
  policyVersion: string;
  recommendations: StrategicPrepRecommendation[];
}

const DEFAULT_MAX_RECOMMENDATIONS = 6;

export function buildFlightPathStrategicPrepRecommendations(
  input: FlightPathPolicyInput,
): FlightPathPolicyResult {
  const recommendations: StrategicPrepRecommendation[] = [];
  const nowYear = input.nowYear ?? new Date().getFullYear();
  const maxRecommendations = Math.max(1, Math.round(input.maxRecommendations ?? DEFAULT_MAX_RECOMMENDATIONS));
  const autopilotYears = input.evaluation?.raw.run.autopilot.years ?? [];
  const nearYears = autopilotYears.filter((year) => year.year >= nowYear && year.year <= nowYear + 3);
  const firstNearYear = nearYears[0] ?? autopilotYears[0];

  if (input.evaluation) {
    const spendGapMonthly =
      input.evaluation.calibration.userTargetMonthlySpendNow -
      input.evaluation.calibration.supportedMonthlySpendNow;
    if (spendGapMonthly > 150) {
      recommendations.push({
        id: 'spend-gap-reduce',
        priority: 'now',
        title: 'Align spending to supported level',
        action: `Trim monthly spending by about ${formatCurrency(spendGapMonthly)} to match today's supported level.`,
        why: 'This closes the current funding gap and improves plan durability under the active guardrails.',
        amountHint: `${formatCurrency(spendGapMonthly)} per month reduction`,
      });
    } else if (spendGapMonthly < -150) {
      const room = Math.abs(spendGapMonthly);
      recommendations.push({
        id: 'spend-gap-room',
        priority: 'watch',
        title: 'You have near-term spending room',
        action: `You can increase monthly spending by up to about ${formatCurrency(room)} and stay inside the current supported path.`,
        why: 'The current plan run indicates over-reserved room relative to your stated target spend.',
        amountHint: `${formatCurrency(room)} per month potential increase`,
      });
    }
  }

  const essentialMonthlyWithFixed =
    input.data.spending.essentialMonthly + input.data.spending.annualTaxesInsurance / 12;
  const currentCash = input.data.accounts.cash.balance;
  const recommendedCashBuffer = essentialMonthlyWithFixed * 18;
  if (currentCash < recommendedCashBuffer * 0.9) {
    recommendations.push({
      id: 'cash-buffer-top-up',
      priority: 'now',
      title: 'Top up cash buffer runway',
      action: `Move about ${formatCurrency(recommendedCashBuffer - currentCash)} into cash to reach an 18-month essential runway.`,
      why: 'A stronger liquid buffer helps absorb early-sequence shocks without forcing poor-timing sales.',
      amountHint: `Current cash ${formatCurrency(currentCash)} vs target ${formatCurrency(recommendedCashBuffer)}`,
    });
  } else if (currentCash > recommendedCashBuffer * 1.6) {
    recommendations.push({
      id: 'cash-buffer-redeploy',
      priority: 'watch',
      title: 'Excess cash drag check',
      action: `Consider redeploying around ${formatCurrency(currentCash - recommendedCashBuffer)} from cash to your intended allocation.`,
      why: 'Large excess cash can reduce long-run supportable spending by lowering expected growth.',
      amountHint: `Cash above 18-month buffer: ${formatCurrency(currentCash - recommendedCashBuffer)}`,
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
    recommendations.push({
      id: 'irmaa-cap',
      priority: headroom <= 2_500 ? 'now' : 'soon',
      title: 'Set an IRMAA MAGI cap',
      action: `For tax year ${irmaaPressureYear.year - 2}, plan MAGI near ${formatCurrency(targetMagiCap)} and avoid crossing current IRMAA thresholds.`,
      why: 'Modeled Medicare surcharge pressure appears in your near-term route.',
      amountHint: `Approx MAGI reduction need: ${formatCurrency(reductionNeeded)}`,
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
    recommendations.push({
      id: 'aca-bridge-cap',
      priority: 'now',
      title: 'Protect ACA bridge eligibility',
      action: `In ${acaPressureYear.year}, keep MAGI near or below ${formatCurrency(
        acaPressureYear.acaFriendlyMagiCeiling,
      )} by shifting withdrawals away from ordinary-income sources where possible.`,
      why: 'Your modeled bridge year exceeds the subsidy-friendly MAGI zone.',
      amountHint: `Current modeled overage: ${formatCurrency(overage)}`,
    });
  }

  const plannedConversions = nearYears
    .map((year) => year.suggestedRothConversion)
    .filter((value) => value > 1_000);
  if (plannedConversions.length) {
    const averageConversion =
      plannedConversions.reduce((sum, value) => sum + value, 0) / plannedConversions.length;
    recommendations.push({
      id: 'roth-conversion-program',
      priority: 'soon',
      title: 'Run an annual Roth conversion program',
      action: `Plan annual conversions around ${formatCurrency(averageConversion)} while staying below ACA/IRMAA guardrails.`,
      why: 'Near-term conversion capacity appears in the current route and can reduce later forced-income pressure.',
      amountHint: `Average suggested conversion (${plannedConversions.length} yrs): ${formatCurrency(
        averageConversion,
      )}/yr`,
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
      recommendations.push({
        id: 'withdrawal-concentration',
        priority: 'watch',
        title: 'Balance withdrawal source concentration',
        action: `Current route leans heavily on ${dominant.key} (~${Math.round(
          (dominant.value / totalWithdrawals) * 100,
        )}% of ${firstNearYear.year} withdrawals). Keep source mix diversified to manage taxes and guardrail cliffs.`,
        why: 'Heavy reliance on one bucket can reduce flexibility when conditions change.',
        amountHint: `${formatCurrency(dominant.value)} from ${dominant.key} in ${firstNearYear.year}`,
      });
    }
  }

  if (input.evaluation?.calibration.nextUnlock) {
    recommendations.push({
      id: 'next-unlock',
      priority: input.evaluation.calibration.successConstraintBinding ? 'soon' : 'watch',
      title: 'Next unlock path',
      action: input.evaluation.calibration.nextUnlock,
      why:
        input.evaluation.calibration.successFloorRelaxationTradeoff ??
        'This is the modeled next lever with the best tradeoff for more supported spending.',
      amountHint: `Estimated monthly impact: ${formatCurrency(
        input.evaluation.calibration.nextUnlockImpactMonthly,
      )}`,
    });
  }

  const priorityOrder: Record<StrategicPrepPriority, number> = {
    now: 0,
    soon: 1,
    watch: 2,
  };

  return {
    policyVersion: FLIGHT_PATH_POLICY_VERSION,
    recommendations: recommendations
      .sort((left, right) => priorityOrder[left.priority] - priorityOrder[right.priority])
      .slice(0, maxRecommendations),
  };
}
