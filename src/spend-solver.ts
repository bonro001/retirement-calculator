import type { MarketAssumptions, PathResult, SeedData } from './types';
import { buildPathResults, getAnnualStretchSpend } from './utils';

export type HousingFundingPolicy =
  | 'allow_primary_residence_sale'
  | 'do_not_sell_primary_residence';

export interface SpendSolverSuccessRange {
  min: number;
  max: number;
}

export interface SpendSolverInputs {
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressors: string[];
  selectedResponses: string[];
  targetLegacyTodayDollars: number;
  minSuccessRate: number;
  successRateRange?: SpendSolverSuccessRange;
  spendingFloorAnnual?: number;
  spendingCeilingAnnual?: number;
  toleranceAnnual?: number;
  maxIterations?: number;
  housingFundingPolicy?: HousingFundingPolicy;
}

export interface SpendSolverBand {
  lowerAnnual: number;
  targetAnnual: number;
  upperAnnual: number;
  lowerMonthly: number;
  targetMonthly: number;
  upperMonthly: number;
}

export interface SpendSolverResult {
  recommendedAnnualSpend: number;
  recommendedMonthlySpend: number;
  safeSpendingBand: SpendSolverBand;
  modeledSuccessRate: number;
  medianEndingWealth: number;
  projectedLegacyOutcomeTodayDollars: number;
  projectedLegacyOutcomeNominalDollars: number;
  targetLegacyTodayDollars: number;
  successBuffer: number;
  legacyBuffer: number;
  bindingConstraint: string;
  actionableExplanation: string;
  tradeoffExplanation: string;
  feasible: boolean;
  converged: boolean;
  nonConvergenceDetected: boolean;
  iterations: number;
  floorAnnual: number;
  ceilingAnnual: number;
}

interface SpendSolverEvaluation {
  annualSpend: number;
  monthlySpend: number;
  pathResult: PathResult;
  successRate: number;
  medianEndingWealth: number;
  projectedLegacyTodayDollars: number;
  annualFederalTaxEstimate: number;
  annualHealthcareCostEstimate: number;
}

interface SpendSolverConstraints {
  minSuccessRate: number;
  targetLegacyTodayDollars: number;
}

interface SearchOutcome {
  bestFeasible: SpendSolverEvaluation | null;
  bestClosest: SpendSolverEvaluation;
  iterations: number;
  converged: boolean;
}

const DEFAULT_TOLERANCE_ANNUAL = 250;
const DEFAULT_MAX_ITERATIONS = 22;
const CURRENCY_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});
const PERCENT_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'percent',
  maximumFractionDigits: 1,
});

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const roundCurrency = (value: number) => Math.round(value * 100) / 100;

function cloneSeedData(input: SeedData): SeedData {
  return JSON.parse(JSON.stringify(input)) as SeedData;
}

function formatCurrency(value: number) {
  return CURRENCY_FORMATTER.format(value);
}

function formatPercent(value: number) {
  return PERCENT_FORMATTER.format(value);
}

function normalizeSuccessRange(
  range: SpendSolverSuccessRange | undefined,
  minSuccessRate: number,
) {
  if (!range) {
    return undefined;
  }

  const min = clamp(Math.max(range.min, minSuccessRate), 0, 1);
  const max = clamp(Math.max(range.max, min), min, 1);
  return { min, max };
}

function withAnnualSpendTarget(data: SeedData, annualSpend: number): SeedData {
  const baselineAnnualSpend = getAnnualStretchSpend(data);
  if (!(baselineAnnualSpend > 0)) {
    return cloneSeedData(data);
  }

  const scale = Math.max(0, annualSpend) / baselineAnnualSpend;
  return {
    ...data,
    spending: {
      essentialMonthly: data.spending.essentialMonthly * scale,
      optionalMonthly: data.spending.optionalMonthly * scale,
      annualTaxesInsurance: data.spending.annualTaxesInsurance * scale,
      travelEarlyRetirementAnnual: data.spending.travelEarlyRetirementAnnual * scale,
    },
  };
}

