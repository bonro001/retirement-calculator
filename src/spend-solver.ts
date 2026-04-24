import type { MarketAssumptions, PathResult, SeedData } from './types';
import { perfStart } from './debug-perf';
import {
  DEFAULT_TIME_PREFERENCE_WEIGHTS,
  computeTimeWeightedSpendingUtility,
  scoreUtilityWithLegacyTarget,
  type OptimizationObjective,
  type TimePreferenceWeights,
} from './optimization-objective';
import {
  getAnnualSpendingMinimums,
  getAnnualSpendingTargets,
  buildPathResults,
  calculateCurrentAges,
  getAnnualStretchSpend,
  getRetirementHorizonYears,
} from './utils';

export type HousingFundingPolicy =
  | 'allow_primary_residence_sale'
  | 'do_not_sell_primary_residence';

export type BindingGuardrail =
  | 'legacy_target'
  | 'success_floor'
  | 'ACA_affordability'
  | 'IRMAA_threshold'
  | 'tax_drag'
  | 'spending_floor'
  | 'keep_house'
  | 'no_inheritance'
  | 'allocation_locked';

export interface SpendSolverSuccessRange {
  min: number;
  max: number;
}

export interface SpendSolverInputs {
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressors: string[];
  selectedResponses: string[];
  optimizationObjective?: OptimizationObjective;
  timePreferenceWeights?: TimePreferenceWeights;
  targetLegacyTodayDollars: number;
  minSuccessRate: number;
  successRateRange?: SpendSolverSuccessRange;
  spendingFloorAnnual?: number;
  spendingCeilingAnnual?: number;
  spendingMinimums?: {
    essentialAnnualMinimum?: number;
    flexibleAnnualMinimum?: number;
    travelAnnualMinimum?: number;
  };
  toleranceAnnual?: number;
  maxIterations?: number;
  housingFundingPolicy?: HousingFundingPolicy;
  constraints?: {
    optimizationObjective?: OptimizationObjective;
    minimumSuccessRate?: number;
    minimumEndingWealth?: number;
    legacyFloorTodayDollars?: number;
    legacyTargetTodayDollars?: number;
    legacyTargetBandLowerTodayDollars?: number;
    legacyTargetBandUpperTodayDollars?: number;
    retainHouse?: boolean;
    essentialSpendingFloor?: number;
    inheritanceEnabled?: boolean;
    allocationLocked?: boolean;
  };
  skipSuccessFloorRelaxationProbe?: boolean;
  runtimeBudget?: {
    searchSimulationRuns?: number;
    finalSimulationRuns?: number;
    maxIterations?: number;
    diagnosticsMode?: 'core' | 'full';
    enableSuccessRelaxationProbe?: boolean;
  };
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
  activeOptimizationObjective: OptimizationObjective;
  supportedMonthlySpendNow: number;
  supportedAnnualSpendNow: number;
  supportedSpend60s: number;
  supportedSpend70s: number;
  supportedSpend80Plus: number;
  userTargetSpendNowMonthly: number;
  userTargetSpendNowAnnual: number;
  spendGapNowMonthly: number;
  spendGapNowAnnual: number;
  recommendedAnnualSpend: number;
  recommendedMonthlySpend: number;
  safeSpendingBand: SpendSolverBand;
  modeledSuccessRate: number;
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
  medianEndingWealth: number;
  p10EndingWealth: number;
  p90EndingWealth: number;
  p10EndingWealthTodayDollars: number;
  p90EndingWealthTodayDollars: number;
  endingWealthOneSigmaApproxTodayDollars: number;
  endingWealthOneSigmaLowerTodayDollars: number;
  endingWealthOneSigmaUpperTodayDollars: number;
  first10YearFailureRisk: number;
  annualFederalTaxEstimate: number;
  annualHealthcareCostEstimate: number;
  projectedLegacyOutcomeTodayDollars: number;
  projectedLegacyOutcomeNominalDollars: number;
  legacyFloorTodayDollars: number;
  legacyTargetBandLowerTodayDollars: number;
  legacyTargetBandUpperTodayDollars: number;
  legacyWithinTargetBand: boolean;
  targetLegacyTodayDollars: number;
  legacyTarget: number;
  projectedEndingWealth: number;
  distanceFromTarget: number;
  overTargetPenalty: number;
  isTargetBinding: boolean;
  ceilingUsed: number;
  ceilingIterations: number;
  finalBindingConstraint: string;
  legacyGapToTarget: number;
  overReservedAmount: number;
  legacyAttainmentMet: boolean;
  flexibleSpendingTarget: number;
  flexibleSpendingMinimum: number;
  travelSpendingTarget: number;
  travelSpendingMinimum: number;
  constrainedBySpendingFloors: boolean;
  constrainedByLegacyTarget: boolean;
  optimizationConstraintDriver:
    | 'legacy_target'
    | 'spending_floors'
    | 'success_floor'
    | 'ceiling_cap'
    | 'mixed_or_other';
  currentSpendingPath: Array<{ year: number; age: number; annualSpend: number }>;
  optimizedSpendingPath: Array<{ year: number; age: number; annualSpend: number }>;
  spendingDeltaByPhase: Array<{
    phase: 'go_go' | 'slow_go' | 'late';
    currentAnnual: number;
    optimizedAnnual: number;
    deltaAnnual: number;
  }>;
  successBuffer: number;
  legacyBuffer: number;
  bindingGuardrail: BindingGuardrail;
  bindingGuardrailExplanation: string;
  bindingConstraint: string;
  primaryTradeoff: string;
  whySupportedSpendIsNotHigher: string;
  surplusPreservedBecause: string;
  inheritanceMateriality: 'low' | 'medium' | 'high';
  houseRetentionContribution: string;
  endingWealthBreakdown: {
    median: number;
    p10: number;
    targetLegacyTodayDollars: number;
  };
  supportedSpendingSchedule: Array<{
    year: number;
    age: number;
    annualSpend: number;
    monthlySpend: number;
  }>;
  actionableExplanation: string;
  tradeoffExplanation: string;
  feasible: boolean;
  converged: boolean;
  nonConvergenceDetected: boolean;
  iterations: number;
  floorAnnual: number;
  ceilingAnnual: number;
  runtimeDiagnostics: {
    totalMs: number;
    searchPhaseMs: number;
    finalPhaseMs: number;
    diagnosticsPhaseMs: number;
    searchSimulationRuns: number;
    finalSimulationRuns: number;
    searchEvaluations: number;
    finalEvaluations: number;
    searchCacheHits: number;
    finalCacheHits: number;
    searchSimulationMs: number;
    finalSimulationMs: number;
    diagnosticsMode: 'core' | 'full';
  };
}

interface SpendSolverEvaluation {
  annualSpend: number;
  monthlySpend: number;
  annualSpendScheduleByYear?: Record<number, number>;
  optimizedSpendingPath?: Array<{ year: number; age: number; annualSpend: number }>;
  spendingDeltaByPhase?: SpendSolverResult['spendingDeltaByPhase'];
  utilityScore?: number;
  pathResult: PathResult;
  successRate: number;
  medianEndingWealth: number;
  projectedLegacyTodayDollars: number;
  annualFederalTaxEstimate: number;
  annualHealthcareCostEstimate: number;
}

interface SpendSolverConstraints {
  minSuccessRate: number;
  legacyFloorTodayDollars: number;
  legacyTargetTodayDollars: number;
  legacyTargetBandLowerTodayDollars: number;
  legacyTargetBandUpperTodayDollars: number;
}

interface SearchOutcome {
  bestFeasible: SpendSolverEvaluation | null;
  bestClosest: SpendSolverEvaluation;
  iterations: number;
  converged: boolean;
}

const DEFAULT_TOLERANCE_ANNUAL = 250;
const DEFAULT_MAX_ITERATIONS = 22;
const DEFAULT_OBJECTIVE: OptimizationObjective = 'maximize_time_weighted_spending';
const DEFAULT_LEGACY_TARGET_TOLERANCE_PERCENT = 0.05;
const NORMAL_IQR_TO_SIGMA = 1.3489795003921634;
const SUCCESS_FLOOR_UNLOCK_STEPS = [0.95, 0.9, 0.85] as const;
const PHASE_GRID = {
  goGo: [1, 1.15, 1.3],
  slowGo: [0.9, 1, 1.1],
  late: [0.75, 0.9, 1, 1.15],
};
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
const roundCount = (value: number) => Math.max(1, Math.round(value));

function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function cloneSeedData(input: SeedData): SeedData {
  return structuredClone(input) as SeedData;
}

function formatCurrency(value: number) {
  return CURRENCY_FORMATTER.format(value);
}

function formatPercent(value: number) {
  return PERCENT_FORMATTER.format(value);
}

function getNextRelaxedSuccessFloorTarget(currentMinSuccessRate: number) {
  const normalized = clamp(currentMinSuccessRate, 0, 1);
  return SUCCESS_FLOOR_UNLOCK_STEPS.find((candidate) => normalized > candidate) ?? null;
}

