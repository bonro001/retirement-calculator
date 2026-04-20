import type { PlanEvaluation } from './plan-evaluation';
import type { MarketAssumptions, PathResult, SeedData } from './types';
import { buildPathResults, formatCurrency } from './utils';

export const FLIGHT_PATH_POLICY_VERSION = 'v0.2.0';

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
}

const DEFAULT_MAX_RECOMMENDATIONS = 6;
const DEFAULT_COUNTERFACTUAL_SIMULATION_RUNS = 72;

function cloneSeedData(data: SeedData): SeedData {
  return JSON.parse(JSON.stringify(data)) as SeedData;
}

function clampMin(value: number, minimum: number) {
  return value < minimum ? minimum : value;
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

function scoreConfidenceFromImpact(
  impact: StrategicPrepImpactEstimate | null,
  hasCounterfactual: boolean,
): StrategicPrepConfidence {
  if (!impact || !hasCounterfactual) {
    return {
      label: 'low',
      score: 0.25,
      rationale: 'No seeded counterfactual run was available for this recommendation.',
    };
  }

  const successSignal = Math.min(1, Math.abs(impact.successRateDelta) / 0.03);
  const spendSignal = Math.min(1, Math.abs(impact.supportedMonthlyDelta) / 400);
  const fundedSignal = Math.min(1, Math.abs(impact.yearsFundedDelta) / 2);
  const score = Number((0.45 * successSignal + 0.4 * spendSignal + 0.15 * fundedSignal).toFixed(2));

  if (score >= 0.7) {
    return {
      label: 'high',
      score,
      rationale: 'Counterfactual run shows a material, consistent impact in core plan metrics.',
    };
  }
  if (score >= 0.4) {
    return {
      label: 'medium',
      score,
      rationale: 'Counterfactual run shows moderate directional impact in core plan metrics.',
    };
  }
  return {
    label: 'low',
    score,
    rationale: 'Counterfactual run shows only small movement in core plan metrics.',
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
  estimatedImpact: StrategicPrepImpactEstimate | null;
  evidence: StrategicPrepEvidence;
  confidence: StrategicPrepConfidence;
} {
  const baselineSnapshot = toPathSnapshot(input.baselinePath);
  const runs = input.assumptions.simulationRuns;
  const seed = input.assumptions.simulationSeed ?? 20260416;

  if (!input.candidate.counterfactualPatch) {
    return {
      estimatedImpact: null,
      evidence: {
        baseline: baselineSnapshot,
        counterfactual: null,
        simulationRunsUsed: runs,
        simulationSeedUsed: seed,
        notes: ['No deterministic patch defined; recommendation remains directional.'],
      },
      confidence: scoreConfidenceFromImpact(null, false),
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

  return {
    estimatedImpact: impact,
    evidence: {
      baseline: baselineSnapshot,
      counterfactual: toPathSnapshot(counterfactualPath),
      simulationRunsUsed: runs,
      simulationSeedUsed: seed,
      notes: ['Impact estimated via seeded planner-enhanced path counterfactual.'],
    },
    confidence: scoreConfidenceFromImpact(impact, true),
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
    };
  }

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

  const enriched = candidates.map((candidate) => {
    const evaluated = evaluateCandidateCounterfactual({
      candidate,
      baselinePath,
      data: input.data,
      assumptions: counterfactualAssumptions,
      selectedStressors: input.selectedStressors,
      selectedResponses: input.selectedResponses,
    });
    return {
      id: candidate.id,
      priority: candidate.priority,
      title: candidate.title,
      action: candidate.action,
      triggerReason: candidate.triggerReason,
      estimatedImpact: evaluated.estimatedImpact,
      tradeoffs: candidate.tradeoffs,
      confidence: evaluated.confidence,
      evidence: evaluated.evidence,
      amountHint: candidate.amountHint,
    } satisfies StrategicPrepRecommendation;
  });

  const priorityOrder: Record<StrategicPrepPriority, number> = {
    now: 0,
    soon: 1,
    watch: 2,
  };

  return {
    policyVersion: FLIGHT_PATH_POLICY_VERSION,
    recommendations: enriched
      .sort((left, right) => {
        const priorityDelta = priorityOrder[left.priority] - priorityOrder[right.priority];
        if (priorityDelta !== 0) {
          return priorityDelta;
        }
        return right.confidence.score - left.confidence.score;
      })
      .slice(0, maxRecommendations),
  };
}