function withHousingFundingPolicy(data: SeedData, policy: HousingFundingPolicy) {
  if (policy !== 'do_not_sell_primary_residence') {
    return data;
  }

  return {
    ...data,
    income: {
      ...data.income,
      windfalls: data.income.windfalls.map((windfall) =>
        windfall.name === 'home_sale'
          ? {
              ...windfall,
              amount: 0,
            }
          : windfall,
      ),
    },
  };
}

function withHousingPolicyResponses(
  selectedResponses: string[],
  policy: HousingFundingPolicy,
) {
  if (policy !== 'do_not_sell_primary_residence') {
    return selectedResponses;
  }

  return selectedResponses.filter((id) => id !== 'sell_home_early');
}

function getAverageAnnualHealthcareCost(pathResult: PathResult) {
  if (!pathResult.yearlySeries.length) {
    return 0;
  }
  const total = pathResult.yearlySeries.reduce(
    (sum, year) => sum + year.medianTotalHealthcarePremiumCost,
    0,
  );
  return total / pathResult.yearlySeries.length;
}

function toTodayDollars(
  nominalAmount: number,
  inflation: number,
  horizonYears: number,
) {
  const discountFactor = Math.pow(1 + Math.max(-0.99, inflation), Math.max(0, horizonYears));
  if (discountFactor <= 0) {
    return nominalAmount;
  }
  return nominalAmount / discountFactor;
}

function constraintGap(
  evaluation: SpendSolverEvaluation,
  constraints: SpendSolverConstraints,
) {
  const successGap = Math.max(0, constraints.minSuccessRate - evaluation.successRate);
  const legacyGap = Math.max(
    0,
    constraints.targetLegacyTodayDollars - evaluation.projectedLegacyTodayDollars,
  );
  const weightedGap =
    successGap * 2 + legacyGap / Math.max(1, constraints.targetLegacyTodayDollars);

  return { successGap, legacyGap, weightedGap };
}

function isFeasible(
  evaluation: SpendSolverEvaluation,
  constraints: SpendSolverConstraints,
) {
  return (
    evaluation.successRate >= constraints.minSuccessRate &&
    evaluation.projectedLegacyTodayDollars >= constraints.targetLegacyTodayDollars
  );
}

function selectCloserEvaluation(
  current: SpendSolverEvaluation,
  candidate: SpendSolverEvaluation,
  constraints: SpendSolverConstraints,
) {
  const currentGap = constraintGap(current, constraints);
  const candidateGap = constraintGap(candidate, constraints);
  if (candidateGap.weightedGap < currentGap.weightedGap) {
    return candidate;
  }
  if (candidateGap.weightedGap > currentGap.weightedGap) {
    return current;
  }
  return candidate.annualSpend >= current.annualSpend ? candidate : current;
}

function evaluateSpendCandidateFactory(input: SpendSolverInputs) {
  const cache = new Map<string, SpendSolverEvaluation>();
  const inflation = input.assumptions.inflation;
  const housingFundingPolicy = input.housingFundingPolicy ?? 'allow_primary_residence_sale';
  const housingAdjustedData = withHousingFundingPolicy(input.data, housingFundingPolicy);
  const housingAdjustedResponses = withHousingPolicyResponses(
    input.selectedResponses,
    housingFundingPolicy,
  );

  return (annualSpend: number): SpendSolverEvaluation => {
    const normalizedSpend = roundCurrency(Math.max(0, annualSpend));
    const key = normalizedSpend.toFixed(2);
    const cached = cache.get(key);
    if (cached) {
      return cached;
    }

    const spendAdjustedData = withAnnualSpendTarget(housingAdjustedData, normalizedSpend);
    const [pathResult] = buildPathResults(
      spendAdjustedData,
      input.assumptions,
      input.selectedStressors,
      housingAdjustedResponses,
      {
        pathMode: 'selected_only',
      },
    );

    const projectedLegacyTodayDollars = toTodayDollars(
      pathResult.medianEndingWealth,
      inflation,
      pathResult.monteCarloMetadata.planningHorizonYears,
    );
    const evaluation: SpendSolverEvaluation = {
      annualSpend: normalizedSpend,
      monthlySpend: normalizedSpend / 12,
      pathResult,
      successRate: pathResult.successRate,
      medianEndingWealth: pathResult.medianEndingWealth,
      projectedLegacyTodayDollars,
      annualFederalTaxEstimate: pathResult.annualFederalTaxEstimate,
      annualHealthcareCostEstimate: getAverageAnnualHealthcareCost(pathResult),
    };
    cache.set(key, evaluation);
    return evaluation;
  };
}