function toSupportedAnnualSpendNow(input: {
  annualSpend: number;
  annualFederalTaxEstimate: number;
  annualHealthcareCostEstimate: number;
  irmaaExposureRate: number;
  floorAnnual: number;
}) {
  const taxHealthcareDragAnnual =
    input.annualFederalTaxEstimate + input.annualHealthcareCostEstimate;
  const taxHealthcareDragRate =
    taxHealthcareDragAnnual / Math.max(1, input.annualSpend);
  const irmaaDragRate = input.irmaaExposureRate * 0.08;
  const supportedSpendAdjustmentRate = clamp(
    taxHealthcareDragRate * 0.16 + irmaaDragRate,
    0,
    0.22,
  );
  return roundCurrency(
    Math.max(input.floorAnnual, input.annualSpend * (1 - supportedSpendAdjustmentRate)),
  );
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

function resolveOptimizationObjective(input: SpendSolverInputs): OptimizationObjective {
  return (
    input.constraints?.optimizationObjective ??
    input.optimizationObjective ??
    DEFAULT_OBJECTIVE
  );
}

function toPhaseByAge(age: number): 'go_go' | 'slow_go' | 'late' {
  if (age < 70) {
    return 'go_go';
  }
  if (age < 80) {
    return 'slow_go';
  }
  return 'late';
}

function buildYearAgeTimeline(data: SeedData, assumptions: MarketAssumptions) {
  const ages = calculateCurrentAges(data);
  const horizonYears = getRetirementHorizonYears(data, assumptions);
  const startYear = new Date().getFullYear();
  return Array.from({ length: horizonYears + 1 }, (_, offset) => ({
    year: startYear + offset,
    age: ages.rob + offset,
  }));
}

function buildFlatSpendingPath(
  timeline: Array<{ year: number; age: number }>,
  annualSpend: number,
  minimumAnnualSpend = 0,
) {
  return timeline.map(({ year, age }) => ({
    year,
    age,
    annualSpend: roundCurrency(Math.max(minimumAnnualSpend, annualSpend)),
  }));
}

function buildPhaseSpendingPath(
  timeline: Array<{ year: number; age: number }>,
  baselineAnnualSpend: number,
  multipliers: { goGo: number; slowGo: number; late: number },
  scale: number,
  minimumAnnualSpend = 0,
) {
  return timeline.map(({ year, age }) => {
    const phase = toPhaseByAge(age);
    const phaseMultiplier =
      phase === 'go_go'
        ? multipliers.goGo
        : phase === 'slow_go'
          ? multipliers.slowGo
          : multipliers.late;
    return {
      year,
      age,
      annualSpend: roundCurrency(
        Math.max(minimumAnnualSpend, baselineAnnualSpend * phaseMultiplier * scale),
      ),
    };
  });
}

function toAnnualSpendScheduleByYear(
  path: Array<{ year: number; age: number; annualSpend: number }>,
) {
  return Object.fromEntries(path.map((point) => [point.year, point.annualSpend]));
}

function average(values: number[]) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarizePhaseDeltas(input: {
  currentPath: Array<{ year: number; age: number; annualSpend: number }>;
  optimizedPath: Array<{ year: number; age: number; annualSpend: number }>;
}): SpendSolverResult['spendingDeltaByPhase'] {
  const phaseKeys: Array<'go_go' | 'slow_go' | 'late'> = ['go_go', 'slow_go', 'late'];
  return phaseKeys.map((phase) => {
    const currentValues = input.currentPath
      .filter((point) => toPhaseByAge(point.age) === phase)
      .map((point) => point.annualSpend);
    const optimizedValues = input.optimizedPath
      .filter((point) => toPhaseByAge(point.age) === phase)
      .map((point) => point.annualSpend);
    const currentAnnual = roundCurrency(average(currentValues));
    const optimizedAnnual = roundCurrency(average(optimizedValues));
    return {
      phase,
      currentAnnual,
      optimizedAnnual,
      deltaAnnual: roundCurrency(optimizedAnnual - currentAnnual),
    };
  });
}

function getFirst10YearFailureRisk(pathResult: PathResult) {
  const startYear = new Date().getFullYear();
  const endYear = startYear + 9;
  return pathResult.failureYearDistribution
    .filter((point) => point.year <= endYear)
    .reduce((sum, point) => sum + point.rate, 0);
}

function toInheritanceMateriality(pathResult: PathResult): 'low' | 'medium' | 'high' {
  if (pathResult.inheritanceDependenceRate >= 0.45) {
    return 'high';
  }
  if (pathResult.inheritanceDependenceRate >= 0.2) {
    return 'medium';
  }
  return 'low';
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

function withInheritancePolicy(data: SeedData, inheritanceEnabled: boolean) {
  if (inheritanceEnabled) {
    return data;
  }

  return {
    ...data,
    income: {
      ...data.income,
      windfalls: data.income.windfalls.map((windfall) =>
        windfall.name === 'inheritance'
          ? {
              ...windfall,
              amount: 0,
            }
          : windfall,
      ),
    },
  };
}

interface SpendingComponentProfile {
  essentialTargetAnnual: number;
  flexibleTargetAnnual: number;
  travelTargetAnnual: number;
  taxesInsuranceTargetAnnual: number;
  essentialMinimumAnnual: number;
  flexibleMinimumAnnual: number;
  travelMinimumAnnual: number;
  taxesInsuranceMinimumAnnual: number;
  totalMinimumAnnual: number;
}

function resolveSpendingComponentProfile(input: SpendSolverInputs): SpendingComponentProfile {
  const targets = getAnnualSpendingTargets(input.data);
  const baselineMinimums = getAnnualSpendingMinimums(input.data, {
    essentialAnnualMinimum: input.spendingMinimums?.essentialAnnualMinimum,
    flexibleAnnualMinimum: input.spendingMinimums?.flexibleAnnualMinimum,
    travelAnnualMinimum: input.spendingMinimums?.travelAnnualMinimum,
  });
  const discretionaryBaseMinimum =
    baselineMinimums.flexibleAnnualMinimum + baselineMinimums.travelAnnualMinimum;
  const fixedMinimum =
    baselineMinimums.essentialAnnualMinimum + baselineMinimums.taxesInsuranceAnnualMinimum;
  const discretionaryTarget =
    targets.flexibleAnnual + targets.travelAnnual;
  const inferredDiscretionaryMinimum = Math.max(
    0,
    (input.spendingFloorAnnual ?? 0) - fixedMinimum,
  );
  const discretionaryMinimum = Math.min(
    discretionaryTarget,
    Math.max(discretionaryBaseMinimum, inferredDiscretionaryMinimum),
  );
  const additionalDiscretionaryMinimum = Math.max(
    0,
    discretionaryMinimum - discretionaryBaseMinimum,
  );
  const discretionaryTargetForSplit = Math.max(1, discretionaryTarget);
  const flexibleShare = targets.flexibleAnnual / discretionaryTargetForSplit;
  const travelShare = targets.travelAnnual / discretionaryTargetForSplit;
  const flexibleAnnualMinimum = Math.min(
    targets.flexibleAnnual,
    baselineMinimums.flexibleAnnualMinimum + additionalDiscretionaryMinimum * flexibleShare,
  );
  const travelAnnualMinimum = Math.min(
    targets.travelAnnual,
    baselineMinimums.travelAnnualMinimum + additionalDiscretionaryMinimum * travelShare,
  );
  const minimums = {
    ...baselineMinimums,
    flexibleAnnualMinimum,
    travelAnnualMinimum,
    totalAnnualMinimum:
      baselineMinimums.essentialAnnualMinimum +
      baselineMinimums.taxesInsuranceAnnualMinimum +
      flexibleAnnualMinimum +
      travelAnnualMinimum,
  };

  return {
    essentialTargetAnnual: targets.essentialAnnual,
    flexibleTargetAnnual: targets.flexibleAnnual,
    travelTargetAnnual: targets.travelAnnual,
    taxesInsuranceTargetAnnual: targets.taxesInsuranceAnnual,
    essentialMinimumAnnual: minimums.essentialAnnualMinimum,
    flexibleMinimumAnnual: minimums.flexibleAnnualMinimum,
    travelMinimumAnnual: minimums.travelAnnualMinimum,
    taxesInsuranceMinimumAnnual: minimums.taxesInsuranceAnnualMinimum,
    totalMinimumAnnual: minimums.totalAnnualMinimum,
  };
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
    constraints.legacyFloorTodayDollars - evaluation.projectedLegacyTodayDollars,
  );
  const weightedGap =
    successGap * 2 +
    legacyGap /
      Math.max(1, constraints.legacyFloorTodayDollars, constraints.legacyTargetTodayDollars);

  return { successGap, legacyGap, weightedGap };
}

function isFeasible(
  evaluation: SpendSolverEvaluation,
  constraints: SpendSolverConstraints,
) {
  return (
    evaluation.successRate >= constraints.minSuccessRate &&
    evaluation.projectedLegacyTodayDollars >= constraints.legacyFloorTodayDollars
  );
}

function getLegacyTargetTolerance(targetLegacyTodayDollars: number) {
  return Math.max(
    50_000,
    Math.max(0, targetLegacyTodayDollars) * DEFAULT_LEGACY_TARGET_TOLERANCE_PERCENT,
  );
}

function isWithinLegacyTargetBand(
  projectedLegacyTodayDollars: number,
  constraints: SpendSolverConstraints,
) {
  return (
    projectedLegacyTodayDollars >= constraints.legacyTargetBandLowerTodayDollars &&
    projectedLegacyTodayDollars <= constraints.legacyTargetBandUpperTodayDollars
  );
}

function getLegacyBandDistance(input: {
  projectedLegacyTodayDollars: number;
  constraints: SpendSolverConstraints;
}) {
  if (isWithinLegacyTargetBand(input.projectedLegacyTodayDollars, input.constraints)) {
    return 0;
  }
  if (input.projectedLegacyTodayDollars < input.constraints.legacyTargetBandLowerTodayDollars) {
    return input.constraints.legacyTargetBandLowerTodayDollars - input.projectedLegacyTodayDollars;
  }
  return input.projectedLegacyTodayDollars - input.constraints.legacyTargetBandUpperTodayDollars;
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

function selectPreferredFeasibleByObjective(
  current: SpendSolverEvaluation | null,
  candidate: SpendSolverEvaluation,
  objective: OptimizationObjective,
  constraints: SpendSolverConstraints,
) {
  if (!current) {
    return candidate;
  }

  if (objective === 'maximize_time_weighted_spending') {
    const currentLegacyScore = scoreUtilityWithLegacyTarget({
      baseUtility: current.utilityScore ?? 0,
      projectedEndingWealthTodayDollars: current.projectedLegacyTodayDollars,
      legacyTargetTodayDollars: constraints.legacyTargetTodayDollars,
    });
    const candidateLegacyScore = scoreUtilityWithLegacyTarget({
      baseUtility: candidate.utilityScore ?? 0,
      projectedEndingWealthTodayDollars: candidate.projectedLegacyTodayDollars,
      legacyTargetTodayDollars: constraints.legacyTargetTodayDollars,
    });
    const currentWithinBand = isWithinLegacyTargetBand(
      current.projectedLegacyTodayDollars,
      constraints,
    );
    const candidateWithinBand = isWithinLegacyTargetBand(
      candidate.projectedLegacyTodayDollars,
      constraints,
    );
    if (candidateWithinBand !== currentWithinBand) {
      return candidateWithinBand ? candidate : current;
    }
    if (
      !candidateWithinBand &&
      !currentWithinBand
    ) {
      const currentBandDistance = getLegacyBandDistance({
        projectedLegacyTodayDollars: current.projectedLegacyTodayDollars,
        constraints,
      });
      const candidateBandDistance = getLegacyBandDistance({
        projectedLegacyTodayDollars: candidate.projectedLegacyTodayDollars,
        constraints,
      });
      if (candidateBandDistance !== currentBandDistance) {
        return candidateBandDistance < currentBandDistance ? candidate : current;
      }
    }

    const currentHorizonYears = Math.max(1, current.pathResult.monteCarloMetadata.planningHorizonYears);
    const candidateHorizonYears = Math.max(1, candidate.pathResult.monteCarloMetadata.planningHorizonYears);
    const currentGuardrailPenalty =
      current.annualFederalTaxEstimate * currentHorizonYears * 0.22 +
      current.annualHealthcareCostEstimate * currentHorizonYears * 0.27 +
      current.pathResult.irmaaExposureRate * currentHorizonYears * 4_500;
    const candidateGuardrailPenalty =
      candidate.annualFederalTaxEstimate * candidateHorizonYears * 0.22 +
      candidate.annualHealthcareCostEstimate * candidateHorizonYears * 0.27 +
      candidate.pathResult.irmaaExposureRate * candidateHorizonYears * 4_500;
    const currentScore = currentLegacyScore.compositeScore - currentGuardrailPenalty;
    const candidateScore = candidateLegacyScore.compositeScore - candidateGuardrailPenalty;

    if (candidateScore !== currentScore) {
      return candidateScore > currentScore ? candidate : current;
    }

    if (
      Math.abs(candidateLegacyScore.distanceToTarget) <
      Math.abs(currentLegacyScore.distanceToTarget)
    ) {
      return candidate;
    }
  }

  if (candidate.annualSpend > current.annualSpend) {
    return candidate;
  }
  if (candidate.annualSpend < current.annualSpend) {
    return current;
  }

  return candidate.successRate >= current.successRate ? candidate : current;
}

function evaluateSpendCandidateFactory(input: SpendSolverInputs) {
  const diagnosticsMode = input.runtimeBudget?.diagnosticsMode ?? 'full';
  const baseSimulationRuns = roundCount(input.assumptions.simulationRuns);
  const requestedSearchRuns = roundCount(
    input.runtimeBudget?.searchSimulationRuns ?? baseSimulationRuns,
  );
  const requestedFinalRuns = roundCount(
    input.runtimeBudget?.finalSimulationRuns ?? baseSimulationRuns,
  );
  const finalSimulationRuns = Math.max(requestedSearchRuns, requestedFinalRuns);
  const searchSimulationRuns = Math.min(requestedSearchRuns, finalSimulationRuns);
  const searchAssumptions =
    input.assumptions.simulationRuns === searchSimulationRuns
      ? input.assumptions
      : {
          ...input.assumptions,
          simulationRuns: searchSimulationRuns,
        };
  const finalAssumptions =
    searchSimulationRuns === finalSimulationRuns
      ? searchAssumptions
      : {
          ...input.assumptions,
          simulationRuns: finalSimulationRuns,
        };
  const flatCaches = {
    search: new Map<string, SpendSolverEvaluation>(),
    final: new Map<string, SpendSolverEvaluation>(),
  };
  const scheduleCaches = {
    search: new Map<string, SpendSolverEvaluation>(),
    final: new Map<string, SpendSolverEvaluation>(),
  };
  const runtimeStats = {
    searchEvaluations: 0,
    finalEvaluations: 0,
    searchCacheHits: 0,
    finalCacheHits: 0,
    searchSimulationMs: 0,
    finalSimulationMs: 0,
  };
  const inflation = input.assumptions.inflation;
  const housingFundingPolicy = input.constraints?.retainHouse
    ? 'do_not_sell_primary_residence'
    : input.housingFundingPolicy ?? 'allow_primary_residence_sale';
  const inheritanceEnabled = input.constraints?.inheritanceEnabled ?? true;
  const inheritanceAdjustedData = withInheritancePolicy(input.data, inheritanceEnabled);
  const housingAdjustedData = withHousingFundingPolicy(
    inheritanceAdjustedData,
    housingFundingPolicy,
  );
  const housingAdjustedResponses = withHousingPolicyResponses(
    input.selectedResponses,
    housingFundingPolicy,
  );
  const timeline = buildYearAgeTimeline(input.data, input.assumptions);
  const spendingProfile = resolveSpendingComponentProfile(input);
  const baselineAnnualSpend = spendingProfile.essentialTargetAnnual +
    spendingProfile.flexibleTargetAnnual +
    spendingProfile.travelTargetAnnual +
    spendingProfile.taxesInsuranceTargetAnnual;
  const currentSpendingPath = buildFlatSpendingPath(
    timeline,
    baselineAnnualSpend,
    spendingProfile.totalMinimumAnnual,
  );
  const objective = resolveOptimizationObjective(input);
  const weights = input.timePreferenceWeights ?? DEFAULT_TIME_PREFERENCE_WEIGHTS;
  const minimumAcceptableAnnualSpend = Math.max(
    0,
    spendingProfile.totalMinimumAnnual,
    input.spendingFloorAnnual ?? 0,
    input.constraints?.essentialSpendingFloor ?? 0,
  );

  const evaluatePathWithFidelity = (
    fidelity: 'search' | 'final',
    annualSpendPath: Array<{ year: number; age: number; annualSpend: number }>,
  ) => {
    const cache = scheduleCaches[fidelity];
    const spendScheduleByYear = toAnnualSpendScheduleByYear(annualSpendPath);
    const key = JSON.stringify(spendScheduleByYear);
    const cached = cache.get(key);
    if (cached) {
      if (fidelity === 'search') {
        runtimeStats.searchCacheHits += 1;
      } else {
        runtimeStats.finalCacheHits += 1;
      }
      return cached;
    }
    if (fidelity === 'search') {
      runtimeStats.searchEvaluations += 1;
    } else {
      runtimeStats.finalEvaluations += 1;
    }

    const simulationStartedAt = nowMs();
    const [pathResult] = buildPathResults(
      housingAdjustedData,
      fidelity === 'search' ? searchAssumptions : finalAssumptions,
      input.selectedStressors,
      housingAdjustedResponses,
      {
        pathMode: 'selected_only',
        annualSpendScheduleByYear: spendScheduleByYear,
      },
    );
    const simulationElapsedMs = nowMs() - simulationStartedAt;
    if (fidelity === 'search') {
      runtimeStats.searchSimulationMs += simulationElapsedMs;
    } else {
      runtimeStats.finalSimulationMs += simulationElapsedMs;
    }

    const projectedLegacyTodayDollars = toTodayDollars(
      pathResult.medianEndingWealth,
      inflation,
      pathResult.monteCarloMetadata.planningHorizonYears,
    );
    const spendingByYear = annualSpendPath.map((point) => point.annualSpend);
    const agesByYear = annualSpendPath.map((point) => point.age);
    const utilityScore =
      computeTimeWeightedSpendingUtility({
        agesByYear,
        spendingByYear,
        weights,
        scope: 'discretionary_above_essential_floor',
        essentialFloorByYear: annualSpendPath.map(() => minimumAcceptableAnnualSpend),
      }) / Math.max(1, agesByYear.length);
    const evaluation: SpendSolverEvaluation = {
      annualSpend: roundCurrency(average(spendingByYear)),
      monthlySpend: roundCurrency(average(spendingByYear) / 12),
      annualSpendScheduleByYear: spendScheduleByYear,
      optimizedSpendingPath: annualSpendPath,
      pathResult,
      successRate: pathResult.successRate,
      medianEndingWealth: pathResult.medianEndingWealth,
      projectedLegacyTodayDollars,
      annualFederalTaxEstimate: pathResult.annualFederalTaxEstimate,
      annualHealthcareCostEstimate: getAverageAnnualHealthcareCost(pathResult),
      utilityScore,
    };
    cache.set(key, evaluation);
    return evaluation;
  };

  const evaluateFlatWithFidelity = (
    fidelity: 'search' | 'final',
    annualSpend: number,
  ): SpendSolverEvaluation => {
    const cache = flatCaches[fidelity];
    const normalizedSpend = roundCurrency(Math.max(0, annualSpend));
    const key = normalizedSpend.toFixed(2);
    const cached = cache.get(key);
    if (cached) {
      if (fidelity === 'search') {
        runtimeStats.searchCacheHits += 1;
      } else {
        runtimeStats.finalCacheHits += 1;
      }
      return cached;
    }
    if (fidelity === 'search') {
      runtimeStats.searchEvaluations += 1;
    } else {
      runtimeStats.finalEvaluations += 1;
    }

    const spendAdjustedData = withAnnualSpendTarget(housingAdjustedData, normalizedSpend);
    const simulationStartedAt = nowMs();
    const [pathResult] = buildPathResults(
      spendAdjustedData,
      fidelity === 'search' ? searchAssumptions : finalAssumptions,
      input.selectedStressors,
      housingAdjustedResponses,
      {
        pathMode: 'selected_only',
      },
    );
    const simulationElapsedMs = nowMs() - simulationStartedAt;
    if (fidelity === 'search') {
      runtimeStats.searchSimulationMs += simulationElapsedMs;
    } else {
      runtimeStats.finalSimulationMs += simulationElapsedMs;
    }

    const projectedLegacyTodayDollars = toTodayDollars(
      pathResult.medianEndingWealth,
      inflation,
      pathResult.monteCarloMetadata.planningHorizonYears,
    );
    const flatPath = buildFlatSpendingPath(
      timeline,
      normalizedSpend,
      minimumAcceptableAnnualSpend,
    );
    const evaluation: SpendSolverEvaluation = {
      annualSpend: normalizedSpend,
      monthlySpend: normalizedSpend / 12,
      annualSpendScheduleByYear: toAnnualSpendScheduleByYear(flatPath),
      optimizedSpendingPath: flatPath,
      pathResult,
      successRate: pathResult.successRate,
      medianEndingWealth: pathResult.medianEndingWealth,
      projectedLegacyTodayDollars,
      annualFederalTaxEstimate: pathResult.annualFederalTaxEstimate,
      annualHealthcareCostEstimate: getAverageAnnualHealthcareCost(pathResult),
      utilityScore:
        computeTimeWeightedSpendingUtility({
          agesByYear: flatPath.map((point) => point.age),
          spendingByYear: flatPath.map((point) => point.annualSpend),
          weights,
          scope: 'discretionary_above_essential_floor',
          essentialFloorByYear: flatPath.map(() => minimumAcceptableAnnualSpend),
        }) / Math.max(1, flatPath.length),
    };
    cache.set(key, evaluation);
    return evaluation;
  };

  return {
    evaluateFlatSearch: (annualSpend: number) => evaluateFlatWithFidelity('search', annualSpend),
    evaluateFlatFinal: (annualSpend: number) => evaluateFlatWithFidelity('final', annualSpend),
    evaluatePathSearch: (
      annualSpendPath: Array<{ year: number; age: number; annualSpend: number }>,
    ) => evaluatePathWithFidelity('search', annualSpendPath),
    evaluatePathFinal: (
      annualSpendPath: Array<{ year: number; age: number; annualSpend: number }>,
    ) => evaluatePathWithFidelity('final', annualSpendPath),
    timeline,
    currentSpendingPath,
    baselineAnnualSpend,
    spendingProfile,
    minimumAcceptableAnnualSpend,
    objective,
    weights,
    housingFundingPolicy,
    diagnosticsMode,
    searchSimulationRuns,
    finalSimulationRuns,
    runtimeStats,
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
  if (!bestFeasible && !isFeasible(ceilingEvaluation, constraints)) {
    const floorGap = constraintGap(floorEvaluation, constraints);
    const ceilingGap = constraintGap(ceilingEvaluation, constraints);
    if (ceilingGap.weightedGap >= floorGap.weightedGap) {
      return {
        bestFeasible: null,
        bestClosest: floorEvaluation,
        iterations: 1,
        converged: true,
      };
    }
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

function solveForTimeWeightedSpend(
  input: {
    evaluatePath: (
      annualSpendPath: Array<{ year: number; age: number; annualSpend: number }>,
    ) => SpendSolverEvaluation;
    evaluateFlat: (annualSpend: number) => SpendSolverEvaluation;
    timeline: Array<{ year: number; age: number }>;
    baselineAnnualSpend: number;
    constraints: SpendSolverConstraints;
    minimumAnnualSpend: number;
    floorAnnual: number;
    ceilingAnnual: number;
    maxIterations: number;
    diagnosticsMode: 'core' | 'full';
  },
): SearchOutcome {
  const maxEvaluations =
    input.diagnosticsMode === 'core'
      ? Math.max(14, input.maxIterations * 5)
      : Math.max(20, input.maxIterations * 8);
  let iterations = 0;
  const baselineEvaluation = input.evaluateFlat(input.baselineAnnualSpend);
  let bestClosest = baselineEvaluation;
  let bestFeasible: SpendSolverEvaluation | null = isFeasible(baselineEvaluation, input.constraints)
    ? baselineEvaluation
    : null;

  outer: for (const goGo of PHASE_GRID.goGo) {
    for (const slowGo of PHASE_GRID.slowGo) {
      for (const late of PHASE_GRID.late) {
        const unscaledPath = buildPhaseSpendingPath(
          input.timeline,
          input.baselineAnnualSpend,
          { goGo, slowGo, late },
          1,
          input.minimumAnnualSpend,
        );
        const unscaledAverage = average(unscaledPath.map((point) => point.annualSpend));
        if (!(unscaledAverage > 0)) {
          continue;
        }

        const minScale = Math.max(0.2, input.floorAnnual / unscaledAverage);
        const maxScale = Math.max(minScale, input.ceilingAnnual / unscaledAverage);
        const scaleSteps = input.diagnosticsMode === 'core' ? 5 : 7;
        let pruneHigherScales = false;

        for (let scaleIndex = 0; scaleIndex < scaleSteps; scaleIndex += 1) {
          if (pruneHigherScales) {
            break;
          }
          if (iterations >= maxEvaluations) {
            break outer;
          }

          const ratio = scaleIndex / (scaleSteps - 1);
          const scale = minScale + (maxScale - minScale) * ratio;
          const scaledPath = buildPhaseSpendingPath(
            input.timeline,
            input.baselineAnnualSpend,
            { goGo, slowGo, late },
            scale,
            input.minimumAnnualSpend,
          );
          const evaluation = input.evaluatePath(scaledPath);
          iterations += 1;

          bestClosest = selectCloserEvaluation(bestClosest, evaluation, input.constraints);
          if (isFeasible(evaluation, input.constraints)) {
            bestFeasible = selectPreferredFeasibleByObjective(
              bestFeasible,
              evaluation,
              'maximize_time_weighted_spending',
              input.constraints,
            );
          } else if (scaleIndex >= 1) {
            const gaps = constraintGap(evaluation, input.constraints);
            const severeLegacyShortfall =
              gaps.legacyGap >
              Math.max(50_000, input.constraints.legacyFloorTodayDollars * 0.06);
            const severeSuccessShortfall = gaps.successGap > 0.03;
            if (severeLegacyShortfall || severeSuccessShortfall) {
              // Scale increases only push spend higher, so once materially infeasible we can prune.
              pruneHigherScales = true;
            }
          }
        }
      }
    }
  }

  return {
    bestFeasible,
    bestClosest,
    iterations,
    converged: iterations < maxEvaluations,
  };
}

function describeConstraintFailure(
  evaluation: SpendSolverEvaluation,
  constraints: SpendSolverConstraints,
) {
  const successGap = constraints.minSuccessRate - evaluation.successRate;
  const legacyGap =
    constraints.legacyFloorTodayDollars - evaluation.projectedLegacyTodayDollars;

  if (successGap > 0 && legacyGap > 0) {
    return 'reduce projected success below the floor and legacy below the configured floor';
  }
  if (legacyGap > 0) {
    return 'reduce projected legacy below the configured floor';
  }
  if (successGap > 0) {
    return 'reduce success probability below the required floor';
  }
  return 'push the plan outside current guardrails';
}

interface GuardrailProbeInputs {
  baseline: SpendSolverEvaluation;
  probe: SpendSolverEvaluation | null;
  constraints: SpendSolverConstraints;
  floorAnnual: number;
  ceilingAnnual: number;
  recommendedAnnualSpend: number;
  toleranceAnnual: number;
  retainHouse: boolean;
  inheritanceEnabled: boolean;
  allocationLocked: boolean;
}

export function determineBindingGuardrailFromProbe(
  input: GuardrailProbeInputs,
): { bindingGuardrail: BindingGuardrail; bindingGuardrailExplanation: string } {
  const atUpperCap =
    input.recommendedAnnualSpend >= input.ceilingAnnual - input.toleranceAnnual;
  if (atUpperCap) {
    return {
      bindingGuardrail: 'tax_drag',
      bindingGuardrailExplanation:
        'The configured spending cap is currently limiting additional supported spending.',
    };
  }

  const nearFloor = input.recommendedAnnualSpend <= input.floorAnnual + input.toleranceAnnual;
  if (!input.probe) {
    if (nearFloor) {
      return {
        bindingGuardrail: 'spending_floor',
        bindingGuardrailExplanation:
          'Spending is already near the configured floor, so there is little room to reduce or rebalance spending further.',
      };
    }
    return {
      bindingGuardrail: 'success_floor',
      bindingGuardrailExplanation:
        'The plan is close to its current success guardrail, limiting additional supported spending.',
      };
  }

  const successShortfall =
    input.constraints.minSuccessRate - input.probe.successRate;
  const legacyShortfall =
    input.constraints.legacyFloorTodayDollars -
    input.probe.projectedLegacyTodayDollars;
  const irmaaDelta =
    input.probe.pathResult.irmaaExposureRate -
    input.baseline.pathResult.irmaaExposureRate;
  const taxDelta =
    input.probe.annualFederalTaxEstimate - input.baseline.annualFederalTaxEstimate;
  const healthcareDelta =
    input.probe.annualHealthcareCostEstimate - input.baseline.annualHealthcareCostEstimate;
  const baselineAcaCost = input.baseline.pathResult.yearlySeries.reduce(
    (sum, year) => sum + year.medianNetAcaCost,
    0,
  );
  const probeAcaCost = input.probe.pathResult.yearlySeries.reduce(
    (sum, year) => sum + year.medianNetAcaCost,
    0,
  );
  const acaDelta = probeAcaCost - baselineAcaCost;

  const successShortfallPct = Math.max(0, successShortfall);
  const legacyShortfallPct = Math.max(
    0,
    legacyShortfall / Math.max(1, input.constraints.legacyFloorTodayDollars),
  );

  if (legacyShortfallPct > 0 || successShortfallPct > 0) {
    if (legacyShortfallPct >= successShortfallPct) {
      return {
        bindingGuardrail: 'legacy_target',
        bindingGuardrailExplanation:
          'Increasing spending further would push projected ending wealth below the legacy floor.',
      };
    }
    return {
      bindingGuardrail: 'success_floor',
      bindingGuardrailExplanation:
        'Increasing spending further would drop success probability below the required floor.',
    };
  }

  if (acaDelta > Math.max(2_000, input.probe.annualSpend * 0.02)) {
    return {
      bindingGuardrail: 'ACA_affordability',
      bindingGuardrailExplanation:
        'ACA affordability is limiting additional spending; extra withdrawals increase projected pre-Medicare premium burden.',
    };
  }

  if (irmaaDelta > 0.03) {
    return {
      bindingGuardrail: 'IRMAA_threshold',
      bindingGuardrailExplanation:
        'IRMAA thresholds are limiting additional withdrawals during Medicare years.',
    };
  }

  if (taxDelta + healthcareDelta > Math.max(3_000, input.probe.annualSpend * 0.025)) {
    return {
      bindingGuardrail: 'tax_drag',
      bindingGuardrailExplanation:
        'Tax and healthcare drag rises materially with additional spending, limiting supported spend.',
    };
  }

  if (nearFloor) {
    return {
      bindingGuardrail: 'spending_floor',
      bindingGuardrailExplanation:
        'Spending-floor settings are constraining flexibility at the current plan level.',
    };
  }

  if (input.retainHouse) {
    return {
      bindingGuardrail: 'keep_house',
      bindingGuardrailExplanation:
        'Keeping the primary residence unsold reduces liquidity headroom and limits additional supported spending.',
    };
  }

  if (!input.inheritanceEnabled) {
    return {
      bindingGuardrail: 'no_inheritance',
      bindingGuardrailExplanation:
        'With inheritance disabled, the plan has less future liquidity support for higher current spending.',
    };
  }

  if (input.allocationLocked) {
    return {
      bindingGuardrail: 'allocation_locked',
      bindingGuardrailExplanation:
        'Locked allocation settings reduce the planner’s ability to rebalance risk/return for higher spending support.',
    };
  }

  return {
    bindingGuardrail: 'tax_drag',
    bindingGuardrailExplanation:
      'Additional spending is mainly absorbed by higher tax and withdrawal drag under current assumptions.',
  };
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
      recommended.projectedLegacyTodayDollars < constraints.legacyFloorTodayDollars;
    if (shortSuccess && shortLegacy) {
      return 'No exact solution: both success-rate floor and legacy floor are binding';
    }
    if (shortLegacy) {
      return 'No exact solution: legacy floor is binding';
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
  const legacySlack = getLegacyBandDistance({
    projectedLegacyTodayDollars: recommended.projectedLegacyTodayDollars,
    constraints,
  }) / Math.max(1, constraints.legacyTargetTodayDollars);

  if (legacySlack <= successSlack) {
    return 'Legacy floor/target band is the binding constraint';
  }

  return 'Success-rate floor is the binding constraint';
}

function toSurplusPreservedBecause(input: {
  objective: OptimizationObjective;
  bindingConstraint: string;
  feasible: boolean;
  overReservedAmount: number;
}) {
  if (!input.feasible) {
    return 'Current guardrails are tighter than the requested spend path, so surplus is retained to avoid infeasible outcomes.';
  }

  if (input.bindingConstraint.toLowerCase().includes('legacy')) {
    return 'Legacy floor/target band is active, so the optimizer preserves additional ending wealth.';
  }
  if (input.bindingConstraint.toLowerCase().includes('success')) {
    return 'Success floor is active, so the optimizer preserves extra wealth as a resilience buffer.';
  }
  if (input.bindingConstraint.toLowerCase().includes('cap')) {
    return 'Configured spend ceiling capped the optimization before surplus could be fully consumed.';
  }

  if (input.objective === 'maximize_time_weighted_spending') {
    if (input.overReservedAmount > 0) {
      return 'The optimizer shifted spend earlier while retaining guardrail buffer for success, taxes, and healthcare threshold risk.';
    }
    return 'The optimizer prioritized present spending while still keeping guardrails intact.';
  }
  return 'Current constraints leave residual ending wealth in median outcomes.';
}

function toOptimizationConstraintDriver(
  bindingConstraint: string,
): SpendSolverResult['optimizationConstraintDriver'] {
  const normalized = bindingConstraint.toLowerCase();
  if (normalized.includes('legacy')) {
    return 'legacy_target';
  }
  if (normalized.includes('spending floor')) {
    return 'spending_floors';
  }
  if (normalized.includes('success')) {
    return 'success_floor';
  }
  if (normalized.includes('cap')) {
    return 'ceiling_cap';
  }
  return 'mixed_or_other';
}

function toFinalBindingConstraint(input: {
  bindingConstraint: string;
  bindingGuardrail: BindingGuardrail;
  isCeilingBound: boolean;
  ceilingIsArtificial: boolean;
}) {
  const normalized = input.bindingConstraint.toLowerCase();
  if (input.isCeilingBound && input.ceilingIsArtificial) {
    return 'upper_spending_cap';
  }
  if (normalized.includes('legacy') || input.bindingGuardrail === 'legacy_target') {
    return 'legacy_target';
  }
  if (normalized.includes('success') || input.bindingGuardrail === 'success_floor') {
    return 'success_floor';
  }
  if (normalized.includes('spending floor') || input.bindingGuardrail === 'spending_floor') {
    return 'spending_floor';
  }
  if (input.bindingGuardrail === 'ACA_affordability') {
    return 'aca_affordability';
  }
  if (input.bindingGuardrail === 'IRMAA_threshold') {
    return 'irmaa_threshold';
  }
  if (input.bindingGuardrail === 'tax_drag') {
    return 'tax_drag';
  }
  if (input.bindingGuardrail === 'keep_house') {
    return 'keep_house';
  }
  if (input.bindingGuardrail === 'no_inheritance') {
    return 'no_inheritance';
  }
  if (input.bindingGuardrail === 'allocation_locked') {
    return 'allocation_locked';
  }
  return 'mixed_or_other';
}

function toPrimaryTradeoff(input: {
  bindingConstraint: string;
  annualFederalTaxEstimate: number;
  annualHealthcareCostEstimate: number;
  irmaaExposureRate: number;
  overReservedAmount: number;
}): string {
  const normalized = input.bindingConstraint.toLowerCase();
  if (normalized.includes('legacy')) {
    return 'Higher spending now versus staying inside the legacy floor and target band.';
  }
  if (normalized.includes('success')) {
    return 'Higher spending now versus maintaining the required success floor.';
  }
  if (normalized.includes('spending floor')) {
    return 'Current lifestyle minimums are limiting how far spending can be reduced.';
  }

  const irmaaSignal =
    input.irmaaExposureRate > 0.2 ? 'IRMAA exposure' : 'tax and healthcare drag';
  if (input.overReservedAmount > 0) {
    return `Present spending is balanced against ${irmaaSignal} and legacy over-reserve reduction.`;
  }
  return `Present spending is balanced against ${irmaaSignal} and downside resilience.`;
}

function toWhySupportedSpendIsNotHigher(input: {
  bindingConstraint: string;
  annualFederalTaxEstimate: number;
  annualHealthcareCostEstimate: number;
  irmaaExposureRate: number;
  overReservedAmount: number;
}): string {
  const normalized = input.bindingConstraint.toLowerCase();
  if (normalized.includes('legacy')) {
    return `Raising spend further would likely push projected legacy below the configured legacy floor/band. Current tax drag is about ${formatCurrency(
      input.annualFederalTaxEstimate,
    )}/yr and healthcare premium drag is about ${formatCurrency(
      input.annualHealthcareCostEstimate,
    )}/yr.`;
  }
  if (normalized.includes('success')) {
    return `Raising spend further would likely push success below the required floor. Current tax drag is about ${formatCurrency(
      input.annualFederalTaxEstimate,
    )}/yr and healthcare premium drag is about ${formatCurrency(
      input.annualHealthcareCostEstimate,
    )}/yr.`;
  }
  const irmaaText =
    input.irmaaExposureRate > 0
      ? `IRMAA exposure appears in ${(input.irmaaExposureRate * 100).toFixed(0)}% of runs`
      : 'IRMAA exposure remains limited in this run';
  if (input.overReservedAmount > 0) {
    return `Supported spend is capped by guardrails even though the plan remains over-reserved by ${formatCurrency(
      input.overReservedAmount,
    )}. ${irmaaText}, with taxes and healthcare costs absorbing additional income headroom.`;
  }
  return `Supported spend is capped by active guardrails. ${irmaaText}, with taxes and healthcare costs absorbing additional income headroom.`;
}

export function solveSpendByReverseTimeline(input: SpendSolverInputs): SpendSolverResult {
  const solverStartedAt = nowMs();
  const objective = resolveOptimizationObjective(input);
  const finishPerf = perfStart('solver', 'solve-spend', {
    objective,
    stressorCount: input.selectedStressors.length,
    responseCount: input.selectedResponses.length,
  });
  const evaluator = evaluateSpendCandidateFactory(input);
  const diagnosticsMode = evaluator.diagnosticsMode;
  const searchPhaseStartedAt = nowMs();
  const currentAnnualSpend = evaluator.baselineAnnualSpend;
  const explicitFloor =
    input.constraints?.essentialSpendingFloor ??
    input.spendingFloorAnnual ??
    evaluator.minimumAcceptableAnnualSpend;
  const floorAnnual = roundCurrency(
    Math.max(
      0,
      evaluator.minimumAcceptableAnnualSpend,
      explicitFloor ?? Math.max(currentAnnualSpend * 0.35, 1_000),
    ),
  );
  const initialCeilingAnnual = roundCurrency(
    Math.max(floorAnnual, input.spendingCeilingAnnual ?? Math.max(currentAnnualSpend * 2.5, 1_000)),
  );
  const toleranceAnnual = roundCurrency(
    Math.max(10, input.toleranceAnnual ?? DEFAULT_TOLERANCE_ANNUAL),
  );
  const maxIterations = Math.max(
    6,
    input.runtimeBudget?.maxIterations ?? input.maxIterations ?? DEFAULT_MAX_ITERATIONS,
  );
  const minSuccessRate = clamp(
    input.constraints?.minimumSuccessRate ?? input.minSuccessRate,
    0,
    1,
  );
  const legacyTargetTodayDollars = Math.max(
    0,
    input.constraints?.legacyTargetTodayDollars ?? input.targetLegacyTodayDollars,
  );
  const legacyTargetBandHalfWidth = getLegacyTargetTolerance(legacyTargetTodayDollars);
  const defaultLegacyFloorTodayDollars = Math.max(
    0,
    legacyTargetTodayDollars - legacyTargetBandHalfWidth,
  );
  const legacyFloorTodayDollars = Math.max(
    0,
    Math.min(
      legacyTargetTodayDollars,
      input.constraints?.legacyFloorTodayDollars ??
        input.constraints?.minimumEndingWealth ??
        defaultLegacyFloorTodayDollars,
    ),
  );
  const legacyTargetBandLowerTodayDollars = Math.max(
    legacyFloorTodayDollars,
    input.constraints?.legacyTargetBandLowerTodayDollars ??
      (legacyTargetTodayDollars - legacyTargetBandHalfWidth),
  );
  const legacyTargetBandUpperTodayDollars = Math.max(
    legacyTargetBandLowerTodayDollars,
    input.constraints?.legacyTargetBandUpperTodayDollars ??
      (legacyTargetTodayDollars + legacyTargetBandHalfWidth),
  );
  const normalizedRange = normalizeSuccessRange(input.successRateRange, minSuccessRate);
  const evaluateFlatSearch = evaluator.evaluateFlatSearch;
  const evaluateFlatFinal = evaluator.evaluateFlatFinal;
  const baseConstraints: SpendSolverConstraints = {
    minSuccessRate,
    legacyFloorTodayDollars,
    legacyTargetTodayDollars,
    legacyTargetBandLowerTodayDollars,
    legacyTargetBandUpperTodayDollars,
  };
  let ceilingAnnual = initialCeilingAnnual;
  let expansionSteps = 0;
  let ceilingExpansionBlockedByGuardrail = false;
  let baseSearch =
    objective === 'maximize_time_weighted_spending'
      ? solveForTimeWeightedSpend({
          evaluatePath: evaluator.evaluatePathSearch,
          evaluateFlat: evaluateFlatSearch,
          timeline: evaluator.timeline,
          baselineAnnualSpend: evaluator.baselineAnnualSpend,
          constraints: baseConstraints,
          minimumAnnualSpend: evaluator.minimumAcceptableAnnualSpend,
          floorAnnual,
          ceilingAnnual,
          maxIterations,
          diagnosticsMode,
        })
      : solveForHighestFeasibleSpend(
          evaluateFlatSearch,
          floorAnnual,
          ceilingAnnual,
          baseConstraints,
          toleranceAnnual,
          maxIterations,
        );
  let nonConvergenceDetected = !baseSearch.converged;
  let upperEvaluation = baseSearch.bestFeasible;
  let recommended = upperEvaluation ?? baseSearch.bestClosest;
  let feasible = isFeasible(recommended, baseConstraints);

  if (objective === 'maximize_time_weighted_spending') {
    const maxCeilingExpansionSteps = Math.max(12, maxIterations * 6);
    while (
      expansionSteps < maxCeilingExpansionSteps &&
      recommended.annualSpend >= ceilingAnnual - toleranceAnnual
    ) {
      const probeSpend = roundCurrency(
        recommended.annualSpend + Math.max(toleranceAnnual, recommended.annualSpend * 0.01),
      );
      const probeEvaluation = evaluateFlatSearch(probeSpend);
      if (!isFeasible(probeEvaluation, baseConstraints)) {
        ceilingExpansionBlockedByGuardrail = true;
        break;
      }

      const targetGap =
        recommended.projectedLegacyTodayDollars -
        baseConstraints.legacyTargetBandUpperTodayDollars;
      const remainingYears = Math.max(
        1,
        recommended.pathResult.monteCarloMetadata.planningHorizonYears,
      );
      const approxRequiredAnnualIncrease = roundCurrency(
        Math.max(
          toleranceAnnual,
          targetGap > 0 ? targetGap / remainingYears : recommended.annualSpend * 0.02,
        ),
      );
      const nextCeilingAnnual = roundCurrency(
        Math.max(
          ceilingAnnual + toleranceAnnual,
          recommended.annualSpend + approxRequiredAnnualIncrease * 1.05,
          probeSpend + approxRequiredAnnualIncrease * 0.5,
        ),
      );
      if (nextCeilingAnnual <= ceilingAnnual + 1) {
        break;
      }

      ceilingAnnual = nextCeilingAnnual;
      const expandedSearch = solveForTimeWeightedSpend({
        evaluatePath: evaluator.evaluatePathSearch,
        evaluateFlat: evaluateFlatSearch,
        timeline: evaluator.timeline,
        baselineAnnualSpend: evaluator.baselineAnnualSpend,
        constraints: baseConstraints,
        minimumAnnualSpend: evaluator.minimumAcceptableAnnualSpend,
        floorAnnual,
        ceilingAnnual,
        maxIterations,
        diagnosticsMode,
      });
      baseSearch = expandedSearch;
      nonConvergenceDetected = nonConvergenceDetected || !expandedSearch.converged;
      upperEvaluation = expandedSearch.bestFeasible;
      recommended = upperEvaluation ?? expandedSearch.bestClosest;
      feasible = isFeasible(recommended, baseConstraints);
      expansionSteps += 1;
    }
  }

  if (upperEvaluation && normalizedRange && objective !== 'maximize_time_weighted_spending') {
    const inRangeCandidate = solveForSuccessRangeTarget(
      evaluateFlatSearch,
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
      evaluateFlatSearch,
      floorAnnual,
      recommended.annualSpend,
      {
        ...baseConstraints,
        minSuccessRate: conservativeSuccessFloor,
      },
      toleranceAnnual,
      diagnosticsMode === 'core' ? Math.min(maxIterations, 8) : maxIterations,
    );
    if (conservativeSearch.bestFeasible) {
      lowerEvaluation = conservativeSearch.bestFeasible;
    }
  } else {
    feasible = isFeasible(recommended, baseConstraints);
  }
  const searchPhaseMs = Number((nowMs() - searchPhaseStartedAt).toFixed(1));
  const finalPhaseStartedAt = nowMs();

  const evaluateWithFinalBudget = (evaluation: SpendSolverEvaluation) => {
    if (objective === 'maximize_time_weighted_spending' && evaluation.optimizedSpendingPath) {
      return evaluator.evaluatePathFinal(evaluation.optimizedSpendingPath);
    }
    return evaluateFlatFinal(evaluation.annualSpend);
  };
  recommended = evaluateWithFinalBudget(recommended);
  if (upperEvaluation) {
    upperEvaluation = evaluateWithFinalBudget(upperEvaluation);
  }
  lowerEvaluation = evaluateWithFinalBudget(lowerEvaluation);
  feasible = isFeasible(recommended, baseConstraints);
  if (!feasible) {
    const fallbackSearch = solveForHighestFeasibleSpend(
      evaluateFlatFinal,
      floorAnnual,
      recommended.annualSpend,
      baseConstraints,
      toleranceAnnual,
      Math.min(8, maxIterations),
    );
    if (fallbackSearch.bestFeasible) {
      recommended = fallbackSearch.bestFeasible;
      feasible = true;
    }
  }
  const finalPhaseMs = Number((nowMs() - finalPhaseStartedAt).toFixed(1));

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
    recommended.projectedLegacyTodayDollars - baseConstraints.legacyTargetTodayDollars;
  const legacyGapToTarget = legacyBuffer;
  const overReservedAmount = Math.max(0, legacyGapToTarget);
  const supportedAnnualSpendNow = toSupportedAnnualSpendNow({
    annualSpend: recommendedAnnualSpend,
    annualFederalTaxEstimate: recommended.annualFederalTaxEstimate,
    annualHealthcareCostEstimate: recommended.annualHealthcareCostEstimate,
    irmaaExposureRate: recommended.pathResult.irmaaExposureRate,
    floorAnnual,
  });
  const supportedMonthlySpendNow = roundCurrency(supportedAnnualSpendNow / 12);
  const bindingProbeAnnualSpend = roundCurrency(
    Math.min(
      ceilingAnnual,
      recommendedAnnualSpend + Math.max(toleranceAnnual, recommendedAnnualSpend * 0.01),
    ),
  );
  const bindingProbeEvaluation =
    bindingProbeAnnualSpend > recommendedAnnualSpend + 0.5
      ? evaluateFlatFinal(bindingProbeAnnualSpend)
      : null;
  const { bindingGuardrail, bindingGuardrailExplanation } =
    determineBindingGuardrailFromProbe({
      baseline: recommended,
      probe: bindingProbeEvaluation,
      constraints: baseConstraints,
      floorAnnual,
      ceilingAnnual,
      recommendedAnnualSpend,
      toleranceAnnual,
      retainHouse: input.constraints?.retainHouse ?? false,
      inheritanceEnabled: input.constraints?.inheritanceEnabled ?? true,
      allocationLocked: input.constraints?.allocationLocked ?? false,
    });
  const legacyTargetScore = scoreUtilityWithLegacyTarget({
    baseUtility: recommended.utilityScore ?? 0,
    projectedEndingWealthTodayDollars: recommended.projectedLegacyTodayDollars,
    legacyTargetTodayDollars: baseConstraints.legacyTargetTodayDollars,
  });
  const distanceFromTarget = legacyTargetScore.distanceToTarget;
  const overTargetPenalty = legacyTargetScore.overTargetPenalty;
  const legacyWithinTargetBand = isWithinLegacyTargetBand(
    recommended.projectedLegacyTodayDollars,
    baseConstraints,
  );
  const isCeilingBoundAtResult =
    recommendedAnnualSpend >= ceilingAnnual - toleranceAnnual;
  const bindingConstraint = buildConstraintExplanation({
    recommended,
    constraints: baseConstraints,
    successRange: normalizedRange,
    floorAnnual,
    ceilingAnnual,
    toleranceAnnual,
    feasible,
  });
  const finalBindingConstraint = toFinalBindingConstraint({
    bindingConstraint,
    bindingGuardrail,
    isCeilingBound: isCeilingBoundAtResult,
    ceilingIsArtificial: !ceilingExpansionBlockedByGuardrail,
  });
  const successConstraintBinding =
    bindingGuardrail === 'success_floor' ||
    bindingConstraint.toLowerCase().includes('success-rate floor');
  const minimumSuccessRateTarget = baseConstraints.minSuccessRate;
  const achievedSuccessRate = recommended.successRate;
  let supportedSpendIfSuccessFloorRelaxed = supportedAnnualSpendNow;
  let successFloorRelaxationTarget: number | null = null;
  let successFloorRelaxationDeltaAnnual = 0;
  let successFloorRelaxationDeltaMonthly = 0;
  let successFloorRelaxationTradeoff: string | null = null;
  let successFloorNextUnlock: string | null = null;
  const allowSuccessRelaxationProbe =
    (input.runtimeBudget?.enableSuccessRelaxationProbe ?? true) &&
    diagnosticsMode !== 'core';
  if (
    successConstraintBinding &&
    !input.skipSuccessFloorRelaxationProbe &&
    allowSuccessRelaxationProbe
  ) {
    const relaxedTarget = getNextRelaxedSuccessFloorTarget(baseConstraints.minSuccessRate);
    if (relaxedTarget !== null) {
      const relaxedConstraints = input.constraints
        ? {
            ...input.constraints,
            minimumSuccessRate: relaxedTarget,
          }
        : undefined;
      const relaxedProbe = solveSpendByReverseTimeline({
        ...input,
        minSuccessRate: relaxedTarget,
        successRateRange: undefined,
        constraints: relaxedConstraints,
        skipSuccessFloorRelaxationProbe: true,
        runtimeBudget: {
          ...input.runtimeBudget,
          searchSimulationRuns: Math.min(evaluator.searchSimulationRuns, 72),
          finalSimulationRuns: Math.min(evaluator.finalSimulationRuns, 120),
          maxIterations: Math.max(6, Math.floor(maxIterations * 0.6)),
          diagnosticsMode: 'core',
        },
      });
      const rawAnnualDelta =
        relaxedProbe.supportedAnnualSpendNow - supportedAnnualSpendNow;
      successFloorRelaxationTarget = relaxedTarget;
      supportedSpendIfSuccessFloorRelaxed = roundCurrency(
        Math.max(supportedAnnualSpendNow, relaxedProbe.supportedAnnualSpendNow),
      );
      successFloorRelaxationDeltaAnnual = roundCurrency(Math.max(0, rawAnnualDelta));
      successFloorRelaxationDeltaMonthly = roundCurrency(
        successFloorRelaxationDeltaAnnual / 12,
      );
      successFloorRelaxationTradeoff =
        `Lowering success floor from ${formatPercent(
          minimumSuccessRateTarget,
        )} to ${formatPercent(relaxedTarget)} can raise supported spend by about ${formatCurrency(
          successFloorRelaxationDeltaMonthly,
        )}/month, while modeled success shifts from ${formatPercent(
          achievedSuccessRate,
        )} to ${formatPercent(relaxedProbe.modeledSuccessRate)} and projected legacy moves from ${formatCurrency(
          recommended.projectedLegacyTodayDollars,
        )} to ${formatCurrency(relaxedProbe.projectedLegacyOutcomeTodayDollars)}.`;
      successFloorNextUnlock =
        `Lower success floor from ${Math.round(minimumSuccessRateTarget * 100)}% to ${Math.round(
          relaxedTarget * 100,
        )}% (about ${formatCurrency(successFloorRelaxationDeltaMonthly)}/month more supported spending).`;
    }
  }
  const supportedSpendAtCurrentSuccessFloor = supportedAnnualSpendNow;
  const isTargetBinding =
    bindingGuardrail === 'legacy_target' || legacyWithinTargetBand;
  const diagnosticsPhaseStartedAt = nowMs();
  const actionableExplanation =
    diagnosticsMode === 'core'
      ? 'Diagnostics detail reduced for interactive runtime budget; binding guardrail and next unlock remain active.'
      : buildActionableExplanation({
          evaluate: evaluateFlatFinal,
          recommended,
          lowerEvaluation,
          constraints: baseConstraints,
          floorAnnual,
          ceilingAnnual,
          toleranceAnnual,
          maxIterations: Math.min(maxIterations, 12),
          feasible,
        });
  const tradeoffExplanation = buildTradeoffExplanation({
    recommended,
    lowerEvaluation,
  });
  const currentSpendingPath = evaluator.currentSpendingPath;
  const optimizedSpendingPath =
    recommended.optimizedSpendingPath ??
    buildFlatSpendingPath(
      evaluator.timeline,
      recommendedAnnualSpend,
      evaluator.minimumAcceptableAnnualSpend,
    );
  const spendingDeltaByPhase = summarizePhaseDeltas({
    currentPath: currentSpendingPath,
    optimizedPath: optimizedSpendingPath,
  });
  const supportedScale = supportedAnnualSpendNow / Math.max(1, recommendedAnnualSpend);
  const supportedSpend60s = roundCurrency(
    (spendingDeltaByPhase.find((phase) => phase.phase === 'go_go')?.optimizedAnnual ??
      recommendedAnnualSpend) * supportedScale,
  );
  const supportedSpend70s = roundCurrency(
    (spendingDeltaByPhase.find((phase) => phase.phase === 'slow_go')?.optimizedAnnual ??
      recommendedAnnualSpend) * supportedScale,
  );
  const supportedSpend80Plus = roundCurrency(
    (spendingDeltaByPhase.find((phase) => phase.phase === 'late')?.optimizedAnnual ??
      recommendedAnnualSpend) * supportedScale,
  );
  const p10EndingWealth = recommended.pathResult.endingWealthPercentiles.p10;
  const p90EndingWealth = recommended.pathResult.endingWealthPercentiles.p90;
  const p25EndingWealth = recommended.pathResult.endingWealthPercentiles.p25;
  const p75EndingWealth = recommended.pathResult.endingWealthPercentiles.p75;
  const planningHorizonYears = recommended.pathResult.monteCarloMetadata.planningHorizonYears;
  const p10EndingWealthTodayDollars = toTodayDollars(
    p10EndingWealth,
    input.assumptions.inflation,
    planningHorizonYears,
  );
  const p90EndingWealthTodayDollars = toTodayDollars(
    p90EndingWealth,
    input.assumptions.inflation,
    planningHorizonYears,
  );
  const p25EndingWealthTodayDollars = toTodayDollars(
    p25EndingWealth,
    input.assumptions.inflation,
    planningHorizonYears,
  );
  const p75EndingWealthTodayDollars = toTodayDollars(
    p75EndingWealth,
    input.assumptions.inflation,
    planningHorizonYears,
  );
  const endingWealthOneSigmaApproxTodayDollars = roundCurrency(
    Math.max(
      0,
      (p75EndingWealthTodayDollars - p25EndingWealthTodayDollars) /
        NORMAL_IQR_TO_SIGMA,
    ),
  );
  const endingWealthOneSigmaLowerTodayDollars = roundCurrency(
    Math.max(
      0,
      recommended.projectedLegacyTodayDollars - endingWealthOneSigmaApproxTodayDollars,
    ),
  );
  const endingWealthOneSigmaUpperTodayDollars = roundCurrency(
    recommended.projectedLegacyTodayDollars + endingWealthOneSigmaApproxTodayDollars,
  );
  const first10YearFailureRisk = getFirst10YearFailureRisk(recommended.pathResult);
  const inheritanceMateriality = toInheritanceMateriality(recommended.pathResult);
  const houseRetentionContribution =
    evaluator.housingFundingPolicy === 'do_not_sell_primary_residence'
      ? 'Primary residence sale is disabled, which limits available liquidity and keeps more wealth tied up in housing.'
      : recommended.pathResult.homeSaleDependenceRate >= 0.25
        ? 'Home-sale proceeds contribute meaningfully to staying within the current guardrails.'
        : 'Home-sale proceeds are not a primary dependency in this run.';
  const surplusPreservedBecause = toSurplusPreservedBecause({
    objective,
    bindingConstraint,
    feasible,
    overReservedAmount,
  });
  const legacyAttainmentMet =
    recommended.projectedLegacyTodayDollars >= baseConstraints.legacyFloorTodayDollars;
  const optimizationConstraintDriver = toOptimizationConstraintDriver(bindingConstraint);
  const constrainedBySpendingFloors =
    optimizationConstraintDriver === 'spending_floors';
  const constrainedByLegacyTarget =
    optimizationConstraintDriver === 'legacy_target';
  const userTargetSpendNowAnnual = roundCurrency(evaluator.baselineAnnualSpend);
  const userTargetSpendNowMonthly = roundCurrency(userTargetSpendNowAnnual / 12);
  const spendGapNowAnnual = roundCurrency(supportedAnnualSpendNow - userTargetSpendNowAnnual);
  const spendGapNowMonthly = roundCurrency(supportedMonthlySpendNow - userTargetSpendNowMonthly);
  const primaryTradeoff = toPrimaryTradeoff({
    bindingConstraint,
    annualFederalTaxEstimate: recommended.annualFederalTaxEstimate,
    annualHealthcareCostEstimate: recommended.annualHealthcareCostEstimate,
    irmaaExposureRate: recommended.pathResult.irmaaExposureRate,
    overReservedAmount,
  });
  const whySupportedSpendIsNotHigher = toWhySupportedSpendIsNotHigher({
    bindingConstraint,
    annualFederalTaxEstimate: recommended.annualFederalTaxEstimate,
    annualHealthcareCostEstimate: recommended.annualHealthcareCostEstimate,
    irmaaExposureRate: recommended.pathResult.irmaaExposureRate,
    overReservedAmount,
  });
  const supportedSpendingSchedule = optimizedSpendingPath.map((point) => {
    const scaledAnnual = roundCurrency(
      Math.max(floorAnnual, point.annualSpend * supportedScale),
    );
    return {
      year: point.year,
      age: point.age,
      annualSpend: scaledAnnual,
      monthlySpend: roundCurrency(scaledAnnual / 12),
    };
  });
  const overBandAmount = Math.max(
    0,
    recommended.projectedLegacyTodayDollars - baseConstraints.legacyTargetBandUpperTodayDollars,
  );
  const remainingYears = Math.max(
    1,
    recommended.pathResult.monteCarloMetadata.planningHorizonYears,
  );
  const overBandBurnMonthly = roundCurrency(overBandAmount / remainingYears / 12);
  let nextUnlock = successFloorNextUnlock;
  let nextUnlockImpactMonthly = successFloorRelaxationDeltaMonthly;
  if (!nextUnlock) {
    if (bindingGuardrail === 'legacy_target') {
      nextUnlock =
        overBandAmount > 0
          ? `Increase spending by about ${formatCurrency(overBandBurnMonthly)}/month to move legacy toward the top of your target band while keeping current guardrails.`
          : 'Lower the legacy floor or widen the target band slightly to unlock additional supported spending.';
      nextUnlockImpactMonthly = overBandAmount > 0 ? overBandBurnMonthly : 0;
    } else if (bindingGuardrail === 'spending_floor') {
      nextUnlock = 'Lower the spending floor slightly to create more flexibility for optimization.';
      nextUnlockImpactMonthly = 0;
    } else if (bindingGuardrail === 'tax_drag') {
      nextUnlock =
        'Reduce taxable withdrawals (or smooth them across years) to lower tax/IRMAA drag and unlock more supported spend.';
      nextUnlockImpactMonthly = 0;
    } else if (bindingGuardrail === 'ACA_affordability' || bindingGuardrail === 'IRMAA_threshold') {
      nextUnlock =
        'Reduce MAGI-sensitive withdrawals in affected years to unlock more supported spending without crossing healthcare thresholds.';
      nextUnlockImpactMonthly = 0;
    } else {
      nextUnlock = null;
      nextUnlockImpactMonthly = 0;
    }
  }
  const diagnosticsPhaseMs = Number((nowMs() - diagnosticsPhaseStartedAt).toFixed(1));
  const runtimeDiagnostics = {
    totalMs: Number((nowMs() - solverStartedAt).toFixed(1)),
    searchPhaseMs,
    finalPhaseMs,
    diagnosticsPhaseMs,
    searchSimulationRuns: evaluator.searchSimulationRuns,
    finalSimulationRuns: evaluator.finalSimulationRuns,
    searchEvaluations: evaluator.runtimeStats.searchEvaluations,
    finalEvaluations: evaluator.runtimeStats.finalEvaluations,
    searchCacheHits: evaluator.runtimeStats.searchCacheHits,
    finalCacheHits: evaluator.runtimeStats.finalCacheHits,
    searchSimulationMs: Number(evaluator.runtimeStats.searchSimulationMs.toFixed(1)),
    finalSimulationMs: Number(evaluator.runtimeStats.finalSimulationMs.toFixed(1)),
    diagnosticsMode,
  } satisfies SpendSolverResult['runtimeDiagnostics'];

  const result: SpendSolverResult = {
    activeOptimizationObjective: objective,
    supportedMonthlySpendNow,
    supportedAnnualSpendNow,
    supportedSpend60s,
    supportedSpend70s,
    supportedSpend80Plus,
    userTargetSpendNowMonthly,
    userTargetSpendNowAnnual,
    spendGapNowMonthly,
    spendGapNowAnnual,
    recommendedAnnualSpend,
    recommendedMonthlySpend,
    safeSpendingBand,
    modeledSuccessRate: recommended.successRate,
    minimumSuccessRateTarget,
    achievedSuccessRate,
    successConstraintBinding,
    supportedSpendAtCurrentSuccessFloor,
    supportedSpendIfSuccessFloorRelaxed,
    successFloorRelaxationTarget,
    successFloorRelaxationDeltaAnnual,
    successFloorRelaxationDeltaMonthly,
    nextUnlockImpactMonthly,
    successFloorNextUnlock,
    successFloorRelaxationTradeoff,
    nextUnlock,
    medianEndingWealth: recommended.medianEndingWealth,
    p10EndingWealth,
    p90EndingWealth,
    p10EndingWealthTodayDollars,
    p90EndingWealthTodayDollars,
    endingWealthOneSigmaApproxTodayDollars,
    endingWealthOneSigmaLowerTodayDollars,
    endingWealthOneSigmaUpperTodayDollars,
    first10YearFailureRisk,
    annualFederalTaxEstimate: recommended.annualFederalTaxEstimate,
    annualHealthcareCostEstimate: recommended.annualHealthcareCostEstimate,
    projectedLegacyOutcomeTodayDollars: recommended.projectedLegacyTodayDollars,
    projectedLegacyOutcomeNominalDollars: recommended.pathResult.medianEndingWealth,
    legacyFloorTodayDollars: baseConstraints.legacyFloorTodayDollars,
    legacyTargetBandLowerTodayDollars: baseConstraints.legacyTargetBandLowerTodayDollars,
    legacyTargetBandUpperTodayDollars: baseConstraints.legacyTargetBandUpperTodayDollars,
    legacyWithinTargetBand,
    targetLegacyTodayDollars: baseConstraints.legacyTargetTodayDollars,
    legacyTarget: baseConstraints.legacyTargetTodayDollars,
    projectedEndingWealth: recommended.projectedLegacyTodayDollars,
    distanceFromTarget,
    overTargetPenalty,
    isTargetBinding,
    ceilingUsed: ceilingAnnual,
    ceilingIterations: expansionSteps,
    finalBindingConstraint,
    legacyGapToTarget,
    overReservedAmount,
    legacyAttainmentMet,
    flexibleSpendingTarget: evaluator.spendingProfile.flexibleTargetAnnual,
    flexibleSpendingMinimum: evaluator.spendingProfile.flexibleMinimumAnnual,
    travelSpendingTarget: evaluator.spendingProfile.travelTargetAnnual,
    travelSpendingMinimum: evaluator.spendingProfile.travelMinimumAnnual,
    constrainedBySpendingFloors,
    constrainedByLegacyTarget,
    optimizationConstraintDriver,
    currentSpendingPath,
    optimizedSpendingPath,
    spendingDeltaByPhase,
    successBuffer,
    legacyBuffer,
    bindingGuardrail,
    bindingGuardrailExplanation,
    bindingConstraint,
    primaryTradeoff,
    whySupportedSpendIsNotHigher,
    surplusPreservedBecause,
    inheritanceMateriality,
    houseRetentionContribution,
    endingWealthBreakdown: {
      median: recommended.medianEndingWealth,
      p10: p10EndingWealth,
      targetLegacyTodayDollars: baseConstraints.legacyTargetTodayDollars,
    },
    supportedSpendingSchedule,
    actionableExplanation,
    tradeoffExplanation,
    feasible,
    converged: baseSearch.converged,
    nonConvergenceDetected,
    iterations: baseSearch.iterations,
    floorAnnual,
    ceilingAnnual,
    runtimeDiagnostics,
  };
  finishPerf('ok', {
    feasible,
    converged: baseSearch.converged,
    bindingGuardrail,
    bindingConstraint,
    iterations: baseSearch.iterations,
    expandedCeilingAnnual: ceilingAnnual,
    initialCeilingAnnual,
    expansionSteps,
    distanceFromTarget,
    finalBindingConstraint,
    minimumSuccessRateTarget,
    achievedSuccessRate,
    successConstraintBinding,
    totalMs: runtimeDiagnostics.totalMs,
    searchPhaseMs: runtimeDiagnostics.searchPhaseMs,
    finalPhaseMs: runtimeDiagnostics.finalPhaseMs,
    diagnosticsPhaseMs: runtimeDiagnostics.diagnosticsPhaseMs,
    searchEvaluations: runtimeDiagnostics.searchEvaluations,
    finalEvaluations: runtimeDiagnostics.finalEvaluations,
    searchSimulationMs: runtimeDiagnostics.searchSimulationMs,
    finalSimulationMs: runtimeDiagnostics.finalSimulationMs,
  });
  return result;
}