function solveForHighestFeasibleSpend(
  evaluate: (annualSpend: number) => SpendSolverEvaluation,
  floorAnnual: number,
  ceilingAnnual: number,
  constraints: SpendSolverConstraints,
  toleranceAnnual: number,
  maxIterations: number,
): SearchOutcome {
  const floor = roundCurrency(Math.max(0, Math.min(floorAnnual, ceilingAnnual)));
  const ceiling = roundCurrency(Math.max(floorAnnual, ceilingAnnual));
  const floorEvaluation = evaluate(floor);
  const ceilingEvaluation = evaluate(ceiling);

  let bestClosest = selectCloserEvaluation(floorEvaluation, ceilingEvaluation, constraints);
  let bestFeasible: SpendSolverEvaluation | null = null;

  if (isFeasible(floorEvaluation, constraints)) {
    bestFeasible = floorEvaluation;
  }
  if (isFeasible(ceilingEvaluation, constraints)) {
    return {
      bestFeasible: ceilingEvaluation,
      bestClosest: ceilingEvaluation,
      iterations: 1,
      converged: true,
    };
  }

  let left = floor;
  let right = ceiling;
  let iterations = 0;

  while (iterations < maxIterations) {
    const midpoint = roundCurrency((left + right) / 2);
    const evaluation = evaluate(midpoint);
    iterations += 1;
    bestClosest = selectCloserEvaluation(bestClosest, evaluation, constraints);

    if (isFeasible(evaluation, constraints)) {
      bestFeasible = evaluation;
      left = midpoint;
    } else {
      right = midpoint;
    }

    if (right - left <= toleranceAnnual) {
      break;
    }
  }

  const leftEvaluation = evaluate(left);
  const rightEvaluation = evaluate(right);
  bestClosest = selectCloserEvaluation(bestClosest, leftEvaluation, constraints);
  bestClosest = selectCloserEvaluation(bestClosest, rightEvaluation, constraints);
  if (isFeasible(leftEvaluation, constraints)) {
    bestFeasible = !bestFeasible || leftEvaluation.annualSpend > bestFeasible.annualSpend
      ? leftEvaluation
      : bestFeasible;
  }
  if (isFeasible(rightEvaluation, constraints)) {
    bestFeasible = !bestFeasible || rightEvaluation.annualSpend > bestFeasible.annualSpend
      ? rightEvaluation
      : bestFeasible;
  }

  return {
    bestFeasible,
    bestClosest,
    iterations,
    converged: right - left <= toleranceAnnual,
  };
}

function solveForSuccessRangeTarget(
  evaluate: (annualSpend: number) => SpendSolverEvaluation,
  floorAnnual: number,
  upperFeasibleAnnual: number,
  constraints: SpendSolverConstraints,
  successRange: SpendSolverSuccessRange,
  toleranceAnnual: number,
  maxIterations: number,
) {
  const targetSuccess = (successRange.min + successRange.max) / 2;
  let left = floorAnnual;
  let right = upperFeasibleAnnual;
  let bestInRange: SpendSolverEvaluation | null = null;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const midpoint = roundCurrency((left + right) / 2);
    const evaluation = evaluate(midpoint);
    if (isFeasible(evaluation, constraints)) {
      const inRange =
        evaluation.successRate >= successRange.min &&
        evaluation.successRate <= successRange.max;
      if (inRange) {
        if (!bestInRange) {
          bestInRange = evaluation;
        } else {
          const bestDistance = Math.abs(bestInRange.successRate - targetSuccess);
          const nextDistance = Math.abs(evaluation.successRate - targetSuccess);
          if (
            nextDistance < bestDistance ||
            (nextDistance === bestDistance &&
              evaluation.annualSpend > bestInRange.annualSpend)
          ) {
            bestInRange = evaluation;
          }
        }
      }
    }

    if (evaluation.successRate > targetSuccess) {
      left = midpoint;
    } else {
      right = midpoint;
    }

    if (right - left <= toleranceAnnual) {
      break;
    }
  }

  const leftEval = evaluate(left);
  const rightEval = evaluate(right);
  [leftEval, rightEval].forEach((evaluation) => {
    if (
      isFeasible(evaluation, constraints) &&
      evaluation.successRate >= successRange.min &&
      evaluation.successRate <= successRange.max
    ) {
      if (!bestInRange) {
        bestInRange = evaluation;
        return;
      }

      const bestDistance = Math.abs(bestInRange.successRate - targetSuccess);
      const nextDistance = Math.abs(evaluation.successRate - targetSuccess);
      if (
        nextDistance < bestDistance ||
        (nextDistance === bestDistance &&
          evaluation.annualSpend > bestInRange.annualSpend)
      ) {
        bestInRange = evaluation;
      }
    }
  });

  return bestInRange;
}

function describeConstraintFailure(
  evaluation: SpendSolverEvaluation,
  constraints: SpendSolverConstraints,
) {
  const successGap = constraints.minSuccessRate - evaluation.successRate;
  const legacyGap =
    constraints.targetLegacyTodayDollars - evaluation.projectedLegacyTodayDollars;

  if (successGap > 0 && legacyGap > 0) {
    return 'reduce projected success below the floor and legacy below target';
  }
  if (legacyGap > 0) {
    return 'reduce projected legacy below target';
  }
  if (successGap > 0) {
    return 'reduce success probability below the required floor';
  }
  return 'push the plan outside current guardrails';
}

function findIncreaseUntilConstraintBreach(
  evaluate: (annualSpend: number) => SpendSolverEvaluation,
  recommendedAnnual: number,
  ceilingAnnual: number,
  constraints: SpendSolverConstraints,
  toleranceAnnual: number,
  maxIterations: number,
) {
  if (recommendedAnnual >= ceilingAnnual) {
    return null;
  }

  const step = Math.max(1, toleranceAnnual);
  let low = recommendedAnnual;
  let high = Math.min(ceilingAnnual, recommendedAnnual + step);
  let highEvaluation = evaluate(high);

  if (isFeasible(highEvaluation, constraints)) {
    while (high < ceilingAnnual && isFeasible(highEvaluation, constraints)) {
      low = high;
      high = Math.min(ceilingAnnual, high + step);
      highEvaluation = evaluate(high);
    }
  }

  if (isFeasible(highEvaluation, constraints)) {
    return null;
  }

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    if (high - low <= 1) {
      break;
    }

    const midpoint = roundCurrency((low + high) / 2);
    const midpointEvaluation = evaluate(midpoint);
    if (isFeasible(midpointEvaluation, constraints)) {
      low = midpoint;
    } else {
      high = midpoint;
      highEvaluation = midpointEvaluation;
    }
  }

  return {
    deltaAnnual: Math.max(0, high - recommendedAnnual),
    violatedEvaluation: highEvaluation,
  };
}

function buildActionableExplanation({
  evaluate,
  recommended,
  lowerEvaluation,
  constraints,
  floorAnnual,
  ceilingAnnual,
  toleranceAnnual,
  maxIterations,
  feasible,
}: {
  evaluate: (annualSpend: number) => SpendSolverEvaluation;
  recommended: SpendSolverEvaluation;
  lowerEvaluation: SpendSolverEvaluation;
  constraints: SpendSolverConstraints;
  floorAnnual: number;
  ceilingAnnual: number;
  toleranceAnnual: number;
  maxIterations: number;
  feasible: boolean;
}) {
  const messages: string[] = [];
  const increaseCheck = findIncreaseUntilConstraintBreach(
    evaluate,
    recommended.annualSpend,
    ceilingAnnual,
    constraints,
    toleranceAnnual,
    maxIterations,
  );
  if (increaseCheck && increaseCheck.deltaAnnual > 0) {
    messages.push(
      `Increasing spending by ${formatCurrency(
        increaseCheck.deltaAnnual / 12,
      )}/month would ${describeConstraintFailure(
        increaseCheck.violatedEvaluation,
        constraints,
      )}.`,
    );
  } else if (recommended.annualSpend >= ceilingAnnual - toleranceAnnual) {
    messages.push('Upper spending cap is currently the limiting factor.');
  }

  const decreaseStepAnnual = Math.max(
    0,
    Math.min(
      Math.max(1, toleranceAnnual),
      recommended.annualSpend - floorAnnual,
    ),
  );
  if (decreaseStepAnnual > 0) {
    const lowerSpendEvaluation = evaluate(recommended.annualSpend - decreaseStepAnnual);
    const successDelta = lowerSpendEvaluation.successRate - recommended.successRate;
    const legacyDelta =
      lowerSpendEvaluation.projectedLegacyTodayDollars -
      recommended.projectedLegacyTodayDollars;
    if (successDelta > 0 || legacyDelta > 0) {
      messages.push(
        `Reducing spending by ${formatCurrency(
          decreaseStepAnnual / 12,
        )}/month would move success to ${formatPercent(
          lowerSpendEvaluation.successRate,
        )} and projected legacy to ${formatCurrency(
          lowerSpendEvaluation.projectedLegacyTodayDollars,
        )}.`,
      );
    }
  }

  if (!messages.length) {
    if (!feasible) {
      const gapDescription = describeConstraintFailure(recommended, constraints);
      messages.push(
        `No exact match was found inside current bounds; this result is the closest fit and would require lower spending to avoid outcomes that ${gapDescription}.`,
      );
    } else {
      messages.push(
        'Current spending sits near the active guardrails; small spending increases are likely to weaken success odds or legacy outcomes.',
      );
    }
  }

  if (recommended.annualSpend > lowerEvaluation.annualSpend + 1 && feasible) {
    messages.push(
      `The conservative lower-band spend of ${formatCurrency(
        lowerEvaluation.annualSpend,
      )} provides extra guardrail headroom.`,
    );
  }

  return messages.join(' ');
}

function buildTradeoffExplanation({
  recommended,
  lowerEvaluation,
}: {
  recommended: SpendSolverEvaluation;
  lowerEvaluation: SpendSolverEvaluation;
}) {
  const successDelta = lowerEvaluation.successRate - recommended.successRate;
  const taxDelta =
    recommended.annualFederalTaxEstimate - lowerEvaluation.annualFederalTaxEstimate;
  const healthcareDelta =
    recommended.annualHealthcareCostEstimate - lowerEvaluation.annualHealthcareCostEstimate;

  return `At ${formatCurrency(
    recommended.annualSpend,
  )}/year, modeled federal tax is about ${formatCurrency(
    recommended.annualFederalTaxEstimate,
  )} and healthcare premiums average ${formatCurrency(
    recommended.annualHealthcareCostEstimate,
  )} per year. Higher spending generally increases withdrawals, pushes tax and ACA/IRMAA exposure upward, and lowers success probability. A more conservative spend near ${formatCurrency(
    lowerEvaluation.annualSpend,
  )} improves success by about ${formatPercent(Math.max(0, successDelta))} while reducing annual tax by roughly ${formatCurrency(
    Math.max(0, taxDelta),
  )} and healthcare cost pressure by about ${formatCurrency(Math.max(0, healthcareDelta))}.`;
}

function buildConstraintExplanation({
  recommended,
  constraints,
  successRange,
  floorAnnual,
  ceilingAnnual,
  toleranceAnnual,
  feasible,
}: {
  recommended: SpendSolverEvaluation;
  constraints: SpendSolverConstraints;
  successRange?: SpendSolverSuccessRange;
  floorAnnual: number;
  ceilingAnnual: number;
  toleranceAnnual: number;
  feasible: boolean;
}) {
  if (recommended.annualSpend >= ceilingAnnual - toleranceAnnual) {
    return 'Upper spending cap limited the solution';
  }

  if (recommended.annualSpend <= floorAnnual + toleranceAnnual && !feasible) {
    return 'Spending floor limited the closest solution';
  }

  if (!feasible) {
    const shortSuccess = recommended.successRate < constraints.minSuccessRate;
    const shortLegacy =
      recommended.projectedLegacyTodayDollars < constraints.targetLegacyTodayDollars;
    if (shortSuccess && shortLegacy) {
      return 'No exact solution: both success-rate floor and legacy target are binding';
    }
    if (shortLegacy) {
      return 'No exact solution: legacy target is binding';
    }
    if (shortSuccess) {
      return 'No exact solution: success-rate floor is binding';
    }
    return 'No exact solution: constraints limited the result';
  }

  if (
    successRange &&
    recommended.successRate >= successRange.min &&
    recommended.successRate <= successRange.max
  ) {
    return 'Success-rate range target guided the solution';
  }

  const successSlack = recommended.successRate - constraints.minSuccessRate;
  const legacySlack = (
    recommended.projectedLegacyTodayDollars - constraints.targetLegacyTodayDollars
  ) / Math.max(1, constraints.targetLegacyTodayDollars);

  if (legacySlack <= successSlack) {
    return 'Legacy target is the binding constraint';
  }

  return 'Success-rate floor is the binding constraint';
}

export function solveSpendByReverseTimeline(input: SpendSolverInputs): SpendSolverResult {
  const currentAnnualSpend = getAnnualStretchSpend(input.data);
  const floorAnnual = roundCurrency(
    Math.max(0, input.spendingFloorAnnual ?? Math.max(currentAnnualSpend * 0.35, 1_000)),
  );
  const ceilingAnnual = roundCurrency(
    Math.max(floorAnnual, input.spendingCeilingAnnual ?? Math.max(currentAnnualSpend * 2.5, 1_000)),
  );
  const toleranceAnnual = roundCurrency(
    Math.max(10, input.toleranceAnnual ?? DEFAULT_TOLERANCE_ANNUAL),
  );
  const maxIterations = Math.max(6, input.maxIterations ?? DEFAULT_MAX_ITERATIONS);
  const normalizedRange = normalizeSuccessRange(input.successRateRange, input.minSuccessRate);
  const evaluate = evaluateSpendCandidateFactory(input);
  const baseConstraints: SpendSolverConstraints = {
    minSuccessRate: clamp(input.minSuccessRate, 0, 1),
    targetLegacyTodayDollars: Math.max(0, input.targetLegacyTodayDollars),
  };

  const baseSearch = solveForHighestFeasibleSpend(
    evaluate,
    floorAnnual,
    ceilingAnnual,
    baseConstraints,
    toleranceAnnual,
    maxIterations,
  );

  const nonConvergenceDetected = !baseSearch.converged;
  const upperEvaluation = baseSearch.bestFeasible;
  let recommended = upperEvaluation ?? baseSearch.bestClosest;
  let feasible = Boolean(upperEvaluation);

  if (upperEvaluation && normalizedRange) {
    const inRangeCandidate = solveForSuccessRangeTarget(
      evaluate,
      floorAnnual,
      upperEvaluation.annualSpend,
      baseConstraints,
      normalizedRange,
      toleranceAnnual,
      maxIterations,
    );
    if (inRangeCandidate) {
      recommended = inRangeCandidate;
    }
  }

  if (nonConvergenceDetected && upperEvaluation) {
    recommended = upperEvaluation;
    feasible = true;
  }

  let lowerEvaluation = recommended;
  if (upperEvaluation) {
    const conservativeSuccessFloor = normalizedRange
      ? normalizedRange.max
      : clamp(baseConstraints.minSuccessRate + 0.08, 0, 0.995);
    const conservativeSearch = solveForHighestFeasibleSpend(
      evaluate,
      floorAnnual,
      recommended.annualSpend,
      {
        ...baseConstraints,
        minSuccessRate: conservativeSuccessFloor,
      },
      toleranceAnnual,
      maxIterations,
    );
    if (conservativeSearch.bestFeasible) {
      lowerEvaluation = conservativeSearch.bestFeasible;
    }
  } else {
    feasible = isFeasible(recommended, baseConstraints);
  }

  const upperBandEvaluation = upperEvaluation ?? recommended;
  const recommendedAnnualSpend = roundCurrency(recommended.annualSpend);
  const recommendedMonthlySpend = roundCurrency(recommendedAnnualSpend / 12);
  const safeSpendingBand: SpendSolverBand = {
    lowerAnnual: roundCurrency(Math.min(lowerEvaluation.annualSpend, recommendedAnnualSpend)),
    targetAnnual: recommendedAnnualSpend,
    upperAnnual: roundCurrency(Math.max(upperBandEvaluation.annualSpend, recommendedAnnualSpend)),
    lowerMonthly: roundCurrency(Math.min(lowerEvaluation.annualSpend, recommendedAnnualSpend) / 12),
    targetMonthly: recommendedMonthlySpend,
    upperMonthly: roundCurrency(Math.max(upperBandEvaluation.annualSpend, recommendedAnnualSpend) / 12),
  };

  const successBuffer = recommended.successRate - baseConstraints.minSuccessRate;
  const legacyBuffer =
    recommended.projectedLegacyTodayDollars - baseConstraints.targetLegacyTodayDollars;

  const bindingConstraint = buildConstraintExplanation({
    recommended,
    constraints: baseConstraints,
    successRange: normalizedRange,
    floorAnnual,
    ceilingAnnual,
    toleranceAnnual,
    feasible,
  });
  const actionableExplanation = buildActionableExplanation({
    evaluate,
    recommended,
    lowerEvaluation,
    constraints: baseConstraints,
    floorAnnual,
    ceilingAnnual,
    toleranceAnnual,
    maxIterations,
    feasible,
  });
  const tradeoffExplanation = buildTradeoffExplanation({
    recommended,
    lowerEvaluation,
  });

  return {
    recommendedAnnualSpend,
    recommendedMonthlySpend,
    safeSpendingBand,
    modeledSuccessRate: recommended.successRate,
    medianEndingWealth: recommended.medianEndingWealth,
    projectedLegacyOutcomeTodayDollars: recommended.projectedLegacyTodayDollars,
    projectedLegacyOutcomeNominalDollars: recommended.pathResult.medianEndingWealth,
    targetLegacyTodayDollars: baseConstraints.targetLegacyTodayDollars,
    successBuffer,
    legacyBuffer,
    bindingConstraint,
    actionableExplanation,
    tradeoffExplanation,
    feasible,
    converged: baseSearch.converged,
    nonConvergenceDetected,
    iterations: baseSearch.iterations,
    floorAnnual,
    ceilingAnnual,
  };
}
