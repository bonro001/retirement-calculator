import type {
  AccountBucketType,
  ClosedLoopConvergenceThresholds,
  FutureReturnModelExtensionPoint,
  MarketAssumptions,
  PathResult,
  PathYearResult,
  ProjectionPoint,
  ResponseOption,
  SeedData,
  SimulationConfigurationSnapshot,
  SimulationModeDiagnostics,
  SimulationParityReport,
  SimulationParityModeSummary,
  SimulationReturnGenerationAssumptions,
  SimulationRiskMetrics,
  SimulationStrategyMode,
  SimulationTimingConventions,
  SocialSecurityEntry,
  Stressor,
  WindfallTaxTreatment,
} from './types';
import {
  DEFAULT_CLOSED_LOOP_CONVERGENCE_THRESHOLDS,
  DEFAULT_MAX_CLOSED_LOOP_PASSES,
  type ClosedLoopStopReason,
} from './closed-loop-config';
import { calculateFederalTax } from './tax-engine';
import type { YearTaxInputs, YearTaxOutputs } from './tax-engine';
import {
  boundedNormal,
  correlatedAssetReturns,
  executeDeterministicMonteCarlo,
  median,
  percentile,
  type RandomSource,
  SIMULATION_CANCELLED_ERROR,
} from './monte-carlo-engine';
import historicalAnnualReturns from '../fixtures/historical_annual_returns.json';
import {
  calculateIrmaaTier,
  calculateRequiredMinimumDistribution,
  DEFAULT_IRMAA_CONFIG,
  getRmdStartAgeForBirthYear,
} from './retirement-rules';
import { calculatePreRetirementContributions } from './contribution-engine';
import { calculateHealthcarePremiums } from './healthcare-premium-engine';
import {
  deriveAssetClassMappingAssumptionsFromAccounts,
  getHoldingExposure,
  type AssetClassMappingAssumptions,
} from './asset-class-mapper';

const CURRENT_DATE = new Date('2026-04-16T12:00:00');
const CURRENT_YEAR = CURRENT_DATE.getFullYear();
const SIM_BUCKETS: AccountBucketType[] = ['pretax', 'roth', 'taxable', 'cash'];

type AssetClass = 'US_EQUITY' | 'INTL_EQUITY' | 'BONDS' | 'CASH';

interface SimBucketConfig {
  balance: number;
  targetAllocation: Record<string, number>;
  withdrawalPriority: number;
}

interface SimWindfall {
  name: string;
  year: number;
  amount: number;
  taxTreatment?: WindfallTaxTreatment;
  certainty?: 'certain' | 'estimated' | 'uncertain';
  timingUncertaintyYears?: number;
  amountUncertaintyPercent?: number;
  liquidityAmount?: number;
  costBasis?: number;
  sellingCostPercent?: number;
  exclusionAmount?: number;
  distributionYears?: number;
}

interface SimPlan {
  startYear: number;
  planningEndYear: number;
  retirementYear: number;
  salaryAnnual: number;
  salaryEndDate: string;
  essentialAnnual: number;
  optionalAnnual: number;
  taxesInsuranceAnnual: number;
  travelAnnual: number;
  travelPhaseYears: number;
  socialSecurity: SocialSecurityEntry[];
  windfalls: SimWindfall[];
  assetClassMappingAssumptions: Required<AssetClassMappingAssumptions>;
  accounts: Record<AccountBucketType, SimBucketConfig>;
  preserveRoth: boolean;
  irmaaAware: boolean;
  guardrails: {
    floorYears: number;
    ceilingYears: number;
    cutPercent: number;
  };
  rothConversionPolicy: {
    enabled: boolean;
    strategy: 'aca_then_irmaa_headroom' | 'irmaa_headroom_only';
    minAnnualDollars: number;
    maxPretaxBalancePercent: number;
    magiBufferDollars: number;
    source: 'rules' | 'default';
  };
  healthcarePremiums: {
    baselineAcaPremiumAnnual: number;
    baselineMedicarePremiumAnnual: number;
    medicalInflationAnnual: number;
  };
  hsaStrategy: {
    enabled: boolean;
    annualQualifiedExpenseWithdrawalCap: number;
    prioritizeHighMagiYears: boolean;
    highMagiThreshold: number;
  };
  ltcAssumptions: {
    enabled: boolean;
    startAge: number;
    annualCostToday: number;
    durationYears: number;
    inflationAnnual: number;
    eventProbability: number;
  };
  activeStressors: string[];
  activeResponses: string[];
}

interface RunTrace {
  year: number;
  totalAssets: number;
  income: number;
  spending: number;
  federalTax: number;
  rmdAmount: number;
  withdrawalCash: number;
  withdrawalTaxable: number;
  withdrawalIra401k: number;
  withdrawalRoth: number;
  rothConversion: number;
  rothConversionReason: string;
  rothConversionSimulationModeUsed: SimulationStrategyMode;
  rothConversionPlannerLogicActiveAtConversion: boolean;
  rothConversionEngineInvoked: boolean;
  rothConversionCandidateAmounts: number[];
  rothConversionBestCandidateAmount: number;
  rothConversionBestScore: number;
  rothConversionRawMAGI: number;
  rothConversionIrmaaThreshold: number | null;
  rothConversionComputedHeadroom: number;
  rothConversionMagiBuffer: number;
  rothConversionHeadroomComputed: boolean;
  rothConversionCandidateAmountsGenerated: boolean;
  rothConversionEligibilityBlockedReason: string | null;
  rothConversionMagiEffect: number;
  rothConversionTaxEffect: number;
  rothConversionAcaEffect: number;
  rothConversionIrmaaEffect: number;
  rothConversionPretaxBalanceEffect: number;
  rothConversionEligible: boolean;
  rothConversionTargetMagiCeiling: number | null;
  rothConversionMagiHeadroom: number;
  rothConversionMagiBefore: number;
  rothConversionMagiAfter: number;
  rothConversionPretaxBalanceBefore: number;
  rothConversionBalanceCap: number;
  rothConversionScore: number;
  rothConversionOpportunityScore: number;
  rothConversionFutureTaxReduction: number;
  rothConversionFutureTaxBurdenReduction: number;
  rothConversionIrmaaAvoidanceValue: number;
  rothConversionRmdReductionValue: number;
  rothConversionRothOptionalityValue: number;
  rothConversionFutureTaxReductionValue: number;
  rothConversionCurrentTaxCost: number;
  rothConversionSuppressedReason: string | null;
  rothConversionProjectedFutureMagiPeak: number;
  rothConversionProjectedRmdPressure: number;
  rothConversionProjectedIrmaaExposure: number;
  rothConversionProjectedRothShareAfter: number;
  rothBalanceStart: number;
  rothBalanceEnd: number;
  rothContributionFlow: number;
  rothMarketGainLoss: number;
  rothNetChange: number;
  rothBalanceReconciliationDelta: number;
  taxableIncome: number;
  magi: number;
  irmaaTier: string;
  medicareSurcharge: number;
  employee401kContribution: number;
  employerMatchContribution: number;
  total401kContribution: number;
  hsaContribution: number;
  adjustedWages: number;
  taxableWageReduction: number;
  pretaxBalanceAfterContributions: number;
  acaPremiumEstimate: number;
  acaSubsidyEstimate: number;
  netAcaCost: number;
  medicarePremiumEstimate: number;
  irmaaSurcharge: number;
  totalHealthcarePremiumCost: number;
  windfallCashInflow: number;
  windfallOrdinaryIncome: number;
  windfallLtcgIncome: number;
  hsaOffsetUsed: number;
  ltcCost: number;
  withdrawalRationale: string;
  withdrawalScoreSpendingNeed: number;
  withdrawalScoreMarginalTaxCost: number;
  withdrawalScoreMagiTarget: number;
  withdrawalScoreAcaCliffAvoidance: number;
  withdrawalScoreIrmaaCliffAvoidance: number;
  withdrawalScoreRothOptionality: number;
  withdrawalScoreSequenceDefense: number;
  closedLoopConverged: boolean;
  closedLoopConvergedBeforeMaxPasses: boolean;
  closedLoopPassesUsed: number;
  closedLoopStopReason: ClosedLoopStopReason;
  closedLoopLastMagiDelta: number;
  closedLoopLastFederalTaxDelta: number;
  closedLoopLastHealthcarePremiumDelta: number;
}

interface SimulationRunResult {
  success: boolean;
  failureYear: number | null;
  endingWealth: number;
  spendingCutsTriggered: number;
  irmaaTriggered: boolean;
  homeSaleDependent: boolean;
  inheritanceDependent: boolean;
  rothDepletedEarly: boolean;
  forcedEquitySalesInAdverseEarlyYears: boolean;
  failureShortfallAmount: number;
  downsideSpendingCutRequired: number;
  failureReason: string;
  closedLoopYearsConverged: number;
  closedLoopYearsEvaluated: number;
  closedLoopPassesUsedMax: number;
  closedLoopStopReasonCounts: {
    converged_thresholds_met: number;
    max_pass_limit_reached: number;
    no_change: number;
    oscillation_detected: number;
  };
  closedLoopFinalMagiDeltaMax: number;
  closedLoopFinalFederalTaxDeltaMax: number;
  closedLoopFinalHealthcarePremiumDeltaMax: number;
  yearly: RunTrace[];
}

interface SimulationSummary {
  simulationMode: SimulationStrategyMode;
  plannerLogicActive: boolean;
  successRate: number;
  medianEndingWealth: number;
  endingWealthPercentiles: {
    p10: number;
    p25: number;
    p50: number;
    p75: number;
    p90: number;
  };
  medianFailureYear: number | null;
  failureYearDistribution: Array<{
    year: number;
    count: number;
    rate: number;
  }>;
  worstOutcome: {
    endingWealth: number;
    success: boolean;
    failureYear: number | null;
  };
  bestOutcome: {
    endingWealth: number;
    success: boolean;
    failureYear: number | null;
  };
  monteCarloMetadata: {
    seed: number;
    trialCount: number;
    assumptionsVersion: string;
    planningHorizonYears: number;
  };
  simulationConfiguration: SimulationConfigurationSnapshot;
  simulationDiagnostics: SimulationModeDiagnostics;
  spendingCutRate: number;
  irmaaExposureRate: number;
  homeSaleDependenceRate: number;
  inheritanceDependenceRate: number;
  rothDepletionRate: number;
  annualFederalTaxEstimate: number;
  yearsFunded: number;
  flexibilityScore: number;
  cornerRiskScore: number;
  failureMode: string;
  riskMetrics: SimulationRiskMetrics;
  yearlySeries: PathYearResult[];
}

interface ClosedLoopIterationState {
  attempt: ReturnType<typeof withdrawForNeed>;
  endingBalances: Record<AccountBucketType, number>;
  magi: number;
  federalTax: number;
  healthcarePremiumCost: number;
  hsaOffset: number;
  irmaaTier: ReturnType<typeof calculateIrmaaTier>;
  nextNeeded: number;
}

interface ClosedLoopSolveResult {
  finalState: ClosedLoopIterationState;
  converged: boolean;
  passesUsed: number;
  stopReason: ClosedLoopStopReason;
  lastDeltas: {
    magi: number;
    federalTax: number;
    healthcarePremium: number;
  };
}

interface WithdrawalDecisionTrace {
  rationale: string;
  objectiveScores: {
    spendingNeed: number;
    marginalTaxCost: number;
    magiTarget: number;
    acaCliffAvoidance: number;
    irmaaCliffAvoidance: number;
    rothOptionality: number;
    sequenceDefense: number;
  };
}

interface RothConversionTrace {
  amount: number;
  reason: string;
  simulationModeUsedForConversion: SimulationStrategyMode;
  plannerLogicActiveAtConversion: boolean;
  conversionEngineInvoked: boolean;
  evaluatedCandidateAmounts: number[];
  bestCandidateAmount: number;
  bestScore: number;
  rawMAGI: number;
  irmaaThreshold: number | null;
  computedHeadroom: number;
  magiBuffer: number;
  headroomComputed: boolean;
  candidateAmountsGenerated: boolean;
  eligibilityBlockedReason: string | null;
  magiEffect: number;
  taxEffect: number;
  acaEffect: number;
  irmaaEffect: number;
  pretaxBalanceEffect: number;
  eligible: boolean;
  targetMagiCeiling: number | null;
  magiHeadroom: number;
  magiBefore: number;
  magiAfter: number;
  pretaxBalanceBefore: number;
  balanceCap: number;
  conversionScore: number;
  conversionOpportunityScore: number;
  futureTaxReduction: number;
  futureTaxBurdenReduction: number;
  irmaaAvoidanceValue: number;
  rmdReductionValue: number;
  rothOptionalityValue: number;
  futureTaxReductionValue: number;
  currentTaxCost: number;
  conversionSuppressedReason: string | null;
  projectedFutureMagiPeak: number;
  projectedRmdPressure: number;
  projectedIrmaaExposure: number;
  projectedRothShareAfter: number;
}

export interface SimulationStressorKnobs {
  delayedInheritanceYears?: number;
  cutSpendingPercent?: number;
  /** ISO date (YYYY-MM-DD) the layoff stressor uses as salary-end. */
  layoffRetireDate?: string;
  /** Lump-sum severance paid in the layoff year, real dollars. */
  layoffSeverance?: number;
}

interface SimulationExecutionOptions {
  onProgress?: (progress: number) => void;
  isCancelled?: () => boolean;
  annualSpendTarget?: number;
  annualSpendScheduleByYear?: Record<number, number>;
  pathMode?: 'all' | 'selected_only';
  strategyMode?: SimulationStrategyMode;
  stressorKnobs?: SimulationStressorKnobs;
}

function throwIfSimulationCancelled(isCancelled?: () => boolean) {
  if (isCancelled?.()) {
    throw new Error(SIMULATION_CANCELLED_ERROR);
  }
}

const dollarFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

const percentFormatter = new Intl.NumberFormat('en-US', {
  style: 'percent',
  maximumFractionDigits: 0,
});

const dominantValue = (values: string[]) => {
  if (!values.length) {
    return 'Tier 1';
  }

  const counts = new Map<string, number>();
  values.forEach((value) => {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  });

  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? 'Tier 1';
};

export function formatCurrency(value: number) {
  return dollarFormatter.format(value);
}

export function formatPercent(value: number) {
  return percentFormatter.format(value);
}

export function formatDate(value: string) {
  return new Date(value).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function calculateCurrentAges(data: SeedData) {
  const getAge = (birthDate: string) => {
    const birth = new Date(birthDate);
    let age = CURRENT_DATE.getFullYear() - birth.getFullYear();
    const hasHadBirthday =
      CURRENT_DATE.getMonth() > birth.getMonth() ||
      (CURRENT_DATE.getMonth() === birth.getMonth() &&
        CURRENT_DATE.getDate() >= birth.getDate());

    if (!hasHadBirthday) {
      age -= 1;
    }

    return age;
  };

  return {
    rob: getAge(data.household.robBirthDate),
    debbie: getAge(data.household.debbieBirthDate),
  };
}

export function getTotalPortfolioBalance(data: SeedData) {
  return Object.values(data.accounts).reduce(
    (total, bucket) => total + bucket.balance,
    0,
  );
}

export function getAnnualCoreSpend(data: SeedData) {
  return (
    data.spending.essentialMonthly * 12 +
    data.spending.optionalMonthly * 12 +
    data.spending.annualTaxesInsurance
  );
}

export function getAnnualStretchSpend(data: SeedData) {
  return getAnnualCoreSpend(data) + data.spending.travelEarlyRetirementAnnual;
}

export interface AnnualSpendingTargets {
  essentialAnnual: number;
  flexibleAnnual: number;
  travelAnnual: number;
  taxesInsuranceAnnual: number;
  totalAnnual: number;
}

export interface AnnualSpendingMinimums {
  essentialAnnualMinimum: number;
  flexibleAnnualMinimum: number;
  travelAnnualMinimum: number;
  taxesInsuranceAnnualMinimum: number;
  totalAnnualMinimum: number;
}

export function getAnnualSpendingTargets(data: SeedData): AnnualSpendingTargets {
  const essentialAnnual = Math.max(0, data.spending.essentialMonthly * 12);
  const flexibleAnnual = Math.max(0, data.spending.optionalMonthly * 12);
  const travelAnnual = Math.max(0, data.spending.travelEarlyRetirementAnnual);
  const taxesInsuranceAnnual = Math.max(0, data.spending.annualTaxesInsurance);
  return {
    essentialAnnual,
    flexibleAnnual,
    travelAnnual,
    taxesInsuranceAnnual,
    totalAnnual: essentialAnnual + flexibleAnnual + travelAnnual + taxesInsuranceAnnual,
  };
}

export function getAnnualSpendingMinimums(
  data: SeedData,
  overrides?: Partial<{
    essentialAnnualMinimum: number;
    flexibleAnnualMinimum: number;
    travelAnnualMinimum: number;
    taxesInsuranceAnnualMinimum: number;
  }>,
): AnnualSpendingMinimums {
  const targets = getAnnualSpendingTargets(data);
  const defaultEssentialMinimumAnnual =
    (data.spending.essentialMinimumMonthly ?? data.spending.essentialMonthly) * 12;
  const essentialAnnualMinimum = Math.max(
    0,
    overrides?.essentialAnnualMinimum ?? defaultEssentialMinimumAnnual,
  );
  const flexibleAnnualMinimum = Math.max(
    0,
    Math.min(
      targets.flexibleAnnual,
      overrides?.flexibleAnnualMinimum ??
        (data.spending.optionalMinimumMonthly ?? 0) * 12,
    ),
  );
  const travelAnnualMinimum = Math.max(
    0,
    Math.min(
      targets.travelAnnual,
      overrides?.travelAnnualMinimum ?? data.spending.travelMinimumAnnual ?? 0,
    ),
  );
  const taxesInsuranceAnnualMinimum = Math.max(
    0,
    overrides?.taxesInsuranceAnnualMinimum ?? data.spending.annualTaxesInsurance,
  );
  return {
    essentialAnnualMinimum,
    flexibleAnnualMinimum,
    travelAnnualMinimum,
    taxesInsuranceAnnualMinimum,
    totalAnnualMinimum:
      essentialAnnualMinimum +
      flexibleAnnualMinimum +
      travelAnnualMinimum +
      taxesInsuranceAnnualMinimum,
  };
}

export function getRetirementHorizonYears(
  data: SeedData,
  assumptions?: Pick<MarketAssumptions, 'robPlanningEndAge' | 'debbiePlanningEndAge'>,
) {
  const ages = calculateCurrentAges(data);
  const robTarget = assumptions?.robPlanningEndAge ?? data.household.planningAge;
  const debbieTarget = assumptions?.debbiePlanningEndAge ?? data.household.planningAge;

  return Math.max(robTarget - ages.rob, debbieTarget - ages.debbie, 0);
}

function cloneAllocations(allocation: Record<string, number>) {
  return Object.fromEntries(
    Object.entries(allocation).map(([symbol, weight]) => [symbol, weight]),
  );
}

function addAllocationValue(
  destination: Record<string, number>,
  allocation: Record<string, number>,
  balance: number,
) {
  Object.entries(allocation).forEach(([symbol, weight]) => {
    destination[symbol] = (destination[symbol] ?? 0) + weight * balance;
  });
}

function normalizeAllocation(values: Record<string, number>, total: number) {
  if (total <= 0) {
    return { CASH: 1 };
  }

  return Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => value > 0)
      .map(([symbol, value]) => [symbol, Number((value / total).toFixed(4))]),
  );
}

function buildPlan(
  data: SeedData,
  assumptions: MarketAssumptions,
  annualSpendTarget?: number,
) {
  const horizonYears = getRetirementHorizonYears(data, assumptions);
  const hsaBalance = data.accounts.hsa?.balance ?? 0;
  const pretaxTotal = data.accounts.pretax.balance + hsaBalance;
  const pretaxAllocationValue: Record<string, number> = {};
  addAllocationValue(
    pretaxAllocationValue,
    data.accounts.pretax.targetAllocation,
    data.accounts.pretax.balance,
  );

  if (data.accounts.hsa) {
    addAllocationValue(
      pretaxAllocationValue,
      data.accounts.hsa.targetAllocation,
      data.accounts.hsa.balance,
    );
  }

  const salaryEndDate = data.income.salaryEndDate;
  const rawEssentialAnnual = data.spending.essentialMonthly * 12;
  const rawOptionalAnnual = data.spending.optionalMonthly * 12;
  const rawTaxesInsuranceAnnual = data.spending.annualTaxesInsurance;
  const rawTravelAnnual = data.spending.travelEarlyRetirementAnnual;
  const baselineAnnualSpend =
    rawEssentialAnnual + rawOptionalAnnual + rawTaxesInsuranceAnnual + rawTravelAnnual;
  const spendMultiplier =
    typeof annualSpendTarget === 'number' &&
      Number.isFinite(annualSpendTarget) &&
      annualSpendTarget > 0 &&
      baselineAnnualSpend > 0
      ? annualSpendTarget / baselineAnnualSpend
      : 1;

  const assetClassMappingAssumptions = deriveAssetClassMappingAssumptionsFromAccounts(
    data.accounts,
    data.rules.assetClassMappingAssumptions,
  );
  const configuredRothPolicy = data.rules.rothConversionPolicy;
  const rothConversionPolicy = {
    enabled: configuredRothPolicy?.enabled ?? true,
    strategy: configuredRothPolicy?.strategy ?? 'aca_then_irmaa_headroom',
    minAnnualDollars: Math.max(
      0,
      configuredRothPolicy?.minAnnualDollars ?? DEFAULT_ROTH_CONVERSION_MIN_DOLLARS,
    ),
    maxPretaxBalancePercent: Math.max(
      0,
      Math.min(
        1,
        configuredRothPolicy?.maxPretaxBalancePercent ??
          DEFAULT_ROTH_CONVERSION_BALANCE_RATIO_CAP,
      ),
    ),
    magiBufferDollars: Math.max(
      0,
      configuredRothPolicy?.magiBufferDollars ?? DEFAULT_ROTH_CONVERSION_MAGI_BUFFER,
    ),
    source: configuredRothPolicy ? 'rules' : 'default',
  } as const;

  return {
    startYear: CURRENT_YEAR,
    planningEndYear: CURRENT_YEAR + horizonYears,
    retirementYear: new Date(salaryEndDate).getFullYear(),
    salaryAnnual: data.income.salaryAnnual,
    salaryEndDate,
    essentialAnnual: rawEssentialAnnual * spendMultiplier,
    optionalAnnual: rawOptionalAnnual * spendMultiplier,
    taxesInsuranceAnnual: rawTaxesInsuranceAnnual * spendMultiplier,
    travelAnnual: rawTravelAnnual * spendMultiplier,
    travelPhaseYears: assumptions.travelPhaseYears,
    socialSecurity: data.income.socialSecurity.map((entry) => ({ ...entry })),
    windfalls: data.income.windfalls.map((item) => ({ ...item })),
    assetClassMappingAssumptions,
    accounts: {
      pretax: {
        balance: pretaxTotal,
        targetAllocation: normalizeAllocation(pretaxAllocationValue, pretaxTotal),
        withdrawalPriority: 3,
      },
      roth: {
        balance: data.accounts.roth.balance,
        targetAllocation: cloneAllocations(data.accounts.roth.targetAllocation),
        withdrawalPriority: 4,
      },
      taxable: {
        balance: data.accounts.taxable.balance,
        targetAllocation: cloneAllocations(data.accounts.taxable.targetAllocation),
        withdrawalPriority: 2,
      },
      cash: {
        balance: data.accounts.cash.balance,
        targetAllocation: cloneAllocations(data.accounts.cash.targetAllocation),
        withdrawalPriority: 1,
      },
    },
    preserveRoth: true,
    irmaaAware: data.rules.irmaaAware,
    guardrails: {
      floorYears: assumptions.guardrailFloorYears,
      ceilingYears: assumptions.guardrailCeilingYears,
      cutPercent: assumptions.guardrailCutPercent,
    },
    rothConversionPolicy,
    healthcarePremiums: {
      baselineAcaPremiumAnnual:
        data.rules.healthcarePremiums?.baselineAcaPremiumAnnual ??
        DEFAULT_BASELINE_ACA_PREMIUM_ANNUAL,
      baselineMedicarePremiumAnnual:
        data.rules.healthcarePremiums?.baselineMedicarePremiumAnnual ??
        DEFAULT_BASELINE_MEDICARE_PREMIUM_ANNUAL,
      medicalInflationAnnual:
        data.rules.healthcarePremiums?.medicalInflationAnnual ??
        DEFAULT_MEDICAL_INFLATION_ANNUAL,
    },
    hsaStrategy: {
      enabled: data.rules.hsaStrategy?.enabled ?? false,
      annualQualifiedExpenseWithdrawalCap:
        data.rules.hsaStrategy?.annualQualifiedExpenseWithdrawalCap ??
        Number.POSITIVE_INFINITY,
      prioritizeHighMagiYears: data.rules.hsaStrategy?.prioritizeHighMagiYears ?? false,
      highMagiThreshold:
        data.rules.hsaStrategy?.highMagiThreshold ??
        DEFAULT_HSA_HIGH_MAGI_THRESHOLD,
    },
    ltcAssumptions: {
      enabled: data.rules.ltcAssumptions?.enabled ?? false,
      startAge: data.rules.ltcAssumptions?.startAge ?? DEFAULT_LTC_START_AGE,
      annualCostToday:
        data.rules.ltcAssumptions?.annualCostToday ?? DEFAULT_LTC_ANNUAL_COST_TODAY,
      durationYears:
        data.rules.ltcAssumptions?.durationYears ?? DEFAULT_LTC_DURATION_YEARS,
      inflationAnnual:
        data.rules.ltcAssumptions?.inflationAnnual ?? DEFAULT_LTC_INFLATION_ANNUAL,
      eventProbability: Math.max(
        0,
        Math.min(
          1,
          data.rules.ltcAssumptions?.eventProbability ?? DEFAULT_LTC_EVENT_PROBABILITY,
        ),
      ),
    },
    activeStressors: [],
    activeResponses: [],
  } satisfies SimPlan;
}

function shiftDateYears(value: string, years: number) {
  const date = new Date(value);
  date.setFullYear(date.getFullYear() + years);
  return date.toISOString();
}

function applyStressors(
  plan: SimPlan,
  stressors: Stressor[],
  knobs?: SimulationStressorKnobs,
) {
  const nextPlan = {
    ...plan,
    socialSecurity: plan.socialSecurity.map((entry) => ({ ...entry })),
    windfalls: plan.windfalls.map((entry) => ({ ...entry })),
    activeStressors: stressors.map((item) => item.id),
  };

  const delayedInheritanceYears = Math.max(
    1,
    Math.round(knobs?.delayedInheritanceYears ?? 5),
  );

  stressors.forEach((stressor) => {
    if (stressor.id === 'layoff') {
      const rawDate = knobs?.layoffRetireDate;
      const parsed = rawDate ? new Date(rawDate) : null;
      const layoffDate =
        parsed && !Number.isNaN(parsed.getTime())
          ? parsed
          : new Date(CURRENT_YEAR, 0, 1);
      nextPlan.salaryEndDate = layoffDate.toISOString();
      nextPlan.retirementYear = layoffDate.getFullYear();
      const severance = Math.max(0, Math.round(knobs?.layoffSeverance ?? 0));
      if (severance > 0) {
        nextPlan.windfalls = [
          ...nextPlan.windfalls,
          {
            name: 'severance',
            year: layoffDate.getFullYear(),
            amount: severance,
            taxTreatment: 'ordinary_income',
          },
        ];
      }
    }

    if (stressor.id === 'delayed_inheritance') {
      nextPlan.windfalls = nextPlan.windfalls.map((item) =>
        item.name === 'inheritance'
          ? { ...item, year: item.year + delayedInheritanceYears }
          : item,
      );
    }
  });

  return nextPlan;
}

function moveIntoCash(plan: SimPlan, amount: number) {
  let remaining = amount;

  (['taxable', 'pretax'] as AccountBucketType[]).forEach((bucket) => {
    if (remaining <= 0) {
      return;
    }

    const available = plan.accounts[bucket].balance;
    const transfer = Math.min(available, remaining);
    if (transfer <= 0) {
      return;
    }

    plan.accounts[bucket].balance -= transfer;
    plan.accounts.cash.balance += transfer;
    remaining -= transfer;
  });
}

function applyResponses(
  plan: SimPlan,
  responses: ResponseOption[],
  knobs?: SimulationStressorKnobs,
) {
  const nextPlan = {
    ...plan,
    socialSecurity: plan.socialSecurity.map((entry) => ({ ...entry })),
    windfalls: plan.windfalls.map((entry) => ({ ...entry })),
    accounts: {
      pretax: { ...plan.accounts.pretax },
      roth: { ...plan.accounts.roth },
      taxable: { ...plan.accounts.taxable },
      cash: { ...plan.accounts.cash },
    },
    activeResponses: responses.map((item) => item.id),
  };

  responses.forEach((response) => {
    if (response.id === 'cut_spending') {
      const cutFromKnob = knobs?.cutSpendingPercent;
      const cut =
        cutFromKnob !== undefined
          ? Math.max(0, Math.min(100, cutFromKnob))
          : (response.optionalReductionPercent ?? 20);
      nextPlan.optionalAnnual *= 1 - cut / 100;
    }

    if (response.id === 'sell_home_early') {
      nextPlan.windfalls = nextPlan.windfalls.map((item) =>
        item.name === 'home_sale'
          ? { ...item, year: CURRENT_YEAR + (response.triggerYear ?? 3) }
          : item,
      );
    }

    if (response.id === 'delay_retirement') {
      const years = response.delayYears ?? 1;
      nextPlan.salaryEndDate = shiftDateYears(nextPlan.salaryEndDate, years);
      nextPlan.retirementYear += years;
    }

    if (response.id === 'early_ss' && response.claimAge) {
      nextPlan.socialSecurity = nextPlan.socialSecurity.map((entry) => ({
        ...entry,
        claimAge: Math.min(entry.claimAge, response.claimAge!),
      }));
    }

    if (response.id === 'preserve_roth') {
      nextPlan.preserveRoth = true;
    }

    if (response.id === 'increase_cash_buffer') {
      moveIntoCash(nextPlan, nextPlan.essentialAnnual * 2);
    }
  });

  return nextPlan;
}

function getAssetExposure(
  symbol: string,
  assumptions?: AssetClassMappingAssumptions,
) {
  return getHoldingExposure(symbol, assumptions);
}

function getBucketReturn(
  allocation: Record<string, number>,
  assetReturns: Record<AssetClass, number>,
  assumptions?: AssetClassMappingAssumptions,
) {
  return Object.entries(allocation).reduce((total, [symbol, weight]) => {
    const exposure = getAssetExposure(symbol, assumptions);
    const symbolReturn = Object.entries(exposure).reduce(
      (innerTotal, [assetClass, assetWeight]) =>
        innerTotal + (assetReturns[assetClass as AssetClass] ?? 0) * assetWeight,
      0,
    );

    return total + symbolReturn * weight;
  }, 0);
}

function getDefenseScore(
  allocation: Record<string, number>,
  assumptions?: AssetClassMappingAssumptions,
) {
  return Object.entries(allocation).reduce((total, [symbol, weight]) => {
    const exposure = getAssetExposure(symbol, assumptions);
    return total + ((exposure.BONDS ?? 0) + (exposure.CASH ?? 0)) * weight;
  }, 0);
}

function getSalaryForYear(plan: SimPlan, year: number) {
  const endDate = new Date(plan.salaryEndDate);
  const endYear = endDate.getFullYear();
  if (year < endYear) {
    return plan.salaryAnnual;
  }

  if (year > endYear) {
    return 0;
  }

  const monthFraction = endDate.getMonth() / 12;
  return plan.salaryAnnual * monthFraction;
}

export function getSocialSecurityBenefitFactor(claimAge: number) {
  return getBenefitFactor(claimAge);
}

function getBenefitFactor(claimAge: number) {
  if (claimAge < 67) {
    return Math.max(0.7, 1 - (67 - claimAge) * 0.06);
  }

  if (claimAge > 67) {
    return 1 + (claimAge - 67) * 0.08;
  }

  return 1;
}

function getSocialSecurityIncome(
  plan: SimPlan,
  year: number,
  ages: { rob: number; debbie: number },
  inflationIndex: number,
) {
  return plan.socialSecurity.reduce((total, entry) => {
    const age = entry.person === 'rob' ? ages.rob : ages.debbie;
    if (age < entry.claimAge) {
      return total;
    }

    return total + entry.fraMonthly * 12 * getBenefitFactor(entry.claimAge) * inflationIndex;
  }, 0);
}

interface WindfallRealization {
  cashInflow: number;
  ordinaryIncome: number;
  ltcgIncome: number;
}

function inferWindfallTaxTreatment(windfall: SimWindfall): WindfallTaxTreatment {
  if (windfall.taxTreatment) {
    return windfall.taxTreatment;
  }
  if (windfall.name === 'home_sale') {
    return 'primary_home_sale';
  }
  if (windfall.name === 'inheritance') {
    return 'cash_non_taxable';
  }
  return 'cash_non_taxable';
}

function getDefaultPrimaryHomeSaleExclusion(filingStatus: string) {
  return filingStatus === 'married_filing_jointly' ? 500_000 : 250_000;
}

function buildWindfallRealizationForYear(
  windfall: SimWindfall,
  year: number,
  filingStatus: string,
): WindfallRealization {
  const treatment = inferWindfallTaxTreatment(windfall);
  const amount = Math.max(0, windfall.amount);
  const modeledSellingCost = windfall.name === 'home_sale'
    ? amount * Math.max(0, Math.min(1, windfall.sellingCostPercent ?? 0))
    : 0;
  const defaultLiquidity = Math.max(0, amount - modeledSellingCost);
  const liquidityAmount = Math.max(0, windfall.liquidityAmount ?? defaultLiquidity);
  if (amount <= 0) {
    return { cashInflow: 0, ordinaryIncome: 0, ltcgIncome: 0 };
  }

  if (treatment === 'inherited_ira_10y') {
    const distributionYears = Math.max(1, Math.round(windfall.distributionYears ?? 10));
    if (year < windfall.year || year >= windfall.year + distributionYears) {
      return { cashInflow: 0, ordinaryIncome: 0, ltcgIncome: 0 };
    }
    const annualDistribution = amount / distributionYears;
    return {
      cashInflow: annualDistribution,
      ordinaryIncome: annualDistribution,
      ltcgIncome: 0,
    };
  }

  if (year !== windfall.year) {
    return { cashInflow: 0, ordinaryIncome: 0, ltcgIncome: 0 };
  }

  if (treatment === 'ordinary_income') {
    return {
      cashInflow: liquidityAmount,
      ordinaryIncome: amount,
      ltcgIncome: 0,
    };
  }

  if (treatment === 'ltcg') {
    const costBasis = Math.max(0, windfall.costBasis ?? amount);
    const taxableGain = Math.max(0, amount - costBasis);
    return {
      cashInflow: liquidityAmount,
      ordinaryIncome: 0,
      ltcgIncome: taxableGain,
    };
  }

  if (treatment === 'primary_home_sale') {
    const costBasis = Math.max(0, windfall.costBasis ?? amount);
    const realizedGain = Math.max(0, amount - costBasis);
    const exclusion = Math.max(
      0,
      windfall.exclusionAmount ?? getDefaultPrimaryHomeSaleExclusion(filingStatus),
    );
    return {
      cashInflow: liquidityAmount,
      ordinaryIncome: 0,
      ltcgIncome: Math.max(0, realizedGain - exclusion),
    };
  }

  return {
    cashInflow: liquidityAmount,
    ordinaryIncome: 0,
    ltcgIncome: 0,
  };
}

function calculateLtcCostForYear(
  plan: SimPlan,
  ages: { rob: number; debbie: number },
  eventOccurs: boolean,
) {
  if (
    !eventOccurs ||
    !plan.ltcAssumptions.enabled ||
    plan.ltcAssumptions.annualCostToday <= 0
  ) {
    return 0;
  }

  const householdAge = Math.max(ages.rob, ages.debbie);
  if (householdAge < plan.ltcAssumptions.startAge) {
    return 0;
  }

  const yearsIntoLtc = householdAge - plan.ltcAssumptions.startAge;
  if (yearsIntoLtc >= Math.max(1, Math.round(plan.ltcAssumptions.durationYears))) {
    return 0;
  }

  return (
    plan.ltcAssumptions.annualCostToday *
    Math.pow(1 + plan.ltcAssumptions.inflationAnnual, yearsIntoLtc)
  );
}

function calculateHsaOffsetForYear(input: {
  plan: SimPlan;
  hsaBalance: number;
  magi: number;
  healthcareAndLtcCost: number;
}) {
  if (!input.plan.hsaStrategy.enabled || input.hsaBalance <= 0 || input.healthcareAndLtcCost <= 0) {
    return 0;
  }
  if (
    input.plan.hsaStrategy.prioritizeHighMagiYears &&
    input.magi < input.plan.hsaStrategy.highMagiThreshold
  ) {
    return 0;
  }
  const cap = Math.max(0, input.plan.hsaStrategy.annualQualifiedExpenseWithdrawalCap);
  const cappedNeed = Number.isFinite(cap)
    ? Math.min(input.healthcareAndLtcCost, cap)
    : input.healthcareAndLtcCost;
  return Math.min(input.hsaBalance, cappedNeed);
}

function createBaseYearTaxInputs(
  filingStatus: string,
  wages: number,
  socialSecurityBenefits: number,
  headAge?: number,
  spouseAge?: number,
): YearTaxInputs {
  return {
    wages,
    pension: 0,
    socialSecurityBenefits,
    ira401kWithdrawals: 0,
    rothWithdrawals: 0,
    taxableInterest: 0,
    qualifiedDividends: 0,
    ordinaryDividends: 0,
    realizedLTCG: 0,
    realizedSTCG: 0,
    otherOrdinaryIncome: 0,
    filingStatus,
    headAge,
    spouseAge,
  };
}

function getScheduledAnnualSpendForYear(
  schedule: Record<number, number> | undefined,
  year: number,
) {
  if (!schedule) {
    return null;
  }
  const value = schedule[year];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, value);
}

// Historical annual-returns fixture data, pre-parsed once for fast per-year
// bootstrap sampling. Each row carries S&P 500 total return, intermediate-term
// Treasury return, and CPI inflation. We map stocks→US_EQUITY and
// bonds→BONDS; historical intl and cash aren't in the Trinity-era dataset
// so we proxy: intl = US with a small shift, cash = 0.8x * inflation (keeps
// cash yield roughly tracking inflation as it does historically).
const HISTORICAL_RETURN_TUPLES = (
  historicalAnnualReturns as {
    annual: Array<{
      year: number;
      stocks: number;
      bonds: number;
      inflation: number;
    }>;
  }
).annual;

function historicalRowToBootstrapTuple(rowIndex: number): {
  US_EQUITY: number;
  INTL_EQUITY: number;
  BONDS: number;
  CASH: number;
  inflation: number;
  sampledYear: number;
} {
  const row = HISTORICAL_RETURN_TUPLES[
    Math.max(0, Math.min(HISTORICAL_RETURN_TUPLES.length - 1, rowIndex))
  ];
  return {
    US_EQUITY: row.stocks,
    INTL_EQUITY: row.stocks * 0.95, // intl proxy — tracks US with slight haircut
    BONDS: row.bonds,
    CASH: Math.max(0, row.inflation * 0.8), // cash yield ~ tracks inflation
    inflation: row.inflation,
    sampledYear: row.year,
  };
}

function sampleHistoricalBootstrapYear(
  random: RandomSource,
  presampledIndex?: number,
) {
  const index =
    presampledIndex ?? Math.floor(random() * HISTORICAL_RETURN_TUPLES.length);
  return historicalRowToBootstrapTuple(index);
}

// Pre-build a sequence of historical-row indices for block bootstrap.
// Blocks of length `blockLength` preserve multi-year autocorrelation.
// When a block would run past the end of the fixture, the sequence
// wraps — this is standard circular block bootstrap.
function buildBlockBootstrapIndexSequence(
  horizonYears: number,
  blockLength: number,
  random: RandomSource,
): number[] {
  const fixtureLength = HISTORICAL_RETURN_TUPLES.length;
  const effectiveBlockLength = Math.max(1, Math.floor(blockLength));
  const sequence: number[] = [];
  while (sequence.length < horizonYears) {
    const start = Math.floor(random() * fixtureLength);
    for (let i = 0; i < effectiveBlockLength && sequence.length < horizonYears; i++) {
      sequence.push((start + i) % fixtureLength);
    }
  }
  return sequence;
}

function getStressAdjustedReturns(
  plan: SimPlan,
  assumptions: MarketAssumptions,
  yearOffset: number,
  random: RandomSource,
  presampledBootstrapIndex?: number,
) {
  // Historical bootstrap path: one random year's tuple overrides all four
  // asset returns AND inflation. Stress overlays still apply on top.
  if (assumptions.useHistoricalBootstrap) {
    const sample = sampleHistoricalBootstrapYear(random, presampledBootstrapIndex);
    let inflation = sample.inflation;
    const assetReturns: Record<AssetClass, number> = {
      US_EQUITY: sample.US_EQUITY,
      INTL_EQUITY: sample.INTL_EQUITY,
      BONDS: sample.BONDS,
      CASH: sample.CASH,
    };
    let marketState: 'normal' | 'down' | 'up' = 'normal';
    if (plan.activeStressors.includes('market_down') && yearOffset < 3) {
      const overrides = [-0.18, -0.12, -0.08];
      assetReturns.US_EQUITY = overrides[yearOffset];
      assetReturns.INTL_EQUITY = overrides[yearOffset];
      marketState = 'down';
    } else if (
      plan.activeStressors.includes('market_down') &&
      yearOffset >= 3 &&
      yearOffset < 8
    ) {
      assetReturns.US_EQUITY += 0.04;
      assetReturns.INTL_EQUITY += 0.04;
    }
    if (plan.activeStressors.includes('market_up') && yearOffset < 3) {
      const overrides = [0.12, 0.1, 0.08];
      assetReturns.US_EQUITY = overrides[yearOffset];
      assetReturns.INTL_EQUITY = overrides[yearOffset];
      marketState = 'up';
    }
    if (plan.activeStressors.includes('inflation') && yearOffset < 10) {
      inflation = Math.max(inflation, 0.05);
    }
    return { inflation, assetReturns, marketState };
  }

  let inflation = boundedNormal(
    assumptions.inflation,
    assumptions.inflationVolatility,
    -0.02,
    0.12,
    random,
  );

  const assetReturns: Record<AssetClass, number> = assumptions.useCorrelatedReturns
    ? (() => {
        const [usEquity, intlEquity, bonds, cash] = correlatedAssetReturns(
          [
            {
              mean: assumptions.equityMean,
              stdDev: assumptions.equityVolatility,
              min: -0.45,
              max: 0.45,
            },
            {
              mean: assumptions.internationalEquityMean,
              stdDev: assumptions.internationalEquityVolatility,
              min: -0.5,
              max: 0.45,
            },
            {
              mean: assumptions.bondMean,
              stdDev: assumptions.bondVolatility,
              min: -0.2,
              max: 0.2,
            },
            {
              mean: assumptions.cashMean,
              stdDev: assumptions.cashVolatility,
              min: -0.01,
              max: 0.08,
            },
          ],
          random,
        );
        return {
          US_EQUITY: usEquity,
          INTL_EQUITY: intlEquity,
          BONDS: bonds,
          CASH: cash,
        };
      })()
    : {
        US_EQUITY: boundedNormal(
          assumptions.equityMean,
          assumptions.equityVolatility,
          -0.45,
          0.45,
          random,
        ),
        INTL_EQUITY: boundedNormal(
          assumptions.internationalEquityMean,
          assumptions.internationalEquityVolatility,
          -0.5,
          0.45,
          random,
        ),
        BONDS: boundedNormal(assumptions.bondMean, assumptions.bondVolatility, -0.2, 0.2, random),
        CASH: boundedNormal(assumptions.cashMean, assumptions.cashVolatility, -0.01, 0.08, random),
      };

  let marketState: 'normal' | 'down' | 'up' = 'normal';

  if (plan.activeStressors.includes('market_down') && yearOffset < 3) {
    const overrides = [-0.18, -0.12, -0.08];
    assetReturns.US_EQUITY = overrides[yearOffset];
    assetReturns.INTL_EQUITY = overrides[yearOffset];
    marketState = 'down';
  } else if (
    plan.activeStressors.includes('market_down') &&
    yearOffset >= 3 &&
    yearOffset < 8
  ) {
    assetReturns.US_EQUITY += 0.04;
    assetReturns.INTL_EQUITY += 0.04;
  }

  if (plan.activeStressors.includes('market_up') && yearOffset < 3) {
    const overrides = [0.12, 0.1, 0.08];
    assetReturns.US_EQUITY = overrides[yearOffset];
    assetReturns.INTL_EQUITY = overrides[yearOffset];
    marketState = 'up';
  }

  const inflationStressor = plan.activeStressors.includes('inflation');
  if (inflationStressor && yearOffset < 10) {
    inflation = Math.max(inflation, 0.05);
  }

  return { inflation, assetReturns, marketState };
}

interface MarketPathPoint {
  inflation: number;
  assetReturns: Record<AssetClass, number>;
  marketState: 'normal' | 'down' | 'up';
}

function buildYearlyMarketPath(
  plan: SimPlan,
  assumptions: MarketAssumptions,
  horizonYears: number,
  random: RandomSource,
) {
  // Block-bootstrap mode: pre-sample the index sequence once so multi-
  // year autocorrelation is preserved (bad years cluster). Block length
  // of 1 is iid — equivalent to the default per-year draw.
  const blockLength = assumptions.historicalBootstrapBlockLength ?? 1;
  const preSampledIndices =
    assumptions.useHistoricalBootstrap && blockLength > 1
      ? buildBlockBootstrapIndexSequence(horizonYears, blockLength, random)
      : null;

  const path: MarketPathPoint[] = [];
  for (let yearOffset = 0; yearOffset < horizonYears; yearOffset += 1) {
    path.push(
      getStressAdjustedReturns(
        plan,
        assumptions,
        yearOffset,
        random,
        preSampledIndices?.[yearOffset],
      ),
    );
  }
  return path;
}

function sumBalances(balances: Record<AccountBucketType, number>) {
  return SIM_BUCKETS.reduce((total, bucket) => total + balances[bucket], 0);
}

const DEFAULT_TAXABLE_WITHDRAWAL_LTCG_RATIO = 0.25;
const DEFAULT_BASELINE_ACA_PREMIUM_ANNUAL = 14_400;
const DEFAULT_BASELINE_MEDICARE_PREMIUM_ANNUAL = 2_220;
const DEFAULT_MEDICAL_INFLATION_ANNUAL = 0.055;
const ACA_FRIENDLY_MAGI_BUFFER = 2_000;
const ACA_FPL_BY_HOUSEHOLD_SIZE: Record<number, number> = {
  1: 15_650,
  2: 21_150,
};
const DEFAULT_HSA_HIGH_MAGI_THRESHOLD = 200_000;
const DEFAULT_LTC_START_AGE = 82;
const DEFAULT_LTC_ANNUAL_COST_TODAY = 0;
const DEFAULT_LTC_DURATION_YEARS = 4;
const DEFAULT_LTC_INFLATION_ANNUAL = 0.055;
const DEFAULT_LTC_EVENT_PROBABILITY = 0.45;
const DEFAULT_ROTH_CONVERSION_MIN_DOLLARS = 500;
const DEFAULT_ROTH_CONVERSION_BALANCE_RATIO_CAP = 0.12;
const DEFAULT_ROTH_CONVERSION_MAGI_BUFFER = 2_000;
const RAW_WITHDRAWAL_ORDER: AccountBucketType[] = ['cash', 'taxable', 'pretax', 'roth'];

const RETURN_GENERATION_ASSUMPTIONS: SimulationReturnGenerationAssumptions = {
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

const RETURN_MODEL_EXTENSION_POINTS: FutureReturnModelExtensionPoint[] = [
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

const TIMING_CONVENTIONS: SimulationTimingConventions = {
  currentPlanningYear: CURRENT_YEAR,
  salaryProrationRule: 'month_fraction',
  inflationCompounding: 'annual',
};

interface StrategyBehavior {
  mode: SimulationStrategyMode;
  plannerLogicActive: boolean;
  guardrailsEnabled: boolean;
  dynamicDefenseOrdering: boolean;
  irmaaAwareWithdrawalBuffer: boolean;
  preserveRothPreference: boolean;
  withdrawalOrderLabel: string[];
  acaAwareWithdrawalOptimization: boolean;
}

function resolveAcaFriendlyMagiCeiling(
  filingStatus: string,
  inflationIndex: number,
) {
  const householdSize = filingStatus === 'married_filing_jointly' ? 2 : 1;
  const baselineFpl = ACA_FPL_BY_HOUSEHOLD_SIZE[householdSize] ?? ACA_FPL_BY_HOUSEHOLD_SIZE[1];
  const cliffIncome = baselineFpl * 4;
  return Math.max(0, cliffIncome * inflationIndex - ACA_FRIENDLY_MAGI_BUFFER);
}

function getStrategyBehavior(
  mode: SimulationStrategyMode,
  plan: SimPlan,
): StrategyBehavior {
  const plannerLogicActive = mode === 'planner_enhanced';

  if (!plannerLogicActive) {
    return {
      mode,
      plannerLogicActive,
      guardrailsEnabled: false,
      dynamicDefenseOrdering: false,
      irmaaAwareWithdrawalBuffer: false,
      preserveRothPreference: false,
      withdrawalOrderLabel: [...RAW_WITHDRAWAL_ORDER],
      acaAwareWithdrawalOptimization: false,
    };
  }

  return {
    mode,
    plannerLogicActive,
    guardrailsEnabled: true,
    dynamicDefenseOrdering: true,
    irmaaAwareWithdrawalBuffer: plan.irmaaAware,
    preserveRothPreference: plan.preserveRoth,
    withdrawalOrderLabel: ['cash', 'taxable', 'pretax', 'roth (conditional)'],
    acaAwareWithdrawalOptimization: true,
  };
}

function buildWithdrawalOrder(
  plan: SimPlan,
  balances: Record<AccountBucketType, number>,
  marketState: 'normal' | 'down' | 'up',
  strategy: StrategyBehavior,
) {
  if (!strategy.plannerLogicActive) {
    return RAW_WITHDRAWAL_ORDER.filter((bucket) => balances[bucket] > 0);
  }

  const base = (['taxable', 'pretax'] as AccountBucketType[]).sort((left, right) => {
    if (!strategy.dynamicDefenseOrdering || marketState !== 'down') {
      return plan.accounts[left].withdrawalPriority - plan.accounts[right].withdrawalPriority;
    }

    const leftScore = getDefenseScore(
      plan.accounts[left].targetAllocation,
      plan.assetClassMappingAssumptions,
    );
    const rightResolvedScore = getDefenseScore(
      plan.accounts[right].targetAllocation,
      plan.assetClassMappingAssumptions,
    );
    return rightResolvedScore - leftScore;
  });

  const ordered: AccountBucketType[] = ['cash', ...base];
  if (balances.roth > 0) {
    ordered.push('roth');
  }
  return ordered;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function buildWithdrawalDecisionTrace(input: {
  needed: number;
  withdrawals: Record<AccountBucketType, number>;
  taxResult: YearTaxOutputs;
  assumptions: MarketAssumptions;
  strategy: StrategyBehavior;
  marketState: 'normal' | 'down' | 'up';
  acaFriendlyMagiCeiling: number | null;
}): WithdrawalDecisionTrace {
  const totalWithdrawal =
    input.withdrawals.cash +
    input.withdrawals.taxable +
    input.withdrawals.pretax +
    input.withdrawals.roth;
  const weightedTaxCost =
    input.withdrawals.cash * 0.05 +
    input.withdrawals.taxable * 0.35 +
    input.withdrawals.pretax * 0.9 +
    input.withdrawals.roth * 0.1;
  const marginalTaxCostScore =
    totalWithdrawal > 0
      ? clamp01(1 - weightedTaxCost / Math.max(1, totalWithdrawal * 0.9))
      : 1;

  const magiTargetCeiling = Math.min(
    input.acaFriendlyMagiCeiling ?? Number.POSITIVE_INFINITY,
    input.strategy.irmaaAwareWithdrawalBuffer ? input.assumptions.irmaaThreshold : Number.POSITIVE_INFINITY,
  );
  const magiTargetScore = Number.isFinite(magiTargetCeiling)
    ? clamp01(1 - Math.max(0, input.taxResult.MAGI - magiTargetCeiling) / 20_000)
    : 0.5;
  const acaCliffAvoidance =
    input.acaFriendlyMagiCeiling === null
      ? 0.5
      : clamp01(1 - Math.max(0, input.taxResult.MAGI - input.acaFriendlyMagiCeiling) / 15_000);
  const irmaaCliffAvoidance = input.strategy.irmaaAwareWithdrawalBuffer
    ? clamp01(1 - Math.max(0, input.taxResult.MAGI - input.assumptions.irmaaThreshold) / 15_000)
    : 0.5;
  const rothOptionality = input.strategy.preserveRothPreference && totalWithdrawal > 0
    ? clamp01(1 - input.withdrawals.roth / totalWithdrawal)
    : 0.5;
  const sequenceDefense = input.marketState === 'down'
    ? totalWithdrawal > 0
      ? clamp01((input.withdrawals.cash + input.withdrawals.taxable) / totalWithdrawal)
      : 0.5
    : 0.6;
  const spendingNeed = input.needed > 0 ? 1 : 0;

  const factorLabels: Array<{ key: keyof WithdrawalDecisionTrace['objectiveScores']; label: string }> = [
    { key: 'spendingNeed', label: 'spending need coverage' },
    { key: 'marginalTaxCost', label: 'marginal tax cost control' },
    { key: 'magiTarget', label: 'MAGI target control' },
    { key: 'acaCliffAvoidance', label: 'ACA cliff avoidance' },
    { key: 'irmaaCliffAvoidance', label: 'IRMAA cliff avoidance' },
    { key: 'rothOptionality', label: 'Roth optionality preservation' },
    { key: 'sequenceDefense', label: 'sequence-risk defense' },
  ];
  const objectiveScores = {
    spendingNeed,
    marginalTaxCost: marginalTaxCostScore,
    magiTarget: magiTargetScore,
    acaCliffAvoidance,
    irmaaCliffAvoidance,
    rothOptionality,
    sequenceDefense,
  };
  const topFactors = [...factorLabels]
    .sort(
      (left, right) => objectiveScores[right.key] - objectiveScores[left.key],
    )
    .slice(0, 2)
    .map((entry) => entry.label);

  return {
    rationale: `Source mix prioritized ${topFactors.join(' + ')}.`,
    objectiveScores,
  };
}

function withdrawForNeed(
  plan: SimPlan,
  balances: Record<AccountBucketType, number>,
  needed: number,
  marketState: 'normal' | 'down' | 'up',
  requiredRmdAmount: number,
  baseTaxInputs: YearTaxInputs,
  assumptions: MarketAssumptions,
  strategy: StrategyBehavior,
  acaFriendlyMagiCeiling: number | null,
) {
  const withdrawals: Record<AccountBucketType, number> = {
    pretax: 0,
    roth: 0,
    taxable: 0,
    cash: 0,
  };

  let remaining = needed;
  const order = buildWithdrawalOrder(plan, balances, marketState, strategy);
  const taxInputs: YearTaxInputs = {
    ...baseTaxInputs,
  };
  let taxResult: YearTaxOutputs = calculateFederalTax(taxInputs);

  const recalculateTax = () => {
    taxResult = calculateFederalTax(taxInputs);
  };

  let rmdWithdrawn = 0;
  if (requiredRmdAmount > 0 && balances.pretax > 0) {
    const requiredTake = Math.min(requiredRmdAmount, balances.pretax);
    balances.pretax -= requiredTake;
    withdrawals.pretax += requiredTake;
    taxInputs.ira401kWithdrawals += requiredTake;
    recalculateTax();
    rmdWithdrawn = requiredTake;

    const rmdAppliedToNeed = Math.min(remaining, requiredTake);
    remaining -= rmdAppliedToNeed;
    const excessRmd = requiredTake - rmdAppliedToNeed;
    if (excessRmd > 0) {
      balances.cash += excessRmd;
    }
  }

  order.forEach((bucket) => {
    if (remaining <= 0) {
      return;
    }

    if (remaining <= 0) {
      return;
    }

    let available = balances[bucket];
    if (available <= 0) {
      return;
    }

    if (bucket === 'pretax') {
      if (strategy.acaAwareWithdrawalOptimization && acaFriendlyMagiCeiling !== null) {
        const acaHeadroom = Math.max(acaFriendlyMagiCeiling - taxResult.MAGI, 0);
        available = Math.min(available, acaHeadroom);
      }
      if (strategy.irmaaAwareWithdrawalBuffer) {
        const irmaaHeadroom = Math.max(assumptions.irmaaThreshold - taxResult.MAGI, 0);
        available = Math.min(available, irmaaHeadroom);
      }

      if (
        available <= 0 &&
        strategy.preserveRothPreference &&
        balances.roth > 0 &&
        remaining > 0
      ) {
        const rothTake = Math.min(balances.roth, remaining);
        balances.roth -= rothTake;
        withdrawals.roth += rothTake;
        taxInputs.rothWithdrawals += rothTake;
        recalculateTax();
        remaining -= rothTake;
      }
    }

    if (available <= 0 || remaining <= 0) {
      return;
    }

    const take = Math.min(available, remaining);
    balances[bucket] -= take;
    withdrawals[bucket] += take;
    remaining -= take;

    if (bucket === 'pretax') {
      taxInputs.ira401kWithdrawals += take;
      recalculateTax();
    }

    if (bucket === 'taxable') {
      taxInputs.realizedLTCG += take * DEFAULT_TAXABLE_WITHDRAWAL_LTCG_RATIO;
      recalculateTax();
    }
  });

  const decisionTrace = buildWithdrawalDecisionTrace({
    needed,
    withdrawals,
    taxResult,
    assumptions,
    strategy,
    marketState,
    acaFriendlyMagiCeiling,
  });
  return { remaining, withdrawals, taxInputs, taxResult, rmdWithdrawn, decisionTrace };
}

function applyProactiveRothConversion(input: {
  balances: Record<AccountBucketType, number>;
  withdrawalResult: ReturnType<typeof withdrawForNeed>;
  strategy: StrategyBehavior;
  plan: SimPlan;
  assumptions: MarketAssumptions;
  requiredRmdAmount: number;
  yearsUntilRmdStart: number | null;
  isRetired: boolean;
  acaFriendlyMagiCeiling: number | null;
  medicareEligibleCount: number;
}): RothConversionTrace {
  const rawMAGI = Math.max(0, input.withdrawalResult.taxResult.MAGI);
  const irmaaThreshold = Number.isFinite(input.assumptions.irmaaThreshold)
    ? input.assumptions.irmaaThreshold
    : null;
  const magiBuffer = Math.max(0, input.plan.rothConversionPolicy.magiBufferDollars);
  const headroomComputed = irmaaThreshold !== null;
  const computedHeadroom = headroomComputed ? irmaaThreshold - rawMAGI - magiBuffer : 0;
  const mapSuppressedReason = (reason: string): string | null => {
    if (
      reason === 'blocked_by_aca_threshold' ||
      reason === 'blocked_by_irmaa_threshold' ||
      reason === 'blocked_by_irmaa_threshold_context' ||
      reason === 'blocked_by_other_planner_constraint_target_unavailable'
    ) {
      return 'no_headroom';
    }
    if (reason.startsWith('no_economic_benefit')) {
      return 'negative_score';
    }
    if (
      reason === 'blocked_by_available_pretax_balance' ||
      reason === 'not_eligible_pre_retirement' ||
      reason === 'planner_logic_inactive' ||
      reason === 'blocked_by_other_planner_constraint_policy_disabled'
    ) {
      return 'already_optimal';
    }
    return null;
  };
  const evaluateConversionScore = (
    conversionAmount: number,
    taxAfterConversion: ReturnType<typeof calculateFederalTax>,
  ) => {
    const pretaxBalance = Math.max(0, input.balances.pretax);
    const rothBalance = Math.max(0, input.balances.roth);
    const totalTaxAdvantagedBalance = Math.max(1, pretaxBalance + rothBalance);
    const yearsUntilRmd = Math.max(0, input.yearsUntilRmdStart ?? 8);
    const rmdProximity = clamp01((10 - yearsUntilRmd) / 10);
    const projectedRmdPressure = input.requiredRmdAmount > 0
      ? input.requiredRmdAmount
      : pretaxBalance / Math.max(14, yearsUntilRmd + 14);
    const projectedFutureMAGI =
      Math.max(0, input.withdrawalResult.taxResult.MAGI) +
      projectedRmdPressure +
      Math.max(0, pretaxBalance * 0.01);
    const currentTaxCost = Math.max(0, taxAfterConversion.federalTax - federalTaxBefore);
    const marginalTaxRate = conversionAmount > 0 ? currentTaxCost / conversionAmount : 0;
    const currentTaxRate = marginalTaxRate;
    const expectedFutureTaxRateLift =
      Math.min(0.12, projectedRmdPressure / Math.max(1, pretaxBalance)) +
      rmdProximity * 0.04;
    const expectedFutureTaxRate = Math.min(
      0.45,
      Math.max(currentTaxRate, currentTaxRate + expectedFutureTaxRateLift),
    );
    const futureTaxReduction = Math.max(
      0,
      (expectedFutureTaxRate - currentTaxRate) * conversionAmount * 0.85,
    );
    const irmaaAvoidanceValue =
      projectedFutureMAGI > input.assumptions.irmaaThreshold ? 0.15 * conversionAmount : 0;
    const rmdReductionValue = 0.12 * conversionAmount;
    const rothOptionalityValue = 0.05 * conversionAmount;
    const conversionScore =
      futureTaxReduction +
      irmaaAvoidanceValue +
      rmdReductionValue +
      rothOptionalityValue -
      currentTaxCost;
    const projectedPeakMagiReductionFromConversion = conversionAmount * (0.04 + rmdProximity * 0.12);
    const projectedFutureMagiPeak = Math.max(
      0,
      projectedFutureMAGI - projectedPeakMagiReductionFromConversion,
    );
    const projectedIrmaaExposure = Math.max(
      0,
      projectedFutureMagiPeak - input.assumptions.irmaaThreshold,
    );
    const rothShareBefore = rothBalance / totalTaxAdvantagedBalance;
    const rothShareAfter = clamp01((rothBalance + conversionAmount) / totalTaxAdvantagedBalance);
    return {
      conversionScore,
      conversionOpportunityScore: conversionScore,
      futureTaxReduction,
      futureTaxBurdenReduction: futureTaxReduction,
      irmaaAvoidanceValue,
      rmdReductionValue,
      rothOptionalityValue,
      futureTaxReductionValue: futureTaxReduction,
      currentTaxCost,
      projectedFutureMagiPeak,
      projectedRmdPressure,
      projectedIrmaaExposure,
      projectedRothShareAfter: rothShareAfter,
      rothShareBefore,
      rmdProximity,
      projectedFutureMAGI,
    };
  };
  const magiBaseline = input.withdrawalResult.taxResult.MAGI;
  const pretaxBalanceBaseline = input.balances.pretax;
  const noConversion = (
    reason: string,
    overrides?: Partial<Omit<RothConversionTrace, 'amount' | 'reason'>>,
  ): RothConversionTrace => ({
    amount: 0,
    reason,
    simulationModeUsedForConversion: input.strategy.mode,
    plannerLogicActiveAtConversion: input.strategy.plannerLogicActive,
    conversionEngineInvoked: true,
    evaluatedCandidateAmounts: [],
    bestCandidateAmount: 0,
    bestScore: 0,
    rawMAGI,
    irmaaThreshold,
    computedHeadroom,
    magiBuffer,
    headroomComputed,
    candidateAmountsGenerated: false,
    eligibilityBlockedReason: reason,
    magiEffect: 0,
    taxEffect: 0,
    acaEffect: 0,
    irmaaEffect: 0,
    pretaxBalanceEffect: 0,
    eligible: false,
    targetMagiCeiling: null,
    magiHeadroom: 0,
    magiBefore: magiBaseline,
    magiAfter: magiBaseline,
    pretaxBalanceBefore: pretaxBalanceBaseline,
    balanceCap: 0,
    conversionScore: 0,
    conversionOpportunityScore: 0,
    futureTaxReduction: 0,
    futureTaxBurdenReduction: 0,
    irmaaAvoidanceValue: 0,
    rmdReductionValue: 0,
    rothOptionalityValue: 0,
    futureTaxReductionValue: 0,
    currentTaxCost: 0,
    conversionSuppressedReason: mapSuppressedReason(reason),
    projectedFutureMagiPeak: magiBaseline,
    projectedRmdPressure: 0,
    projectedIrmaaExposure: 0,
    projectedRothShareAfter: 0,
    ...overrides,
  });

  if (!input.strategy.plannerLogicActive) {
    return noConversion('planner_logic_inactive');
  }
  if (!input.isRetired) {
    return noConversion('not_eligible_pre_retirement');
  }
  if (!input.plan.rothConversionPolicy.enabled) {
    return noConversion('blocked_by_other_planner_constraint_policy_disabled');
  }
  if (input.balances.pretax <= 0) {
    return noConversion('blocked_by_available_pretax_balance');
  }

  let targetMagiCeiling: number | null = null;
  let conversionReason = 'executed_irmaa_headroom_fill';
  let thresholdType: 'aca' | 'irmaa' | null = null;
  if (irmaaThreshold !== null) {
    targetMagiCeiling = Math.max(0, irmaaThreshold - magiBuffer);
    thresholdType = 'irmaa';
  }
  if (targetMagiCeiling === null) {
    return noConversion('blocked_by_other_planner_constraint_target_unavailable');
  }

  const magiBefore = rawMAGI;
  const federalTaxBefore = input.withdrawalResult.taxResult.federalTax;
  const pretaxBalanceBefore = input.balances.pretax;
  const acaOverageBefore =
    input.acaFriendlyMagiCeiling === null
      ? 0
      : Math.max(0, magiBefore - input.acaFriendlyMagiCeiling);
  const irmaaOverageBefore = input.strategy.irmaaAwareWithdrawalBuffer
    ? Math.max(0, magiBefore - input.assumptions.irmaaThreshold)
    : 0;
  const acaThreshold = input.acaFriendlyMagiCeiling;
  const alreadyAboveIrmaaThreshold = irmaaThreshold !== null && magiBefore > irmaaThreshold;

  const baselineBalanceCap =
    Math.max(0, input.balances.pretax) * input.plan.rothConversionPolicy.maxPretaxBalancePercent;
  let effectiveBalanceCap = baselineBalanceCap;
  const yearsUntilRmdStart = input.yearsUntilRmdStart;
  if (yearsUntilRmdStart !== null && yearsUntilRmdStart <= 8) {
    const targetDepletionYears = Math.max(2, yearsUntilRmdStart + 3);
    const smoothDepletionCap = Math.max(0, input.balances.pretax) / targetDepletionYears;
    if ((irmaaThreshold !== null && !alreadyAboveIrmaaThreshold) || yearsUntilRmdStart <= 3) {
      // Near RMD years we let the scorer consider more of the available pretax balance.
      effectiveBalanceCap = Math.max(effectiveBalanceCap, smoothDepletionCap);
    }
  }
  effectiveBalanceCap = Math.min(Math.max(0, input.balances.pretax), effectiveBalanceCap);

  const magiHeadroom = headroomComputed ? Math.max(0, computedHeadroom) : 0;
  const availableHeadroom = Math.min(
    Math.max(0, magiHeadroom),
    effectiveBalanceCap,
    Math.max(0, input.balances.pretax),
  );

  if (availableHeadroom <= 0) {
    return noConversion(
      'blocked_by_irmaa_threshold',
      {
        eligible: true,
        targetMagiCeiling,
        magiHeadroom: availableHeadroom,
        magiBefore,
        magiAfter: magiBefore,
        pretaxBalanceBefore,
        balanceCap: effectiveBalanceCap,
        eligibilityBlockedReason: 'no_headroom',
        conversionSuppressedReason: 'no_headroom',
      },
    );
  }

  const calculateTaxForConversion = (conversionAmount: number) =>
    calculateFederalTax({
      ...input.withdrawalResult.taxInputs,
      ira401kWithdrawals: input.withdrawalResult.taxInputs.ira401kWithdrawals + conversionAmount,
    });

  const MAGI_TOLERANCE_DOLLARS = 0.01;
  const evaluatedCandidateAmounts = [...new Set(
    [0.25, 0.5, 0.75, 1]
      .map((fraction) =>
        Number(Math.min(availableHeadroom * fraction, effectiveBalanceCap, input.balances.pretax).toFixed(2)))
      .filter((amount) => amount > 0),
  )].sort((left, right) => left - right);
  const candidateAmountsGenerated = evaluatedCandidateAmounts.length > 0;
  if (input.strategy.plannerLogicActive && availableHeadroom > 0 && !candidateAmountsGenerated) {
    throw new Error(
      'Roth conversion candidate generation failed in planner-enhanced mode despite positive headroom.',
    );
  }

  const candidateResults = evaluatedCandidateAmounts
    .filter((amount) => amount >= input.plan.rothConversionPolicy.minAnnualDollars)
    .map((amount) => {
      const taxAfterConversion = calculateTaxForConversion(amount);
      if (
        targetMagiCeiling !== null &&
        !(thresholdType === 'irmaa' && alreadyAboveIrmaaThreshold) &&
        taxAfterConversion.MAGI > targetMagiCeiling + MAGI_TOLERANCE_DOLLARS
      ) {
        return null;
      }
      return {
        amount,
        taxAfterConversion,
        evaluation: evaluateConversionScore(amount, taxAfterConversion),
      };
    })
    .filter((candidate): candidate is {
      amount: number;
      taxAfterConversion: ReturnType<typeof calculateFederalTax>;
      evaluation: ReturnType<typeof evaluateConversionScore>;
    } => candidate !== null);

  const bestCandidate = candidateResults.reduce<{
    amount: number;
    taxAfterConversion: ReturnType<typeof calculateFederalTax>;
    evaluation: ReturnType<typeof evaluateConversionScore>;
  } | null>((best, candidate) => {
    if (!best || candidate.evaluation.conversionScore > best.evaluation.conversionScore) {
      return candidate;
    }
    return best;
  }, null);

  const bestCandidateAmount = bestCandidate?.amount ?? 0;
  const bestEvaluation = bestCandidate?.evaluation ?? {
    conversionScore: 0,
    conversionOpportunityScore: 0,
    futureTaxReduction: 0,
    futureTaxBurdenReduction: 0,
    irmaaAvoidanceValue: 0,
    rmdReductionValue: 0,
    rothOptionalityValue: 0,
    futureTaxReductionValue: 0,
    currentTaxCost: 0,
    projectedFutureMagiPeak: magiBefore,
    projectedRmdPressure: 0,
    projectedIrmaaExposure: 0,
    projectedRothShareAfter: 0,
    rothShareBefore: 0,
    rmdProximity: 0,
    projectedFutureMAGI: magiBefore,
  };
  const bestScore = bestEvaluation.conversionScore;
  const currentTaxCost = bestEvaluation.currentTaxCost;
  const alreadyOptimal =
    Math.max(0, input.balances.pretax) <= 25_000 &&
    bestEvaluation.projectedIrmaaExposure <= 1 &&
    bestEvaluation.rmdProximity < 0.1 &&
    bestEvaluation.rothShareBefore >= 0.65;

  if (alreadyOptimal) {
    return noConversion('no_economic_benefit_already_optimal', {
        eligible: true,
        targetMagiCeiling,
        magiHeadroom: availableHeadroom,
        magiBefore,
        magiAfter: magiBefore,
        pretaxBalanceBefore,
        balanceCap: effectiveBalanceCap,
        evaluatedCandidateAmounts,
        candidateAmountsGenerated,
        bestCandidateAmount,
        bestScore,
        conversionScore: bestEvaluation.conversionScore,
      conversionOpportunityScore: bestEvaluation.conversionOpportunityScore,
      futureTaxReduction: bestEvaluation.futureTaxReduction,
      futureTaxBurdenReduction: bestEvaluation.futureTaxBurdenReduction,
      irmaaAvoidanceValue: bestEvaluation.irmaaAvoidanceValue,
      rmdReductionValue: bestEvaluation.rmdReductionValue,
      rothOptionalityValue: bestEvaluation.rothOptionalityValue,
        futureTaxReductionValue: bestEvaluation.futureTaxReductionValue,
        currentTaxCost,
        eligibilityBlockedReason: 'already_optimal',
        conversionSuppressedReason: 'already_optimal',
        projectedFutureMagiPeak: bestEvaluation.projectedFutureMagiPeak,
        projectedRmdPressure: bestEvaluation.projectedRmdPressure,
      projectedIrmaaExposure: bestEvaluation.projectedIrmaaExposure,
      projectedRothShareAfter: bestEvaluation.projectedRothShareAfter,
    });
  }

  if (!candidateResults.length || bestScore <= 0) {
    return noConversion('no_economic_benefit_negative_score', {
        eligible: true,
        targetMagiCeiling,
        magiHeadroom: availableHeadroom,
        magiBefore,
        magiAfter: magiBefore,
        pretaxBalanceBefore,
        balanceCap: effectiveBalanceCap,
        evaluatedCandidateAmounts,
        candidateAmountsGenerated,
        bestCandidateAmount,
        bestScore,
        conversionScore: bestEvaluation.conversionScore,
      conversionOpportunityScore: bestEvaluation.conversionOpportunityScore,
      futureTaxReduction: bestEvaluation.futureTaxReduction,
      futureTaxBurdenReduction: bestEvaluation.futureTaxBurdenReduction,
      irmaaAvoidanceValue: bestEvaluation.irmaaAvoidanceValue,
      rmdReductionValue: bestEvaluation.rmdReductionValue,
      rothOptionalityValue: bestEvaluation.rothOptionalityValue,
        futureTaxReductionValue: bestEvaluation.futureTaxReductionValue,
        currentTaxCost,
        eligibilityBlockedReason: candidateResults.length ? 'negative_score' : 'no_headroom',
        conversionSuppressedReason: candidateResults.length ? 'negative_score' : 'no_headroom',
        projectedFutureMagiPeak: bestEvaluation.projectedFutureMagiPeak,
        projectedRmdPressure: bestEvaluation.projectedRmdPressure,
      projectedIrmaaExposure: bestEvaluation.projectedIrmaaExposure,
      projectedRothShareAfter: bestEvaluation.projectedRothShareAfter,
    });
  }

  const conversionAmount = bestCandidateAmount;
  const taxAfterConversion = bestCandidate!.taxAfterConversion;

  input.balances.pretax -= conversionAmount;
  input.balances.roth += conversionAmount;
  input.withdrawalResult.taxInputs.ira401kWithdrawals += conversionAmount;
  input.withdrawalResult.taxResult = taxAfterConversion;

  const magiAfter = input.withdrawalResult.taxResult.MAGI;
  const federalTaxAfter = input.withdrawalResult.taxResult.federalTax;
  const acaOverageAfter =
    input.acaFriendlyMagiCeiling === null
      ? 0
      : Math.max(0, magiAfter - input.acaFriendlyMagiCeiling);
  const irmaaOverageAfter = input.strategy.irmaaAwareWithdrawalBuffer
    ? Math.max(0, magiAfter - input.assumptions.irmaaThreshold)
    : 0;

  return {
    amount: conversionAmount,
    reason: conversionReason,
    simulationModeUsedForConversion: input.strategy.mode,
    plannerLogicActiveAtConversion: input.strategy.plannerLogicActive,
    conversionEngineInvoked: true,
    evaluatedCandidateAmounts,
    bestCandidateAmount,
    bestScore,
    rawMAGI,
    irmaaThreshold,
    computedHeadroom,
    magiBuffer,
    headroomComputed,
    candidateAmountsGenerated,
    eligibilityBlockedReason: null,
    magiEffect: magiAfter - magiBefore,
    taxEffect: federalTaxAfter - federalTaxBefore,
    acaEffect: acaOverageAfter - acaOverageBefore,
    irmaaEffect: irmaaOverageAfter - irmaaOverageBefore,
    pretaxBalanceEffect: input.balances.pretax - pretaxBalanceBefore,
    eligible: true,
    targetMagiCeiling,
    magiHeadroom: availableHeadroom,
    magiBefore,
    magiAfter,
    pretaxBalanceBefore,
    balanceCap: effectiveBalanceCap,
    conversionScore: bestEvaluation.conversionScore,
    conversionOpportunityScore: bestEvaluation.conversionOpportunityScore,
    futureTaxReduction: bestEvaluation.futureTaxReduction,
    futureTaxBurdenReduction: bestEvaluation.futureTaxBurdenReduction,
    irmaaAvoidanceValue: bestEvaluation.irmaaAvoidanceValue,
    rmdReductionValue: bestEvaluation.rmdReductionValue,
    rothOptionalityValue: bestEvaluation.rothOptionalityValue,
    futureTaxReductionValue: bestEvaluation.futureTaxReductionValue,
    currentTaxCost,
    conversionSuppressedReason: null,
    projectedFutureMagiPeak: bestEvaluation.projectedFutureMagiPeak,
    projectedRmdPressure: bestEvaluation.projectedRmdPressure,
    projectedIrmaaExposure: bestEvaluation.projectedIrmaaExposure,
    projectedRothShareAfter: bestEvaluation.projectedRothShareAfter,
  };
}

function buildInactiveRothConversionTrace(input: {
  strategy: StrategyBehavior;
  withdrawalResult: ReturnType<typeof withdrawForNeed>;
  balances: Record<AccountBucketType, number>;
}): RothConversionTrace {
  const rawMAGI = Math.max(0, input.withdrawalResult.taxResult.MAGI);
  const pretaxBalanceBefore = Math.max(0, input.balances.pretax);
  return {
    amount: 0,
    reason: 'simulation_mode_raw',
    simulationModeUsedForConversion: input.strategy.mode,
    plannerLogicActiveAtConversion: input.strategy.plannerLogicActive,
    conversionEngineInvoked: false,
    evaluatedCandidateAmounts: [],
    bestCandidateAmount: 0,
    bestScore: 0,
    rawMAGI,
    irmaaThreshold: null,
    computedHeadroom: 0,
    magiBuffer: 0,
    headroomComputed: false,
    candidateAmountsGenerated: false,
    eligibilityBlockedReason: 'simulation_mode_raw',
    magiEffect: 0,
    taxEffect: 0,
    acaEffect: 0,
    irmaaEffect: 0,
    pretaxBalanceEffect: 0,
    eligible: false,
    targetMagiCeiling: null,
    magiHeadroom: 0,
    magiBefore: rawMAGI,
    magiAfter: rawMAGI,
    pretaxBalanceBefore,
    balanceCap: 0,
    conversionScore: 0,
    conversionOpportunityScore: 0,
    futureTaxReduction: 0,
    futureTaxBurdenReduction: 0,
    irmaaAvoidanceValue: 0,
    rmdReductionValue: 0,
    rothOptionalityValue: 0,
    futureTaxReductionValue: 0,
    currentTaxCost: 0,
    conversionSuppressedReason: 'already_optimal',
    projectedFutureMagiPeak: rawMAGI,
    projectedRmdPressure: 0,
    projectedIrmaaExposure: 0,
    projectedRothShareAfter: 0,
  };
}

function summarizeFailureMode(results: SimulationRunResult[], activeStressors: string[]) {
  const reasons = new Map<string, number>();

  results.forEach((result) => {
    reasons.set(result.failureReason, (reasons.get(result.failureReason) ?? 0) + 1);
  });

  if (results.every((result) => result.success)) {
    if (activeStressors.includes('market_down')) {
      return 'guardrails absorb most sequence-risk damage before the plan looks trapped';
    }
    return 'the current path keeps essential spending funded without forcing a panic response';
  }

  return [...reasons.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ??
    'assets run short before the end of the planning horizon';
}

function getRiskLabel(rate: number): 'Low' | 'Medium' | 'High' {
  if (rate >= 0.66) {
    return 'High';
  }

  if (rate >= 0.33) {
    return 'Medium';
  }

  return 'Low';
}

function getExposureLabel(rate: number): 'Low' | 'Medium' | 'High' {
  if (rate >= 0.5) {
    return 'High';
  }

  if (rate >= 0.2) {
    return 'Medium';
  }

  return 'Low';
}

function buildSimulationConfigurationSnapshot({
  assumptions,
  plan,
  stressors,
  responses,
  strategy,
}: {
  assumptions: MarketAssumptions;
  plan: SimPlan;
  stressors: Stressor[];
  responses: ResponseOption[];
  strategy: StrategyBehavior;
}): SimulationConfigurationSnapshot {
  return {
    mode: strategy.mode,
    plannerLogicActive: strategy.plannerLogicActive,
    activeStressors: stressors.map((item) => item.id),
    activeResponses: responses.map((item) => item.id),
    withdrawalPolicy: {
      order: strategy.withdrawalOrderLabel,
      dynamicDefenseOrdering: strategy.dynamicDefenseOrdering,
      irmaaAware: strategy.irmaaAwareWithdrawalBuffer,
      acaAware: strategy.acaAwareWithdrawalOptimization,
      preserveRothPreference: strategy.preserveRothPreference,
      closedLoopHealthcareTaxIteration: true,
      maxClosedLoopPasses: DEFAULT_MAX_CLOSED_LOOP_PASSES,
      closedLoopConvergenceThresholds: {
        ...DEFAULT_CLOSED_LOOP_CONVERGENCE_THRESHOLDS,
      } satisfies ClosedLoopConvergenceThresholds,
    },
    rothConversionPolicy: {
      proactiveConversionsEnabled: strategy.plannerLogicActive,
      strategy: plan.rothConversionPolicy.strategy,
      minAnnualDollars: plan.rothConversionPolicy.minAnnualDollars,
      maxPretaxBalancePercent: plan.rothConversionPolicy.maxPretaxBalancePercent,
      magiBufferDollars: plan.rothConversionPolicy.magiBufferDollars,
      source: plan.rothConversionPolicy.source,
      description: strategy.plannerLogicActive
        ? 'Planner-enhanced simulation applies deterministic Roth conversion headroom rules in-year.'
        : 'Raw simulation mode does not run proactive Roth conversions.',
    },
    liquidityFloorBehavior: {
      guardrailsEnabled: strategy.guardrailsEnabled,
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
    timingConventions: TIMING_CONVENTIONS,
    simulationSettings: {
      seed: assumptions.simulationSeed ?? 20260416,
      runCount: Math.max(1, assumptions.simulationRuns),
      assumptionsVersion: assumptions.assumptionsVersion ?? 'v1',
    },
  };
}

function buildSimulationModeDiagnostics({
  yearlySeries,
  failureYearDistribution,
  runs,
}: {
  yearlySeries: PathYearResult[];
  failureYearDistribution: Array<{ year: number; count: number; rate: number }>;
  runs: SimulationRunResult[];
}): SimulationModeDiagnostics {
  const toStopReason = (value: string): ClosedLoopStopReason =>
    value === 'converged_thresholds_met'
      ? 'converged_thresholds_met'
      : value === 'no_change'
        ? 'no_change'
        : value === 'oscillation_detected'
          ? 'oscillation_detected'
          : 'max_pass_limit_reached';
  const averageConvergedRate = yearlySeries.length
    ? yearlySeries.reduce((sum, point) => sum + point.closedLoopConvergedRate, 0) /
      yearlySeries.length
    : 0;
  const averageConvergedBeforeMaxPassesRate = yearlySeries.length
    ? yearlySeries.reduce((sum, point) => sum + point.closedLoopConvergedBeforeMaxPassesRate, 0) /
      yearlySeries.length
    : 0;
  const summaryPasses = yearlySeries.length
    ? median(yearlySeries.map((point) => point.closedLoopPassesUsed))
    : 0;
  const summaryFinalMagiDelta = yearlySeries.length
    ? median(yearlySeries.map((point) => point.finalMagiDelta))
    : 0;
  const summaryFinalFederalTaxDelta = yearlySeries.length
    ? median(yearlySeries.map((point) => point.finalFederalTaxDelta))
    : 0;
  const summaryFinalHealthcareDelta = yearlySeries.length
    ? median(yearlySeries.map((point) => point.finalHealthcarePremiumDelta))
    : 0;
  let rothDecisionYearCount = 0;
  let rothExecutedYearCount = 0;
  let rothBlockedYearCount = 0;
  let rothNoEconomicBenefitYearCount = 0;
  let rothNotEligibleYearCount = 0;
  const rothDecisionReasonCounts = new Map<string, number>();
  runs.forEach((run) => {
    run.yearly.forEach((trace) => {
      rothDecisionYearCount += 1;
      rothDecisionReasonCounts.set(
        trace.rothConversionReason,
        (rothDecisionReasonCounts.get(trace.rothConversionReason) ?? 0) + 1,
      );
      if (trace.rothConversion > 0) {
        rothExecutedYearCount += 1;
      } else if (trace.rothConversionReason.startsWith('no_economic_benefit')) {
        rothNoEconomicBenefitYearCount += 1;
      } else if (trace.rothConversionReason.startsWith('not_eligible')) {
        rothNotEligibleYearCount += 1;
      } else {
        rothBlockedYearCount += 1;
      }
    });
  });
  const rothDecisionReasons = [...rothDecisionReasonCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([reason, count]) => ({
      reason,
      count,
      rate: rothDecisionYearCount > 0 ? count / rothDecisionYearCount : 0,
    }));
  const tracesByYear = new Map<number, RunTrace[]>();
  runs.forEach((run) => {
    run.yearly.forEach((trace) => {
      if (!tracesByYear.has(trace.year)) {
        tracesByYear.set(trace.year, []);
      }
      tracesByYear.get(trace.year)?.push(trace);
    });
  });
  const rothConversionEligibilityPath = yearlySeries.map((point) => {
    const yearTraces = tracesByYear.get(point.year) ?? [];
    if (!yearTraces.length) {
      return {
        year: point.year,
        evaluatedCandidateAmounts: [],
        bestCandidateAmount: 0,
        bestScore: 0,
        conversionExecuted: false,
        simulationModeUsedForConversion: 'raw_simulation' as SimulationStrategyMode,
        plannerLogicActiveAtConversion: false,
        conversionEngineInvoked: false,
        rawMAGI: 0,
        irmaaThreshold: null,
        computedHeadroom: 0,
        magiBuffer: 0,
        headroomComputed: false,
        candidateAmountsGenerated: false,
        eligibilityBlockedReason: 'simulation_mode_raw',
        executedRunRate: 0,
        eligibleRunRate: 0,
        blockedRunRate: 0,
        noEconomicBenefitRunRate: 0,
        notEligibleRunRate: 0,
        representativeAmount: 0,
        representativeReason: 'simulation_mode_raw',
        representativeMagiEffect: 0,
        representativeTaxEffect: 0,
        representativeAcaEffect: 0,
        representativeIrmaaEffect: 0,
        representativePretaxBalanceEffect: 0,
        representativeWithdrawalRoth: 0,
        representativeRothBalanceStart: 0,
        representativeRothBalanceEnd: 0,
        representativeRothContributionFlow: 0,
        representativeRothMarketGainLoss: 0,
        representativeRothNetChange: 0,
        representativeRothBalanceReconciliationDelta: 0,
        withdrawalRothMedianAllRuns: point.medianWithdrawalRoth,
        conversionScore: 0,
        conversionOpportunityScore: 0,
        futureTaxReduction: 0,
        futureTaxBurdenReduction: 0,
        irmaaAvoidanceValue: 0,
        rmdReductionValue: 0,
        rothOptionalityValue: 0,
        future_tax_reduction_value: 0,
        currentTaxCost: 0,
        conversionSuppressedReason: 'no_headroom',
        projectedFutureMagiPeak: 0,
        projectedRmdPressure: 0,
        projectedIrmaaExposure: 0,
        projectedRothShareAfter: 0,
        medianMagiBefore: 0,
        medianMagiAfter: 0,
        medianTargetMagiCeiling: null,
      };
    }
    const executedTraces = yearTraces.filter((trace) => trace.rothConversion > 0);
    const noEconomicBenefitTraces = yearTraces.filter((trace) =>
      trace.rothConversionReason.startsWith('no_economic_benefit'),
    );
    const notEligibleTraces = yearTraces.filter((trace) =>
      trace.rothConversionReason.startsWith('not_eligible'),
    );
    const blockedTraces = yearTraces.filter((trace) =>
      trace.rothConversion <= 0 &&
      !trace.rothConversionReason.startsWith('no_economic_benefit') &&
      !trace.rothConversionReason.startsWith('not_eligible'),
    );
    const representativeSet = executedTraces.length > 0 ? executedTraces : yearTraces;
    const representativeAmountValue = executedTraces.length > 0
      ? median(executedTraces.map((trace) => trace.rothConversion))
      : 0;
    const representativeTrace = representativeSet.reduce((best, trace) => {
      if (!best) {
        return trace;
      }
      const bestDistance = Math.abs(best.rothConversion - representativeAmountValue);
      const traceDistance = Math.abs(trace.rothConversion - representativeAmountValue);
      return traceDistance < bestDistance ? trace : best;
    }, representativeSet[0]);
    const targetMagiValues = representativeSet
      .map((trace) => trace.rothConversionTargetMagiCeiling)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    return {
      year: point.year,
      evaluatedCandidateAmounts: representativeTrace?.rothConversionCandidateAmounts ?? [],
      bestCandidateAmount: representativeTrace?.rothConversionBestCandidateAmount ?? 0,
      bestScore: representativeTrace?.rothConversionBestScore ?? 0,
      conversionExecuted: executedTraces.length > 0,
      simulationModeUsedForConversion:
        representativeTrace?.rothConversionSimulationModeUsed ?? 'raw_simulation',
      plannerLogicActiveAtConversion:
        representativeSet.filter((trace) => trace.rothConversionPlannerLogicActiveAtConversion).length /
          representativeSet.length >= 0.5,
      conversionEngineInvoked:
        representativeSet.filter((trace) => trace.rothConversionEngineInvoked).length /
          representativeSet.length >= 0.5,
      rawMAGI: median(representativeSet.map((trace) => trace.rothConversionRawMAGI)),
      irmaaThreshold: (() => {
        const values = representativeSet
          .map((trace) => trace.rothConversionIrmaaThreshold)
          .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
        return values.length > 0 ? median(values) : null;
      })(),
      computedHeadroom: median(
        representativeSet.map((trace) => trace.rothConversionComputedHeadroom),
      ),
      magiBuffer: median(representativeSet.map((trace) => trace.rothConversionMagiBuffer)),
      headroomComputed:
        representativeSet.filter((trace) => trace.rothConversionHeadroomComputed).length /
          representativeSet.length >= 0.5,
      candidateAmountsGenerated:
        representativeSet.filter((trace) => trace.rothConversionCandidateAmountsGenerated).length /
          representativeSet.length >= 0.5,
      eligibilityBlockedReason:
        executedTraces.length > 0
          ? null
          : (() => {
              const reasons = representativeSet
                .map((trace) => trace.rothConversionEligibilityBlockedReason)
                .filter((reason): reason is string => Boolean(reason));
              return reasons.length > 0 ? dominantValue(reasons) : null;
            })(),
      executedRunRate: executedTraces.length / yearTraces.length,
      eligibleRunRate: yearTraces.filter((trace) => trace.rothConversionEligible).length /
        yearTraces.length,
      blockedRunRate: blockedTraces.length / yearTraces.length,
      noEconomicBenefitRunRate: noEconomicBenefitTraces.length / yearTraces.length,
      notEligibleRunRate: notEligibleTraces.length / yearTraces.length,
      representativeAmount: representativeAmountValue,
      representativeReason:
        executedTraces.length > 0
          ? dominantValue(executedTraces.map((trace) => trace.rothConversionReason))
          : dominantValue(yearTraces.map((trace) => trace.rothConversionReason)),
      representativeMagiEffect:
        executedTraces.length > 0
          ? median(executedTraces.map((trace) => trace.rothConversionMagiEffect))
          : 0,
      representativeTaxEffect:
        executedTraces.length > 0
          ? median(executedTraces.map((trace) => trace.rothConversionTaxEffect))
          : 0,
      representativeAcaEffect:
        executedTraces.length > 0
          ? median(executedTraces.map((trace) => trace.rothConversionAcaEffect))
          : 0,
      representativeIrmaaEffect:
        executedTraces.length > 0
          ? median(executedTraces.map((trace) => trace.rothConversionIrmaaEffect))
          : 0,
      representativePretaxBalanceEffect:
        executedTraces.length > 0
          ? median(executedTraces.map((trace) => trace.rothConversionPretaxBalanceEffect))
          : 0,
      representativeWithdrawalRoth: median(
        representativeSet.map((trace) => trace.withdrawalRoth),
      ),
      representativeRothBalanceStart: median(
        representativeSet.map((trace) => trace.rothBalanceStart),
      ),
      representativeRothBalanceEnd: median(
        representativeSet.map((trace) => trace.rothBalanceEnd),
      ),
      representativeRothContributionFlow: median(
        representativeSet.map((trace) => trace.rothContributionFlow),
      ),
      representativeRothMarketGainLoss: median(
        representativeSet.map((trace) => trace.rothMarketGainLoss),
      ),
      representativeRothNetChange: median(
        representativeSet.map((trace) => trace.rothNetChange),
      ),
      representativeRothBalanceReconciliationDelta: median(
        representativeSet.map((trace) => trace.rothBalanceReconciliationDelta),
      ),
      withdrawalRothMedianAllRuns: point.medianWithdrawalRoth,
      conversionScore: median(
        representativeSet.map((trace) => trace.rothConversionScore),
      ),
      conversionOpportunityScore: median(
        representativeSet.map((trace) => trace.rothConversionOpportunityScore),
      ),
      futureTaxReduction: median(
        representativeSet.map((trace) => trace.rothConversionFutureTaxReduction),
      ),
      futureTaxBurdenReduction: median(
        representativeSet.map((trace) => trace.rothConversionFutureTaxBurdenReduction),
      ),
      irmaaAvoidanceValue: median(
        representativeSet.map((trace) => trace.rothConversionIrmaaAvoidanceValue),
      ),
      rmdReductionValue: median(
        representativeSet.map((trace) => trace.rothConversionRmdReductionValue),
      ),
      rothOptionalityValue: median(
        representativeSet.map((trace) => trace.rothConversionRothOptionalityValue),
      ),
      future_tax_reduction_value: median(
        representativeSet.map((trace) => trace.rothConversionFutureTaxReductionValue),
      ),
      currentTaxCost: median(
        representativeSet.map((trace) => trace.rothConversionCurrentTaxCost),
      ),
      conversionSuppressedReason:
        executedTraces.length > 0
          ? null
          : (() => {
              const suppressedReasons = yearTraces
                .map((trace) => trace.rothConversionSuppressedReason)
                .filter((reason): reason is string => Boolean(reason));
              return suppressedReasons.length > 0
                ? dominantValue(suppressedReasons)
                : 'already_optimal';
            })(),
      projectedFutureMagiPeak: median(
        representativeSet.map((trace) => trace.rothConversionProjectedFutureMagiPeak),
      ),
      projectedRmdPressure: median(
        representativeSet.map((trace) => trace.rothConversionProjectedRmdPressure),
      ),
      projectedIrmaaExposure: median(
        representativeSet.map((trace) => trace.rothConversionProjectedIrmaaExposure),
      ),
      projectedRothShareAfter: median(
        representativeSet.map((trace) => trace.rothConversionProjectedRothShareAfter),
      ),
      medianMagiBefore: median(representativeSet.map((trace) => trace.rothConversionMagiBefore)),
      medianMagiAfter: median(representativeSet.map((trace) => trace.rothConversionMagiAfter)),
      medianTargetMagiCeiling: targetMagiValues.length > 0 ? median(targetMagiValues) : null,
    };
  });
  const runConvergence = runs.map((run, runIndex) => {
    const converged = run.closedLoopYearsEvaluated > 0 &&
      run.closedLoopYearsConverged === run.closedLoopYearsEvaluated;
    return {
      runIndex,
      converged,
      convergedYearRate:
        run.closedLoopYearsEvaluated > 0
          ? run.closedLoopYearsConverged / run.closedLoopYearsEvaluated
          : 0,
      yearsEvaluated: run.closedLoopYearsEvaluated,
      passesUsedMax: run.closedLoopPassesUsedMax,
      stopReasonCounts: {
        converged_thresholds_met: run.closedLoopStopReasonCounts.converged_thresholds_met,
        max_pass_limit_reached: run.closedLoopStopReasonCounts.max_pass_limit_reached,
        no_change: run.closedLoopStopReasonCounts.no_change,
        oscillation_detected: run.closedLoopStopReasonCounts.oscillation_detected,
      },
      finalMagiDeltaMax: run.closedLoopFinalMagiDeltaMax,
      finalFederalTaxDeltaMax: run.closedLoopFinalFederalTaxDeltaMax,
      finalHealthcarePremiumDeltaMax: run.closedLoopFinalHealthcarePremiumDeltaMax,
    };
  });
  const convergedRunCount = runConvergence.filter((run) => run.converged).length;
  const allRunsConverged = runs.length > 0 && convergedRunCount === runs.length;
  const convergedBeforeMaxPassesRunCount = runConvergence.filter(
    (run) => run.converged && run.passesUsedMax < DEFAULT_MAX_CLOSED_LOOP_PASSES,
  ).length;
  const nonConvergedRunIndexes = runConvergence
    .filter((run) => !run.converged)
    .map((run) => run.runIndex);
  const summaryStopReasonCounts = {
    converged_thresholds_met: runs.reduce(
      (sum, run) => sum + run.closedLoopStopReasonCounts.converged_thresholds_met,
      0,
    ),
    max_pass_limit_reached: runs.reduce(
      (sum, run) => sum + run.closedLoopStopReasonCounts.max_pass_limit_reached,
      0,
    ),
    no_change: runs.reduce((sum, run) => sum + run.closedLoopStopReasonCounts.no_change, 0),
    oscillation_detected: runs.reduce(
      (sum, run) => sum + run.closedLoopStopReasonCounts.oscillation_detected,
      0,
    ),
  };
  const dominantSummaryStopReason: ClosedLoopStopReason =
    summaryStopReasonCounts.converged_thresholds_met >=
      summaryStopReasonCounts.max_pass_limit_reached &&
    summaryStopReasonCounts.converged_thresholds_met >= summaryStopReasonCounts.no_change
      ? 'converged_thresholds_met'
      : summaryStopReasonCounts.no_change >=
            summaryStopReasonCounts.max_pass_limit_reached
        ? 'no_change'
        : 'max_pass_limit_reached';
  const nonConvergedRuns = runConvergence.filter((run) => !run.converged);
  const summaryFinalMagiDeltaValue = allRunsConverged
    ? summaryFinalMagiDelta
    : nonConvergedRuns.length
      ? Math.max(...nonConvergedRuns.map((run) => run.finalMagiDeltaMax))
      : summaryFinalMagiDelta;
  const summaryFinalFederalTaxDeltaValue = allRunsConverged
    ? summaryFinalFederalTaxDelta
    : nonConvergedRuns.length
      ? Math.max(...nonConvergedRuns.map((run) => run.finalFederalTaxDeltaMax))
      : summaryFinalFederalTaxDelta;
  const summaryFinalHealthcareDeltaValue = allRunsConverged
    ? summaryFinalHealthcareDelta
    : nonConvergedRuns.length
      ? Math.max(...nonConvergedRuns.map((run) => run.finalHealthcarePremiumDeltaMax))
      : summaryFinalHealthcareDelta;

  return {
    effectiveSpendPath: yearlySeries.map((point) => ({
      year: point.year,
      value: point.medianSpending,
    })),
    withdrawalPath: yearlySeries.map((point) => ({
      year: point.year,
      cash: point.medianWithdrawalCash,
      taxable: point.medianWithdrawalTaxable,
      ira401k: point.medianWithdrawalIra401k,
      roth: point.medianWithdrawalRoth,
    })),
    withdrawalRationalePath: yearlySeries.map((point) => ({
      year: point.year,
      rationale: point.dominantWithdrawalRationale,
      objectiveScores: {
        spendingNeed: point.medianWithdrawalScoreSpendingNeed,
        marginalTaxCost: point.medianWithdrawalScoreMarginalTaxCost,
        magiTarget: point.medianWithdrawalScoreMagiTarget,
        acaCliffAvoidance: point.medianWithdrawalScoreAcaCliffAvoidance,
        irmaaCliffAvoidance: point.medianWithdrawalScoreIrmaaCliffAvoidance,
        rothOptionality: point.medianWithdrawalScoreRothOptionality,
        sequenceDefense: point.medianWithdrawalScoreSequenceDefense,
      },
    })),
    taxesPaidPath: yearlySeries.map((point) => ({
      year: point.year,
      value: point.medianFederalTax,
    })),
    magiPath: yearlySeries.map((point) => ({
      year: point.year,
      value: point.medianMagi,
    })),
    conversionPath: rothConversionEligibilityPath.map((point) => ({
      year: point.year,
      value: point.representativeAmount,
    })),
    rothConversionTracePath: rothConversionEligibilityPath.map((point) => ({
      year: point.year,
      amount: point.representativeAmount,
      reason: point.representativeReason,
      simulationModeUsedForConversion: point.simulationModeUsedForConversion,
      plannerLogicActiveAtConversion: point.plannerLogicActiveAtConversion,
      conversionEngineInvoked: point.conversionEngineInvoked,
      evaluatedCandidateAmounts: point.evaluatedCandidateAmounts,
      bestCandidateAmount: point.bestCandidateAmount,
      bestScore: point.bestScore,
      conversionExecuted: point.conversionExecuted,
      rawMAGI: point.rawMAGI,
      irmaaThreshold: point.irmaaThreshold,
      computedHeadroom: point.computedHeadroom,
      magiBuffer: point.magiBuffer,
      headroomComputed: point.headroomComputed,
      candidateAmountsGenerated: point.candidateAmountsGenerated,
      eligibilityBlockedReason: point.eligibilityBlockedReason,
      conversionReason: point.representativeReason,
      conversionScore: point.conversionScore,
      currentTaxCost: point.currentTaxCost,
      futureTaxReduction: point.futureTaxReduction,
      irmaaAvoidanceValue: point.irmaaAvoidanceValue,
      rmdReductionValue: point.rmdReductionValue,
      rothOptionalityValue: point.rothOptionalityValue,
      conversionSuppressedReason: point.conversionSuppressedReason,
      magiEffect: point.representativeMagiEffect,
      taxEffect: point.representativeTaxEffect,
      acaEffect: point.representativeAcaEffect,
      irmaaEffect: point.representativeIrmaaEffect,
      pretaxBalanceEffect: point.representativePretaxBalanceEffect,
      withdrawalRoth: point.withdrawalRothMedianAllRuns,
      representativeWithdrawalRoth: point.representativeWithdrawalRoth,
      rothBalanceStart: point.representativeRothBalanceStart,
      rothBalanceEnd: point.representativeRothBalanceEnd,
      rothContributionFlow: point.representativeRothContributionFlow,
      rothMarketGainLoss: point.representativeRothMarketGainLoss,
      rothNetChange: point.representativeRothNetChange,
      rothBalanceReconciliationDelta: point.representativeRothBalanceReconciliationDelta,
    })),
    rothConversionEligibilityPath,
    rothConversionDecisionSummary: {
      executedYearCount: rothExecutedYearCount,
      blockedYearCount: rothBlockedYearCount,
      noEconomicBenefitYearCount: rothNoEconomicBenefitYearCount,
      notEligibleYearCount: rothNotEligibleYearCount,
      reasons: rothDecisionReasons,
    },
    failureYearDistribution,
    closedLoopConvergenceSummary: {
      converged: allRunsConverged,
      convergedRate: averageConvergedRate,
      passesUsed: summaryPasses,
      stopReason: dominantSummaryStopReason,
      finalMagiDelta: summaryFinalMagiDeltaValue,
      finalFederalTaxDelta: summaryFinalFederalTaxDeltaValue,
      finalHealthcarePremiumDelta: summaryFinalHealthcareDeltaValue,
      convergedBeforeMaxPasses:
        runs.length > 0 && convergedBeforeMaxPassesRunCount === runs.length,
      convergedBeforeMaxPassesRate:
        runs.length > 0 ? convergedBeforeMaxPassesRunCount / runs.length : 0,
    },
    closedLoopConvergencePath: yearlySeries.map((point) => ({
      year: point.year,
      converged: point.closedLoopConverged,
      convergedRate: point.closedLoopConvergedRate,
      passesUsed: point.closedLoopPassesUsed,
      stopReason: toStopReason(point.dominantClosedLoopStopReason),
      finalMagiDelta: point.finalMagiDelta,
      finalFederalTaxDelta: point.finalFederalTaxDelta,
      finalHealthcarePremiumDelta: point.finalHealthcarePremiumDelta,
      convergedBeforeMaxPasses: point.closedLoopConvergedBeforeMaxPasses,
      convergedBeforeMaxPassesRate: point.closedLoopConvergedBeforeMaxPassesRate,
    })),
    closedLoopRunSummary: {
      runCount: runs.length,
      convergedRunCount,
      nonConvergedRunCount: runs.length - convergedRunCount,
      convergedRunRate: runs.length > 0 ? convergedRunCount / runs.length : 0,
      stopReasonCounts: summaryStopReasonCounts,
      nonConvergedRunIndexes,
    },
    closedLoopRunConvergence: runConvergence,
  };
}

function roundSeriesValue(value: number) {
  return Number(value.toFixed(0));
}

function simulatePath(
  data: SeedData,
  assumptions: MarketAssumptions,
  stressors: Stressor[],
  responses: ResponseOption[],
  options?: SimulationExecutionOptions,
) {
  const simulationMode = options?.strategyMode ?? 'planner_enhanced';
  const ages = calculateCurrentAges(data);
  const basePlan = buildPlan(data, assumptions, options?.annualSpendTarget);
  const stressedPlan = applyStressors(basePlan, stressors, options?.stressorKnobs);
  const effectivePlan = applyResponses(stressedPlan, responses, options?.stressorKnobs);
  const strategyBehavior = getStrategyBehavior(simulationMode, effectivePlan);
  const runCount = Math.max(1, assumptions.simulationRuns);
  const simulationSeed = assumptions.simulationSeed ?? 20260416;
  const assumptionsVersion = assumptions.assumptionsVersion ?? 'v1';
  const planningHorizonYears =
    effectivePlan.planningEndYear - effectivePlan.startYear + 1;
  const yearlyBuckets = new Map<number, RunTrace[]>();
  const monteCarlo = executeDeterministicMonteCarlo<SimulationRunResult>({
    seed: simulationSeed,
    trialCount: runCount,
    assumptionsVersion,
    onProgress: options?.onProgress,
    isCancelled: options?.isCancelled,
    summarizeTrial: (result) => ({
      success: result.success,
      endingWealth: result.endingWealth,
      failureYear: result.failureYear,
    }),
    runTrial: ({ random }) => {
      let hsaBalance = data.accounts.hsa?.balance ?? 0;
      const balances = {
        pretax: effectivePlan.accounts.pretax.balance,
        roth: effectivePlan.accounts.roth.balance,
        taxable: effectivePlan.accounts.taxable.balance,
        cash: effectivePlan.accounts.cash.balance,
      };

      let optionalCutActive = false;
      let spendingCutsTriggered = 0;
      let failureYear: number | null = null;
      let failureReason = 'assets run short before the end of the planning horizon';
      let failureShortfallAmount = 0;
      let downsideSpendingCutRequired = 0;
      let inflationIndex = 1;
      let medicalInflationIndex = 1;
      let homeSaleDependent = false;
      let inheritanceDependent = false;
      let irmaaTriggered = false;
      let rothDepletedEarly = false;
      let forcedEquitySalesInAdverseEarlyYears = false;
      let closedLoopYearsConverged = 0;
      let closedLoopYearsEvaluated = 0;
      let closedLoopPassesUsedMax = 0;
      const closedLoopStopReasonCounts = {
        converged_thresholds_met: 0,
        max_pass_limit_reached: 0,
        no_change: 0,
        oscillation_detected: 0,
      };
      let closedLoopFinalMagiDeltaMax = 0;
      let closedLoopFinalFederalTaxDeltaMax = 0;
      let closedLoopFinalHealthcarePremiumDeltaMax = 0;
      let rothWasPositive = balances.roth > 0;
      const yearly: RunTrace[] = [];
      const magiHistory = new Map<number, number>();
      const marketPath = buildYearlyMarketPath(
        effectivePlan,
        assumptions,
        planningHorizonYears,
        random,
      );
      const ltcEventOccurs =
        effectivePlan.ltcAssumptions.enabled &&
        random() < effectivePlan.ltcAssumptions.eventProbability;

      for (let year = effectivePlan.startYear; year <= effectivePlan.planningEndYear; year += 1) {
        throwIfSimulationCancelled(options?.isCancelled);

        const yearOffset = year - effectivePlan.startYear;
        const robAge = ages.rob + yearOffset;
        const debbieAge = ages.debbie + yearOffset;
        const robRmdStartAge =
          data.rules.rmdPolicy?.startAgeOverride ??
          getRmdStartAgeForBirthYear(new Date(data.household.robBirthDate).getFullYear());
        const debbieRmdStartAge =
          data.rules.rmdPolicy?.startAgeOverride ??
          getRmdStartAgeForBirthYear(new Date(data.household.debbieBirthDate).getFullYear());
        const yearsUntilRmdStart = Math.max(
          0,
          Math.min(robRmdStartAge - robAge, debbieRmdStartAge - debbieAge),
        );
        const isRetired = year >= effectivePlan.retirementYear;
        const marketPoint =
          marketPath[yearOffset] ??
          getStressAdjustedReturns(effectivePlan, assumptions, yearOffset, random);
        const { inflation, assetReturns, marketState } = marketPoint;
        const pretaxBalanceForRmd = balances.pretax;

        const totalAssetsAtStart = sumBalances(balances);
        const rothBalanceStartForYear = balances.roth;
        const yearsIntoRetirement = year - effectivePlan.retirementYear;
        const inTravelPhase =
          isRetired &&
          yearsIntoRetirement >= 0 &&
          yearsIntoRetirement < effectivePlan.travelPhaseYears;
        const fixedSpendAnnual =
          effectivePlan.essentialAnnual + effectivePlan.taxesInsuranceAnnual;
        const baselineDiscretionaryAnnual =
          effectivePlan.optionalAnnual + (inTravelPhase ? effectivePlan.travelAnnual : 0);
        const scheduledAnnualSpend = getScheduledAnnualSpendForYear(
          options?.annualSpendScheduleByYear,
          year,
        );
        const targetAnnualSpend =
          scheduledAnnualSpend ?? fixedSpendAnnual + baselineDiscretionaryAnnual;
        const discretionaryTargetAnnual = Math.max(0, targetAnnualSpend - fixedSpendAnnual);
        const discretionaryScale =
          baselineDiscretionaryAnnual > 0
            ? discretionaryTargetAnnual / baselineDiscretionaryAnnual
            : 0;
        const optionalAnnualForYear = effectivePlan.optionalAnnual * discretionaryScale;
        const travelAnnualForYear = inTravelPhase
          ? effectivePlan.travelAnnual * discretionaryScale
          : 0;
        const baseSpending =
          fixedSpendAnnual + optionalAnnualForYear + travelAnnualForYear;

        const fundedYears = totalAssetsAtStart / Math.max(baseSpending, 1);
        if (
          strategyBehavior.guardrailsEnabled &&
          !optionalCutActive &&
          fundedYears < effectivePlan.guardrails.floorYears
        ) {
          optionalCutActive = true;
          spendingCutsTriggered += 1;
        } else if (
          strategyBehavior.guardrailsEnabled &&
          optionalCutActive &&
          fundedYears > effectivePlan.guardrails.ceilingYears
        ) {
          optionalCutActive = false;
        }

        const cutMultiplier = optionalCutActive ? 1 - effectivePlan.guardrails.cutPercent : 1;
        const optionalSpend = optionalAnnualForYear * cutMultiplier;
        const travelSpend = travelAnnualForYear * cutMultiplier;
        const spendingBeforeHealthcare =
          (effectivePlan.essentialAnnual + optionalSpend + effectivePlan.taxesInsuranceAnnual + travelSpend) *
          inflationIndex;

        const salary = getSalaryForYear(effectivePlan, year);
        const contributionResult = calculatePreRetirementContributions({
          age: robAge,
          salaryAnnual: effectivePlan.salaryAnnual,
          salaryThisYear: salary,
          retirementDate: effectivePlan.salaryEndDate,
          projectionYear: year,
          filingStatus: data.household.filingStatus,
          settings: data.income.preRetirementContributions,
          accountBalances: {
            pretax: balances.pretax,
            roth: balances.roth,
            hsa: hsaBalance,
          },
        });
        balances.pretax = contributionResult.updatedAccountBalances.pretax;
        balances.roth = contributionResult.updatedAccountBalances.roth ?? balances.roth;
        hsaBalance = contributionResult.updatedAccountBalances.hsa ?? hsaBalance;
        const rothContributionFlowForYear = balances.roth - rothBalanceStartForYear;
        const adjustedWages = contributionResult.adjustedWages;
        const socialSecurityIncome = getSocialSecurityIncome(
          effectivePlan,
          year,
          { rob: robAge, debbie: debbieAge },
          inflationIndex,
        );
        const rmdResult = calculateRequiredMinimumDistribution({
          pretaxBalance: pretaxBalanceForRmd,
          members: [
            {
              birthDate: data.household.robBirthDate,
              age: robAge,
              accountShare: 0.5,
              startAgeOverride: data.rules.rmdPolicy?.startAgeOverride,
            },
            {
              birthDate: data.household.debbieBirthDate,
              age: debbieAge,
              accountShare: 0.5,
              startAgeOverride: data.rules.rmdPolicy?.startAgeOverride,
            },
          ],
        });

        const windfallRealizations = effectivePlan.windfalls
          .map((item) => ({
            item,
            realized: buildWindfallRealizationForYear(item, year, data.household.filingStatus),
          }))
          .filter(
            ({ realized }) =>
              realized.cashInflow > 0 || realized.ordinaryIncome > 0 || realized.ltcgIncome > 0,
          );
        let windfallCashInflow = 0;
        let windfallOrdinaryIncome = 0;
        let windfallLtcgIncome = 0;
        for (const entry of windfallRealizations) {
          windfallCashInflow += entry.realized.cashInflow;
          windfallOrdinaryIncome += entry.realized.ordinaryIncome;
          windfallLtcgIncome += entry.realized.ltcgIncome;
        }

        windfallRealizations.forEach(({ item, realized }) => {
          if (realized.cashInflow <= 0) {
            return;
          }
          const yearsFundedBeforeEvent = totalAssetsAtStart / Math.max(spendingBeforeHealthcare, 1);
          if (item.name === 'home_sale' && yearsFundedBeforeEvent < 5) {
            homeSaleDependent = true;
          }
          if (item.name === 'inheritance' && yearsFundedBeforeEvent < 5) {
            inheritanceDependent = true;
          }
        });

        const rothBalanceBeforeReturnsForYear = balances.roth;
        SIM_BUCKETS.forEach((bucket) => {
          balances[bucket] *=
            1 +
            getBucketReturn(
              effectivePlan.accounts[bucket].targetAllocation,
              assetReturns,
              effectivePlan.assetClassMappingAssumptions,
            );
        });
        const rothMarketGainLossForYear = balances.roth - rothBalanceBeforeReturnsForYear;

        balances.cash += windfallCashInflow;
        const baseIncome = adjustedWages + socialSecurityIncome + windfallCashInflow;
        const shortfallBeforeHealthcare = Math.max(spendingBeforeHealthcare - baseIncome, 0);
        const baseTaxInputs = createBaseYearTaxInputs(
          data.household.filingStatus,
          adjustedWages,
          socialSecurityIncome,
          robAge,
          debbieAge,
        );
        baseTaxInputs.otherOrdinaryIncome += windfallOrdinaryIncome;
        baseTaxInputs.realizedLTCG += windfallLtcgIncome;
        const balancesBeforeWithdrawal = { ...balances };
        const medicareEligibilityByPerson = [robAge >= 65, debbieAge >= 65];
        const medicareEligibleCount = medicareEligibilityByPerson.filter(Boolean).length;
        const isLowEarnedIncome = salary <= effectivePlan.salaryAnnual * 0.35;
        const hasNonMedicareMembers =
          medicareEligibilityByPerson.filter((isEligible) => !isEligible).length > 0;
        const acaFriendlyMagiCeilingForYear =
          strategyBehavior.acaAwareWithdrawalOptimization &&
          hasNonMedicareMembers &&
          (isRetired || isLowEarnedIncome)
            ? resolveAcaFriendlyMagiCeiling(data.household.filingStatus, inflationIndex)
            : null;

        const runWithdrawalAttempt = (needed: number) => {
          const attemptBalances = { ...balancesBeforeWithdrawal };
          const attemptResult = withdrawForNeed(
            effectivePlan,
            attemptBalances,
            needed,
            marketState,
            rmdResult.amount,
            baseTaxInputs,
            assumptions,
            strategyBehavior,
            acaFriendlyMagiCeilingForYear,
          );
          return {
            endingBalances: attemptBalances,
            result: attemptResult,
            acaFriendlyMagiCeiling: acaFriendlyMagiCeilingForYear,
          };
        };

        const baseHealthcareInputs = {
          agesByYear: [robAge, debbieAge],
          filingStatus: data.household.filingStatus,
          retirementStatus: isRetired,
          medicareEligibilityByPerson,
          baselineAcaPremiumAnnual:
            effectivePlan.healthcarePremiums.baselineAcaPremiumAnnual * medicalInflationIndex,
          baselineMedicarePremiumAnnual:
            effectivePlan.healthcarePremiums.baselineMedicarePremiumAnnual * medicalInflationIndex,
        };
        const ltcCostForYear = calculateLtcCostForYear(
          effectivePlan,
          {
            rob: robAge,
            debbie: debbieAge,
          },
          ltcEventOccurs,
        );

        const lookbackMagi =
          magiHistory.get(year - DEFAULT_IRMAA_CONFIG.lookbackYears) ?? null;
        // Hoist IRMAA tier when lookback MAGI is available — it's constant across
        // closed-loop passes since the input (lookbackMagi + filingStatus) doesn't change.
        const hoistedIrmaaTier =
          lookbackMagi !== null
            ? calculateIrmaaTier(lookbackMagi, data.household.filingStatus)
            : null;
        const convergenceThresholds = DEFAULT_CLOSED_LOOP_CONVERGENCE_THRESHOLDS;
        let closedLoopPreviousState: ClosedLoopIterationState | null = null;
        let closedLoopFinalState: ClosedLoopIterationState | null = null;
        let closedLoopPassesUsed = 0;
        let closedLoopConverged = false;
        let closedLoopStopReason: ClosedLoopStopReason = 'max_pass_limit_reached';
        let closedLoopLastDeltas = {
          magi: 0,
          federalTax: 0,
          healthcarePremium: 0,
        };
        let closedLoopNeeded = shortfallBeforeHealthcare;
        // Track oscillation: sign of (nextNeeded - closedLoopNeeded). When the sign
        // flips, we're bouncing around a cliff (ACA 400% FPL or IRMAA tier boundary)
        // and uniform 0.5 damping can't resolve the discontinuity. Count flips and
        // dampen progressively harder; after 2 flips, take the midpoint and stop.
        let lastNeededSign = 0;
        let oscillationFlips = 0;

        for (let pass = 1; pass <= DEFAULT_MAX_CLOSED_LOOP_PASSES; pass += 1) {
          const attempt = runWithdrawalAttempt(closedLoopNeeded);
          const magi = attempt.result.taxResult.MAGI;
          const irmaaTierForPass =
            hoistedIrmaaTier ??
            calculateIrmaaTier(magi, data.household.filingStatus);
          const healthcareForPass = calculateHealthcarePremiums({
            ...baseHealthcareInputs,
            MAGI: magi,
            irmaaSurchargeAnnualPerEligible: irmaaTierForPass.surchargeAnnual,
          });
          const hsaOffsetForPass = calculateHsaOffsetForYear({
            plan: effectivePlan,
            hsaBalance,
            magi,
            healthcareAndLtcCost:
              healthcareForPass.totalHealthcarePremiumCost + ltcCostForYear,
          });
          const nextNeeded = Math.max(
            0,
            shortfallBeforeHealthcare +
              healthcareForPass.totalHealthcarePremiumCost +
              ltcCostForYear -
              hsaOffsetForPass,
          );

          const currentState: ClosedLoopIterationState = {
            attempt: attempt.result,
            endingBalances: attempt.endingBalances,
            magi,
            federalTax: attempt.result.taxResult.federalTax,
            healthcarePremiumCost: healthcareForPass.totalHealthcarePremiumCost,
            hsaOffset: hsaOffsetForPass,
            irmaaTier: irmaaTierForPass,
            nextNeeded,
          };

          closedLoopPassesUsed = pass;
          closedLoopFinalState = currentState;
          if (closedLoopPreviousState) {
            closedLoopLastDeltas = {
              magi: Math.abs(currentState.magi - closedLoopPreviousState.magi),
              federalTax: Math.abs(
                currentState.federalTax - closedLoopPreviousState.federalTax,
              ),
              healthcarePremium: Math.abs(
                currentState.healthcarePremiumCost -
                  closedLoopPreviousState.healthcarePremiumCost,
              ),
            };
            const converged =
              closedLoopLastDeltas.magi <= convergenceThresholds.magiDeltaDollars &&
              closedLoopLastDeltas.federalTax <=
                convergenceThresholds.federalTaxDeltaDollars &&
              closedLoopLastDeltas.healthcarePremium <=
                convergenceThresholds.healthcarePremiumDeltaDollars;
            if (converged) {
              closedLoopConverged = true;
              closedLoopStopReason = 'converged_thresholds_met';
              break;
            }
            const neededDelta = Math.abs(currentState.nextNeeded - closedLoopNeeded);
            if (neededDelta <= 1) {
              // Stationary/no-change is diagnostic information only. It does not
              // imply threshold convergence unless explicit deltas also satisfy
              // MAGI/tax/healthcare convergence tolerances.
              closedLoopConverged = converged;
              closedLoopStopReason = 'no_change';
              break;
            }
          }

          if (pass === DEFAULT_MAX_CLOSED_LOOP_PASSES) {
            closedLoopStopReason = 'max_pass_limit_reached';
            break;
          }
          closedLoopPreviousState = currentState;
          // Detect oscillation across a discontinuity (ACA 400% FPL cliff, IRMAA
          // tier edge). Each flip of sign(nextNeeded - closedLoopNeeded) means we
          // straddled the cliff; dampen harder. After two flips, take the midpoint
          // and stop — further passes won't help.
          const neededDiff = nextNeeded - closedLoopNeeded;
          const currentSign = neededDiff > 0 ? 1 : neededDiff < 0 ? -1 : 0;
          if (lastNeededSign !== 0 && currentSign !== 0 && currentSign !== lastNeededSign) {
            oscillationFlips += 1;
          }
          lastNeededSign = currentSign !== 0 ? currentSign : lastNeededSign;
          if (oscillationFlips >= 2) {
            closedLoopNeeded = (closedLoopNeeded + nextNeeded) / 2;
            closedLoopStopReason = 'oscillation_detected';
            break;
          }
          const dampingFactor = oscillationFlips >= 1 ? 0.3 : 0.5;
          closedLoopNeeded =
            closedLoopNeeded + dampingFactor * (nextNeeded - closedLoopNeeded);
        }

        const resolvedClosedLoopState = closedLoopFinalState ?? (() => {
          const fallback = runWithdrawalAttempt(shortfallBeforeHealthcare);
          const fallbackMagi = fallback.result.taxResult.MAGI;
          const fallbackIrmaaTier =
            hoistedIrmaaTier ??
            calculateIrmaaTier(fallbackMagi, data.household.filingStatus);
          const fallbackHealthcare = calculateHealthcarePremiums({
            ...baseHealthcareInputs,
            MAGI: fallbackMagi,
            irmaaSurchargeAnnualPerEligible: fallbackIrmaaTier.surchargeAnnual,
          });
          const fallbackHsaOffset = calculateHsaOffsetForYear({
            plan: effectivePlan,
            hsaBalance,
            magi: fallbackMagi,
            healthcareAndLtcCost:
              fallbackHealthcare.totalHealthcarePremiumCost + ltcCostForYear,
          });
          return {
            attempt: fallback.result,
            endingBalances: fallback.endingBalances,
            magi: fallbackMagi,
            federalTax: fallback.result.taxResult.federalTax,
            healthcarePremiumCost: fallbackHealthcare.totalHealthcarePremiumCost,
            hsaOffset: fallbackHsaOffset,
            irmaaTier: fallbackIrmaaTier,
            nextNeeded: Math.max(
              0,
              shortfallBeforeHealthcare +
                fallbackHealthcare.totalHealthcarePremiumCost +
                ltcCostForYear -
                fallbackHsaOffset,
            ),
          } satisfies ClosedLoopIterationState;
        })();

        const withdrawalResult = resolvedClosedLoopState.attempt;
        const rothConversionTrace = strategyBehavior.plannerLogicActive
          ? applyProactiveRothConversion({
              balances: resolvedClosedLoopState.endingBalances,
              withdrawalResult,
              strategy: strategyBehavior,
              plan: effectivePlan,
              assumptions,
              requiredRmdAmount: rmdResult.amount,
              yearsUntilRmdStart,
              isRetired,
              acaFriendlyMagiCeiling: acaFriendlyMagiCeilingForYear,
              medicareEligibleCount,
            })
          : buildInactiveRothConversionTrace({
              balances: resolvedClosedLoopState.endingBalances,
              withdrawalResult,
              strategy: strategyBehavior,
            });
        let magiForYear = withdrawalResult.taxResult.MAGI;
        let irmaaReferenceMagi =
          magiHistory.get(year - DEFAULT_IRMAA_CONFIG.lookbackYears) ?? magiForYear;
        let irmaaTier = calculateIrmaaTier(irmaaReferenceMagi, data.household.filingStatus);
        let healthcarePremiums = calculateHealthcarePremiums({
          ...baseHealthcareInputs,
          MAGI: magiForYear,
          irmaaSurchargeAnnualPerEligible: irmaaTier.surchargeAnnual,
        });
        let hsaOffsetUsed = calculateHsaOffsetForYear({
          plan: effectivePlan,
          hsaBalance,
          magi: magiForYear,
          healthcareAndLtcCost: healthcarePremiums.totalHealthcarePremiumCost + ltcCostForYear,
        });
        const closedLoopConvergedBeforeMaxPasses =
          closedLoopConverged && closedLoopPassesUsed < DEFAULT_MAX_CLOSED_LOOP_PASSES;
        closedLoopYearsEvaluated += 1;
        if (closedLoopConverged) {
          closedLoopYearsConverged += 1;
        }
        closedLoopPassesUsedMax = Math.max(closedLoopPassesUsedMax, closedLoopPassesUsed);
        closedLoopStopReasonCounts[closedLoopStopReason] += 1;
        closedLoopFinalMagiDeltaMax = Math.max(
          closedLoopFinalMagiDeltaMax,
          closedLoopLastDeltas.magi,
        );
        closedLoopFinalFederalTaxDeltaMax = Math.max(
          closedLoopFinalFederalTaxDeltaMax,
          closedLoopLastDeltas.federalTax,
        );
        closedLoopFinalHealthcarePremiumDeltaMax = Math.max(
          closedLoopFinalHealthcarePremiumDeltaMax,
          closedLoopLastDeltas.healthcarePremium,
        );

        balances.pretax = resolvedClosedLoopState.endingBalances.pretax;
        balances.roth = resolvedClosedLoopState.endingBalances.roth;
        balances.taxable = resolvedClosedLoopState.endingBalances.taxable;
        balances.cash = resolvedClosedLoopState.endingBalances.cash;
        if (hsaOffsetUsed > 0) {
          const appliedOffset = Math.min(hsaOffsetUsed, hsaBalance, balances.pretax);
          hsaBalance = Math.max(0, hsaBalance - appliedOffset);
          balances.pretax = Math.max(0, balances.pretax - appliedOffset);
        }

        const federalTaxForYear = withdrawalResult.taxResult.federalTax;
        magiHistory.set(year, magiForYear);
        const spending =
          spendingBeforeHealthcare +
          healthcarePremiums.totalHealthcarePremiumCost +
          ltcCostForYear -
          hsaOffsetUsed;
        const annualMedicareSurcharge = healthcarePremiums.irmaaSurcharge;
        const medicarePremiumEstimate = healthcarePremiums.medicarePremiumEstimate;
        const income = baseIncome + withdrawalResult.rmdWithdrawn;
        const nonCashWithdrawalForYear =
          withdrawalResult.withdrawals.taxable +
          withdrawalResult.withdrawals.pretax +
          withdrawalResult.withdrawals.roth;
        if (marketState === 'down' && yearOffset <= 9 && nonCashWithdrawalForYear > 0) {
          forcedEquitySalesInAdverseEarlyYears = true;
        }

        if (irmaaTier.tier > 1 && medicareEligibleCount > 0) {
          irmaaTriggered = true;
        }

        if (rothWasPositive && balances.roth <= 1 && robAge < 75) {
          rothDepletedEarly = true;
        }
        rothWasPositive = balances.roth > 1;
        const rothBalanceEndForYear = balances.roth;
        const rothNetChangeForYear = rothBalanceEndForYear - rothBalanceStartForYear;
        const rothBalanceReconciliationDeltaForYear =
          rothBalanceEndForYear -
          (rothBalanceStartForYear +
            rothContributionFlowForYear +
            rothMarketGainLossForYear -
            withdrawalResult.withdrawals.roth +
            rothConversionTrace.amount);

        const endingAssets = sumBalances(balances);
        yearly.push({
          year,
          totalAssets: roundSeriesValue(endingAssets),
          income: roundSeriesValue(income),
          spending: roundSeriesValue(spending),
          federalTax: roundSeriesValue(federalTaxForYear),
          rmdAmount: roundSeriesValue(withdrawalResult.rmdWithdrawn),
          withdrawalCash: roundSeriesValue(withdrawalResult.withdrawals.cash),
          withdrawalTaxable: roundSeriesValue(withdrawalResult.withdrawals.taxable),
          withdrawalIra401k: roundSeriesValue(withdrawalResult.withdrawals.pretax),
          withdrawalRoth: roundSeriesValue(withdrawalResult.withdrawals.roth),
          rothConversion: roundSeriesValue(rothConversionTrace.amount),
          rothConversionReason: rothConversionTrace.reason,
          rothConversionSimulationModeUsed:
            rothConversionTrace.simulationModeUsedForConversion,
          rothConversionPlannerLogicActiveAtConversion:
            rothConversionTrace.plannerLogicActiveAtConversion,
          rothConversionEngineInvoked: rothConversionTrace.conversionEngineInvoked,
          rothConversionCandidateAmounts: rothConversionTrace.evaluatedCandidateAmounts.map(
            (amount) => roundSeriesValue(amount),
          ),
          rothConversionBestCandidateAmount: roundSeriesValue(
            rothConversionTrace.bestCandidateAmount,
          ),
          rothConversionBestScore: roundSeriesValue(rothConversionTrace.bestScore),
          rothConversionRawMAGI: roundSeriesValue(rothConversionTrace.rawMAGI),
          rothConversionIrmaaThreshold: rothConversionTrace.irmaaThreshold === null
            ? null
            : roundSeriesValue(rothConversionTrace.irmaaThreshold),
          rothConversionComputedHeadroom: roundSeriesValue(rothConversionTrace.computedHeadroom),
          rothConversionMagiBuffer: roundSeriesValue(rothConversionTrace.magiBuffer),
          rothConversionHeadroomComputed: rothConversionTrace.headroomComputed,
          rothConversionCandidateAmountsGenerated:
            rothConversionTrace.candidateAmountsGenerated,
          rothConversionEligibilityBlockedReason:
            rothConversionTrace.eligibilityBlockedReason,
          rothConversionMagiEffect: roundSeriesValue(rothConversionTrace.magiEffect),
          rothConversionTaxEffect: roundSeriesValue(rothConversionTrace.taxEffect),
          rothConversionAcaEffect: roundSeriesValue(rothConversionTrace.acaEffect),
          rothConversionIrmaaEffect: roundSeriesValue(rothConversionTrace.irmaaEffect),
          rothConversionPretaxBalanceEffect: roundSeriesValue(
            rothConversionTrace.pretaxBalanceEffect,
          ),
          rothConversionEligible: rothConversionTrace.eligible,
          rothConversionTargetMagiCeiling: rothConversionTrace.targetMagiCeiling === null
            ? null
            : roundSeriesValue(rothConversionTrace.targetMagiCeiling),
          rothConversionMagiHeadroom: roundSeriesValue(rothConversionTrace.magiHeadroom),
          rothConversionMagiBefore: roundSeriesValue(rothConversionTrace.magiBefore),
          rothConversionMagiAfter: roundSeriesValue(rothConversionTrace.magiAfter),
          rothConversionPretaxBalanceBefore: roundSeriesValue(
            rothConversionTrace.pretaxBalanceBefore,
          ),
          rothConversionBalanceCap: roundSeriesValue(rothConversionTrace.balanceCap),
          rothConversionScore: roundSeriesValue(rothConversionTrace.conversionScore),
          rothConversionOpportunityScore: rothConversionTrace.conversionOpportunityScore,
          rothConversionFutureTaxReduction: roundSeriesValue(
            rothConversionTrace.futureTaxReduction,
          ),
          rothConversionFutureTaxBurdenReduction: roundSeriesValue(
            rothConversionTrace.futureTaxBurdenReduction,
          ),
          rothConversionIrmaaAvoidanceValue: roundSeriesValue(
            rothConversionTrace.irmaaAvoidanceValue,
          ),
          rothConversionRmdReductionValue: roundSeriesValue(
            rothConversionTrace.rmdReductionValue,
          ),
          rothConversionRothOptionalityValue: roundSeriesValue(
            rothConversionTrace.rothOptionalityValue,
          ),
          rothConversionFutureTaxReductionValue: roundSeriesValue(
            rothConversionTrace.futureTaxReductionValue,
          ),
          rothConversionCurrentTaxCost: roundSeriesValue(rothConversionTrace.currentTaxCost),
          rothConversionSuppressedReason: rothConversionTrace.conversionSuppressedReason,
          rothConversionProjectedFutureMagiPeak: roundSeriesValue(
            rothConversionTrace.projectedFutureMagiPeak,
          ),
          rothConversionProjectedRmdPressure: roundSeriesValue(
            rothConversionTrace.projectedRmdPressure,
          ),
          rothConversionProjectedIrmaaExposure: roundSeriesValue(
            rothConversionTrace.projectedIrmaaExposure,
          ),
          rothConversionProjectedRothShareAfter: rothConversionTrace.projectedRothShareAfter,
          rothBalanceStart: roundSeriesValue(rothBalanceStartForYear),
          rothBalanceEnd: roundSeriesValue(rothBalanceEndForYear),
          rothContributionFlow: roundSeriesValue(rothContributionFlowForYear),
          rothMarketGainLoss: roundSeriesValue(rothMarketGainLossForYear),
          rothNetChange: roundSeriesValue(rothNetChangeForYear),
          rothBalanceReconciliationDelta: roundSeriesValue(
            rothBalanceReconciliationDeltaForYear,
          ),
          taxableIncome: roundSeriesValue(withdrawalResult.taxResult.totalTaxableIncome),
          magi: roundSeriesValue(magiForYear),
          irmaaTier: irmaaTier.tierLabel,
          medicareSurcharge: roundSeriesValue(annualMedicareSurcharge),
          acaPremiumEstimate: roundSeriesValue(healthcarePremiums.acaPremiumEstimate),
          acaSubsidyEstimate: roundSeriesValue(healthcarePremiums.acaSubsidyEstimate),
          netAcaCost: roundSeriesValue(healthcarePremiums.netAcaCost),
          medicarePremiumEstimate: roundSeriesValue(medicarePremiumEstimate),
          irmaaSurcharge: roundSeriesValue(healthcarePremiums.irmaaSurcharge),
          totalHealthcarePremiumCost: roundSeriesValue(
            healthcarePremiums.totalHealthcarePremiumCost,
          ),
          windfallCashInflow: roundSeriesValue(windfallCashInflow),
          windfallOrdinaryIncome: roundSeriesValue(windfallOrdinaryIncome),
          windfallLtcgIncome: roundSeriesValue(windfallLtcgIncome),
          hsaOffsetUsed: roundSeriesValue(hsaOffsetUsed),
          ltcCost: roundSeriesValue(ltcCostForYear),
          withdrawalRationale: withdrawalResult.decisionTrace.rationale,
          withdrawalScoreSpendingNeed:
            withdrawalResult.decisionTrace.objectiveScores.spendingNeed,
          withdrawalScoreMarginalTaxCost:
            withdrawalResult.decisionTrace.objectiveScores.marginalTaxCost,
          withdrawalScoreMagiTarget:
            withdrawalResult.decisionTrace.objectiveScores.magiTarget,
          withdrawalScoreAcaCliffAvoidance:
            withdrawalResult.decisionTrace.objectiveScores.acaCliffAvoidance,
          withdrawalScoreIrmaaCliffAvoidance:
            withdrawalResult.decisionTrace.objectiveScores.irmaaCliffAvoidance,
          withdrawalScoreRothOptionality:
            withdrawalResult.decisionTrace.objectiveScores.rothOptionality,
          withdrawalScoreSequenceDefense:
            withdrawalResult.decisionTrace.objectiveScores.sequenceDefense,
          employee401kContribution: roundSeriesValue(contributionResult.employee401kContribution),
          employerMatchContribution: roundSeriesValue(
            contributionResult.employerMatchContribution,
          ),
          total401kContribution: roundSeriesValue(contributionResult.total401kContribution),
          hsaContribution: roundSeriesValue(contributionResult.hsaContribution),
          adjustedWages: roundSeriesValue(adjustedWages),
          taxableWageReduction: roundSeriesValue(contributionResult.taxableWageReduction),
          pretaxBalanceAfterContributions: roundSeriesValue(
            contributionResult.updatedPretaxBalance,
          ),
          closedLoopConverged: closedLoopConverged,
          closedLoopConvergedBeforeMaxPasses,
          closedLoopPassesUsed: closedLoopPassesUsed,
          closedLoopStopReason: closedLoopStopReason,
          closedLoopLastMagiDelta: roundSeriesValue(closedLoopLastDeltas.magi),
          closedLoopLastFederalTaxDelta: roundSeriesValue(closedLoopLastDeltas.federalTax),
          closedLoopLastHealthcarePremiumDelta: roundSeriesValue(
            closedLoopLastDeltas.healthcarePremium,
          ),
        });

        if (!yearlyBuckets.has(year)) {
          yearlyBuckets.set(year, []);
        }
        yearlyBuckets.get(year)?.push(yearly[yearly.length - 1]);

        if (withdrawalResult.remaining > 0 || endingAssets <= 0) {
          failureYear = year;
          failureShortfallAmount = Math.max(0, withdrawalResult.remaining);
          downsideSpendingCutRequired =
            spending > 0 ? Math.max(0, Math.min(1, failureShortfallAmount / spending)) : 0;
          failureReason =
            spending <=
            effectivePlan.essentialAnnual * inflationIndex +
              effectivePlan.taxesInsuranceAnnual * inflationIndex +
              healthcarePremiums.totalHealthcarePremiumCost +
              ltcCostForYear -
              hsaOffsetUsed
              ? 'essential spending can no longer be covered from the remaining assets'
              : marketState === 'down'
                ? 'sequence risk forces withdrawals after a weak early market'
                : salary <= 0 && year <= effectivePlan.retirementYear + 1
                  ? 'income ends before the portfolio is ready to fully carry spending'
                  : 'assets run short before the end of the planning horizon';
          break;
        }

        inflationIndex *= 1 + inflation;
        medicalInflationIndex *= 1 + effectivePlan.healthcarePremiums.medicalInflationAnnual;
      }

      return {
        success: failureYear === null,
        failureYear,
        endingWealth: sumBalances(balances),
        spendingCutsTriggered,
        irmaaTriggered,
        homeSaleDependent,
        inheritanceDependent,
        rothDepletedEarly,
        forcedEquitySalesInAdverseEarlyYears,
        failureShortfallAmount,
        downsideSpendingCutRequired,
        failureReason,
        closedLoopYearsConverged,
        closedLoopYearsEvaluated,
        closedLoopPassesUsedMax,
        closedLoopStopReasonCounts,
        closedLoopFinalMagiDeltaMax,
        closedLoopFinalFederalTaxDeltaMax,
        closedLoopFinalHealthcarePremiumDeltaMax,
        yearly,
      };
    },
  });

  const runs = monteCarlo.runs;
  const failedRuns = runs.filter((result) => !result.success);
  const failureYears = failedRuns
    .map((result) => result.failureYear)
    .filter((year): year is number => year !== null);

  const yearlySeries = [...yearlyBuckets.entries()].map(([year, traces]) => ({
    year,
    medianAssets: median(traces.map((trace) => trace.totalAssets)),
    tenthPercentileAssets: percentile(
      traces.map((trace) => trace.totalAssets),
      0.1,
    ),
    medianIncome: median(traces.map((trace) => trace.income)),
    medianSpending: median(traces.map((trace) => trace.spending)),
    medianFederalTax: median(traces.map((trace) => trace.federalTax)),
    medianRmdAmount: median(traces.map((trace) => trace.rmdAmount)),
    medianWithdrawalCash: median(traces.map((trace) => trace.withdrawalCash)),
    medianWithdrawalTaxable: median(traces.map((trace) => trace.withdrawalTaxable)),
    medianWithdrawalIra401k: median(traces.map((trace) => trace.withdrawalIra401k)),
    medianWithdrawalRoth: median(traces.map((trace) => trace.withdrawalRoth)),
    medianRothConversion: median(traces.map((trace) => trace.rothConversion)),
    dominantRothConversionReason: dominantValue(
      traces.map((trace) => trace.rothConversionReason),
    ),
    medianRothConversionMagiEffect: median(
      traces.map((trace) => trace.rothConversionMagiEffect),
    ),
    medianRothConversionTaxEffect: median(
      traces.map((trace) => trace.rothConversionTaxEffect),
    ),
    medianRothConversionAcaEffect: median(
      traces.map((trace) => trace.rothConversionAcaEffect),
    ),
    medianRothConversionIrmaaEffect: median(
      traces.map((trace) => trace.rothConversionIrmaaEffect),
    ),
    medianRothConversionPretaxBalanceEffect: median(
      traces.map((trace) => trace.rothConversionPretaxBalanceEffect),
    ),
    medianTaxableIncome: median(traces.map((trace) => trace.taxableIncome)),
    medianMagi: median(traces.map((trace) => trace.magi)),
    dominantIrmaaTier: dominantValue(traces.map((trace) => trace.irmaaTier)),
    medianMedicareSurcharge: median(traces.map((trace) => trace.medicareSurcharge)),
    medianEmployee401kContribution: median(
      traces.map((trace) => trace.employee401kContribution),
    ),
    medianEmployerMatchContribution: median(
      traces.map((trace) => trace.employerMatchContribution),
    ),
    medianTotal401kContribution: median(traces.map((trace) => trace.total401kContribution)),
    medianHsaContribution: median(traces.map((trace) => trace.hsaContribution)),
    medianAdjustedWages: median(traces.map((trace) => trace.adjustedWages)),
    medianTaxableWageReduction: median(traces.map((trace) => trace.taxableWageReduction)),
    medianPretaxBalanceAfterContributions: median(
      traces.map((trace) => trace.pretaxBalanceAfterContributions),
    ),
    medianAcaPremiumEstimate: median(traces.map((trace) => trace.acaPremiumEstimate)),
    medianAcaSubsidyEstimate: median(traces.map((trace) => trace.acaSubsidyEstimate)),
    medianNetAcaCost: median(traces.map((trace) => trace.netAcaCost)),
    medianMedicarePremiumEstimate: median(
      traces.map((trace) => trace.medicarePremiumEstimate),
    ),
    medianIrmaaSurcharge: median(traces.map((trace) => trace.irmaaSurcharge)),
    medianTotalHealthcarePremiumCost: median(
      traces.map((trace) => trace.totalHealthcarePremiumCost),
    ),
    medianWindfallCashInflow: median(traces.map((trace) => trace.windfallCashInflow)),
    medianWindfallOrdinaryIncome: median(
      traces.map((trace) => trace.windfallOrdinaryIncome),
    ),
    medianWindfallLtcgIncome: median(traces.map((trace) => trace.windfallLtcgIncome)),
    medianHsaOffsetUsed: median(traces.map((trace) => trace.hsaOffsetUsed)),
    medianLtcCost: median(traces.map((trace) => trace.ltcCost)),
    dominantWithdrawalRationale: dominantValue(
      traces.map((trace) => trace.withdrawalRationale),
    ),
    medianWithdrawalScoreSpendingNeed: median(
      traces.map((trace) => trace.withdrawalScoreSpendingNeed),
    ),
    medianWithdrawalScoreMarginalTaxCost: median(
      traces.map((trace) => trace.withdrawalScoreMarginalTaxCost),
    ),
    medianWithdrawalScoreMagiTarget: median(
      traces.map((trace) => trace.withdrawalScoreMagiTarget),
    ),
    medianWithdrawalScoreAcaCliffAvoidance: median(
      traces.map((trace) => trace.withdrawalScoreAcaCliffAvoidance),
    ),
    medianWithdrawalScoreIrmaaCliffAvoidance: median(
      traces.map((trace) => trace.withdrawalScoreIrmaaCliffAvoidance),
    ),
    medianWithdrawalScoreRothOptionality: median(
      traces.map((trace) => trace.withdrawalScoreRothOptionality),
    ),
    medianWithdrawalScoreSequenceDefense: median(
      traces.map((trace) => trace.withdrawalScoreSequenceDefense),
    ),
    closedLoopConverged:
      traces.filter((trace) => trace.closedLoopConverged).length / traces.length >= 0.5,
    closedLoopConvergedRate:
      traces.filter((trace) => trace.closedLoopConverged).length / traces.length,
    closedLoopConvergedBeforeMaxPasses:
      traces.filter((trace) => trace.closedLoopConvergedBeforeMaxPasses).length / traces.length >=
      0.5,
    closedLoopConvergedBeforeMaxPassesRate:
      traces.filter((trace) => trace.closedLoopConvergedBeforeMaxPasses).length / traces.length,
    closedLoopPassesUsed: median(traces.map((trace) => trace.closedLoopPassesUsed)),
    medianClosedLoopPassesUsed: median(
      traces.map((trace) => trace.closedLoopPassesUsed),
    ),
    closedLoopStopReason: dominantValue(
      traces.map((trace) => trace.closedLoopStopReason),
    ),
    finalMagiDelta: median(
      traces.map((trace) => trace.closedLoopLastMagiDelta),
    ),
    finalFederalTaxDelta: median(
      traces.map((trace) => trace.closedLoopLastFederalTaxDelta),
    ),
    finalHealthcarePremiumDelta: median(
      traces.map((trace) => trace.closedLoopLastHealthcarePremiumDelta),
    ),
    medianClosedLoopLastMagiDelta: median(
      traces.map((trace) => trace.closedLoopLastMagiDelta),
    ),
    medianClosedLoopLastFederalTaxDelta: median(
      traces.map((trace) => trace.closedLoopLastFederalTaxDelta),
    ),
    medianClosedLoopLastHealthcarePremiumDelta: median(
      traces.map((trace) => trace.closedLoopLastHealthcarePremiumDelta),
    ),
    dominantClosedLoopStopReason: dominantValue(
      traces.map((trace) => trace.closedLoopStopReason),
    ),
  }));

  const successRate = monteCarlo.successRate;
  const spendingCutRate =
    runs.filter((result) => result.spendingCutsTriggered > 0).length / runs.length;
  const irmaaExposureRate =
    runs.filter((result) => result.irmaaTriggered).length / runs.length;
  const homeSaleDependenceRate =
    runs.filter((result) => result.homeSaleDependent).length / runs.length;
  const inheritanceDependenceRate =
    runs.filter((result) => result.inheritanceDependent).length / runs.length;
  const rothDepletionRate =
    runs.filter((result) => result.rothDepletedEarly).length / runs.length;
  const earlyFailureProbability =
    runs.filter((result) => {
      if (result.success || result.failureYear === null) {
        return false;
      }
      return result.failureYear <= effectivePlan.startYear + 9;
    }).length / runs.length;
  const medianFailureShortfallDollars = failedRuns.length
    ? median(failedRuns.map((result) => result.failureShortfallAmount))
    : 0;
  const medianDownsideSpendingCutRequired = failedRuns.length
    ? median(failedRuns.map((result) => result.downsideSpendingCutRequired))
    : 0;
  const equitySalesInAdverseEarlyYearsRate =
    runs.filter((result) => result.forcedEquitySalesInAdverseEarlyYears).length / runs.length;
  const riskMetrics: SimulationRiskMetrics = {
    earlyFailureProbability,
    medianFailureShortfallDollars,
    medianDownsideSpendingCutRequired,
    worstDecileEndingWealth: monteCarlo.percentileEndingWealth.p10,
    equitySalesInAdverseEarlyYearsRate,
  };

  const flexibilityScore = Math.max(
    0,
    Math.min(
      100,
      successRate * 55 +
        (1 - homeSaleDependenceRate) * 15 +
        (1 - inheritanceDependenceRate) * 15 +
        (1 - rothDepletionRate) * 10 +
        spendingCutRate * 5,
    ),
  );

  const cornerRiskScore = Math.max(
    0,
    Math.min(
      100,
      (1 - successRate) * 45 +
        homeSaleDependenceRate * 20 +
        inheritanceDependenceRate * 15 +
        rothDepletionRate * 10 +
        spendingCutRate * 10,
    ),
  );

  const annualFederalTaxEstimate = yearlySeries.length
    ? yearlySeries.reduce((total, point) => total + point.medianFederalTax, 0) / yearlySeries.length
    : 0;

  const simulationConfiguration = buildSimulationConfigurationSnapshot({
    assumptions,
    plan: effectivePlan,
    stressors,
    responses,
    strategy: strategyBehavior,
  });
  const simulationDiagnostics = buildSimulationModeDiagnostics({
    yearlySeries,
    failureYearDistribution: monteCarlo.failureYearDistribution,
    runs,
  });

  return {
    simulationMode,
    plannerLogicActive: strategyBehavior.plannerLogicActive,
    successRate,
    medianEndingWealth: monteCarlo.medianEndingWealth,
    endingWealthPercentiles: monteCarlo.percentileEndingWealth,
    medianFailureYear: failureYears.length ? median(failureYears) : null,
    failureYearDistribution: monteCarlo.failureYearDistribution,
    worstOutcome: monteCarlo.worstOutcome,
    bestOutcome: monteCarlo.bestOutcome,
    monteCarloMetadata: {
      ...monteCarlo.metadata,
      planningHorizonYears,
    },
    simulationConfiguration,
    simulationDiagnostics,
    spendingCutRate,
    irmaaExposureRate,
    homeSaleDependenceRate,
    inheritanceDependenceRate,
    rothDepletionRate,
    annualFederalTaxEstimate,
    yearsFunded:
      yearlySeries[0] && yearlySeries[0].medianSpending > 0
        ? Math.round(yearlySeries[0].medianAssets / yearlySeries[0].medianSpending)
        : 0,
    flexibilityScore,
    cornerRiskScore,
    failureMode: summarizeFailureMode(runs, effectivePlan.activeStressors),
    riskMetrics,
    yearlySeries,
  } satisfies SimulationSummary;
}

function buildPathNotes(
  summary: SimulationSummary,
  stressors: Stressor[],
  responses: ResponseOption[],
) {
  if (responses.length && summary.successRate >= 0.7) {
    return `${responses.map((item) => item.name).join(' + ')} meaningfully improves the plan's recovery room.`;
  }

  if (stressors.length && summary.successRate < 0.6) {
    return `${stressors.map((item) => item.name).join(' + ')} puts the first decade under real pressure.`;
  }

  if (summary.spendingCutRate > 0.4) {
    return 'This path stays alive mostly by leaning on guardrail spending cuts.';
  }

  return 'The current assumptions leave a workable path without forcing immediate irreversible decisions.';
}

function buildPathLabel(
  fallback: string,
  stressors: Stressor[],
  responses: ResponseOption[],
) {
  const stressLabel = stressors.map((item) => item.name).join(' + ');
  const responseLabel = responses.map((item) => item.name).join(' + ');

  if (stressLabel && responseLabel) {
    return `${stressLabel} + ${responseLabel}`;
  }

  if (stressLabel) {
    return stressLabel;
  }

  if (responseLabel) {
    return responseLabel;
  }

  return fallback;
}

function toPathResult(
  label: string,
  summary: SimulationSummary,
  stressors: Stressor[],
  responses: ResponseOption[],
): PathResult {
  return {
    id: label.toLowerCase().replaceAll(/\W+/g, '-'),
    label,
    simulationMode: summary.simulationMode,
    plannerLogicActive: summary.plannerLogicActive,
    successRate: summary.successRate,
    medianEndingWealth: summary.medianEndingWealth,
    tenthPercentileEndingWealth: summary.endingWealthPercentiles.p10,
    yearsFunded: summary.yearsFunded,
    medianFailureYear: summary.medianFailureYear,
    spendingCutRate: summary.spendingCutRate,
    irmaaExposureRate: summary.irmaaExposureRate,
    homeSaleDependenceRate: summary.homeSaleDependenceRate,
    inheritanceDependenceRate: summary.inheritanceDependenceRate,
    flexibilityScore: summary.flexibilityScore,
    cornerRiskScore: summary.cornerRiskScore,
    rothDepletionRate: summary.rothDepletionRate,
    annualFederalTaxEstimate: summary.annualFederalTaxEstimate,
    irmaaExposure: getExposureLabel(summary.irmaaExposureRate),
    cornerRisk: getRiskLabel(summary.cornerRiskScore / 100),
    failureMode: summary.failureMode,
    notes: buildPathNotes(summary, stressors, responses),
    stressors: stressors.map((item) => item.name),
    responses: responses.map((item) => item.name),
    endingWealthPercentiles: summary.endingWealthPercentiles,
    failureYearDistribution: summary.failureYearDistribution,
    worstOutcome: summary.worstOutcome,
    bestOutcome: summary.bestOutcome,
    monteCarloMetadata: summary.monteCarloMetadata,
    simulationConfiguration: summary.simulationConfiguration,
    simulationDiagnostics: summary.simulationDiagnostics,
    riskMetrics: summary.riskMetrics,
    yearlySeries: summary.yearlySeries,
  };
}

export function buildPathResults(
  data: SeedData,
  assumptions: MarketAssumptions,
  selectedStressors: string[],
  selectedResponses: string[],
  options?: SimulationExecutionOptions,
) {
  const stressorMap = new Map(data.stressors.map((item) => [item.id, item]));
  const responseMap = new Map(data.responses.map((item) => [item.id, item]));

  const activeStressors = selectedStressors
    .map((id) => stressorMap.get(id))
    .filter((item): item is Stressor => Boolean(item));
  const activeResponses = selectedResponses
    .map((id) => responseMap.get(id))
    .filter((item): item is ResponseOption => Boolean(item));

  const pathMode = options?.pathMode ?? 'all';
  const hasUpsidePath =
    pathMode === 'all' && activeStressors.some((item) => item.id === 'market_up');
  const totalPathRuns = hasUpsidePath ? 4 : 3;
  const totalRunsForMode = pathMode === 'selected_only' ? 1 : totalPathRuns;
  let completedPathRuns = 0;
  options?.onProgress?.(0);

  const runSummaryWithProgress = (stressors: Stressor[], responses: ResponseOption[]) => {
    throwIfSimulationCancelled(options?.isCancelled);
    const offset = completedPathRuns;
    const summary = simulatePath(data, assumptions, stressors, responses, {
      isCancelled: options?.isCancelled,
      onProgress: (localProgress) => {
        options?.onProgress?.((offset + localProgress) / totalRunsForMode);
      },
      annualSpendTarget: options?.annualSpendTarget,
      annualSpendScheduleByYear: options?.annualSpendScheduleByYear,
      strategyMode: options?.strategyMode,
      stressorKnobs: options?.stressorKnobs,
    });
    completedPathRuns += 1;
    options?.onProgress?.(completedPathRuns / totalRunsForMode);
    return summary;
  };

  if (pathMode === 'selected_only') {
    const selectedSummary = runSummaryWithProgress(activeStressors, activeResponses);
    options?.onProgress?.(1);
    return [
      toPathResult(
        buildPathLabel('Selected Path', activeStressors, activeResponses),
        selectedSummary,
        activeStressors,
        activeResponses,
      ),
    ];
  }

  const baselineSummary = runSummaryWithProgress([], []);
  const stressedSummary = runSummaryWithProgress(activeStressors, []);
  const respondedSummary = runSummaryWithProgress(activeStressors, activeResponses);
  const results = [
    toPathResult('Baseline', baselineSummary, [], []),
    toPathResult(
      buildPathLabel('Stress Path', activeStressors, []),
      stressedSummary,
      activeStressors,
      [],
    ),
    toPathResult(
      buildPathLabel('Response Path', activeStressors, activeResponses),
      respondedSummary,
      activeStressors,
      activeResponses,
    ),
  ];

  if (hasUpsidePath) {
    const upsideStressors = data.stressors.filter((item) => item.id === 'market_up');
    const upsideResponses = activeResponses.filter((item) => item.id !== 'early_ss');
    const upsideSummary = runSummaryWithProgress(upsideStressors, upsideResponses);
    results.push(
      toPathResult('Strong Early Market', upsideSummary, upsideStressors, upsideResponses),
    );
  }

  options?.onProgress?.(1);
  return results;
}

export function buildProjectionSeries(pathResults: PathResult[]): ProjectionPoint[] {
  const baseline = pathResults[0];
  const stressed = pathResults[1] ?? pathResults[0];
  const responsePath = pathResults[2] ?? stressed;
  const years = baseline.yearlySeries.map((item) => item.year);

  return years.map((year, index) => ({
    year,
    baseline: baseline.yearlySeries[index]?.medianAssets ?? 0,
    stressed: stressed.yearlySeries[index]?.medianAssets ?? 0,
    spending: responsePath.yearlySeries[index]?.medianSpending ?? 0,
    income: responsePath.yearlySeries[index]?.medianIncome ?? 0,
  }));
}

export function buildDistributionSeries(pathResults: PathResult[]) {
  return pathResults.map((path) => ({
    name: path.label.length > 18 ? `${path.label.slice(0, 18)}...` : path.label,
    success: Math.round(path.successRate * 100),
    failure: Math.round((1 - path.successRate) * 100),
  }));
}

function toParityModeSummary(path: PathResult): SimulationParityModeSummary {
  return {
    label: path.plannerLogicActive ? 'Planner-Enhanced Simulation' : 'Raw Simulation',
    mode: path.simulationMode,
    successRate: path.successRate,
    medianEndingWealth: path.medianEndingWealth,
    medianFailureYear: path.medianFailureYear,
    annualFederalTaxEstimate: path.annualFederalTaxEstimate,
    plannerLogicActive: path.plannerLogicActive,
    simulationConfiguration: path.simulationConfiguration,
    diagnostics: path.simulationDiagnostics,
  };
}

export function buildSimulationParityReport(
  data: SeedData,
  assumptions: MarketAssumptions,
  selectedStressors: string[],
  selectedResponses: string[],
  options?: Pick<SimulationExecutionOptions, 'isCancelled' | 'stressorKnobs'> & {
    plannerPathOverride?: PathResult;
  },
): SimulationParityReport {
  const plannerPath =
    options?.plannerPathOverride ??
    buildPathResults(
      data,
      assumptions,
      selectedStressors,
      selectedResponses,
      {
        pathMode: 'selected_only',
        strategyMode: 'planner_enhanced',
        isCancelled: options?.isCancelled,
        stressorKnobs: options?.stressorKnobs,
      },
    )[0];
  const rawPath = buildPathResults(
    data,
    assumptions,
    selectedStressors,
    selectedResponses,
    {
      pathMode: 'selected_only',
      strategyMode: 'raw_simulation',
      isCancelled: options?.isCancelled,
      stressorKnobs: options?.stressorKnobs,
    },
  )[0];

  return {
    rawSimulation: toParityModeSummary(rawPath),
    plannerEnhancedSimulation: toParityModeSummary(plannerPath),
    successRateDelta: plannerPath.successRate - rawPath.successRate,
    medianEndingWealthDelta: plannerPath.medianEndingWealth - rawPath.medianEndingWealth,
    annualFederalTaxDelta:
      plannerPath.annualFederalTaxEstimate - rawPath.annualFederalTaxEstimate,
    seed: assumptions.simulationSeed ?? 20260416,
    runCount: Math.max(1, assumptions.simulationRuns),
    assumptionsVersion: assumptions.assumptionsVersion ?? 'v1',
  };
}

export function __testOnly_getStressAdjustedReturns(
  activeStressors: string[],
  assumptions: MarketAssumptions,
  yearOffset: number,
  random: RandomSource,
) {
  return getStressAdjustedReturns(
    {
      activeStressors,
    } as Pick<SimPlan, 'activeStressors'> as SimPlan,
    assumptions,
    yearOffset,
    random,
  );
}

export function __testOnly_getSalaryForYear(
  salaryAnnual: number,
  salaryEndDate: string,
  year: number,
) {
  return getSalaryForYear(
    {
      salaryAnnual,
      salaryEndDate,
    } as Pick<SimPlan, 'salaryAnnual' | 'salaryEndDate'> as SimPlan,
    year,
  );
}

export function __testOnly_getSocialSecurityIncome(
  socialSecurity: SocialSecurityEntry[],
  year: number,
  ages: { rob: number; debbie: number },
  inflationIndex: number,
) {
  return getSocialSecurityIncome(
    {
      socialSecurity,
    } as Pick<SimPlan, 'socialSecurity'> as SimPlan,
    year,
    ages,
    inflationIndex,
  );
}

export function __testOnly_getGuardrailState(
  strategyGuardrailsEnabled: boolean,
  fundedYears: number,
  optionalCutActive: boolean,
  guardrails: { floorYears: number; ceilingYears: number; cutPercent: number },
) {
  let nextOptionalCutActive = optionalCutActive;
  if (strategyGuardrailsEnabled && !nextOptionalCutActive && fundedYears < guardrails.floorYears) {
    nextOptionalCutActive = true;
  } else if (
    strategyGuardrailsEnabled &&
    nextOptionalCutActive &&
    fundedYears > guardrails.ceilingYears
  ) {
    nextOptionalCutActive = false;
  }
  return {
    optionalCutActive: nextOptionalCutActive,
    cutMultiplier: nextOptionalCutActive ? 1 - guardrails.cutPercent : 1,
  };
}

export function __testOnly_buildWithdrawalOrder(
  marketState: 'normal' | 'down' | 'up',
  strategy: {
    plannerLogicActive: boolean;
    dynamicDefenseOrdering: boolean;
  },
  balances: Record<AccountBucketType, number>,
  allocations: {
    taxable: Record<string, number>;
    pretax: Record<string, number>;
  },
) {
  const plan = {
    accounts: {
      taxable: {
        withdrawalPriority: 2,
        targetAllocation: allocations.taxable,
      },
      pretax: {
        withdrawalPriority: 3,
        targetAllocation: allocations.pretax,
      },
    },
  } as Pick<SimPlan, 'accounts'> as SimPlan;

  return buildWithdrawalOrder(
    plan,
    balances,
    marketState,
    {
      mode: strategy.plannerLogicActive ? 'planner_enhanced' : 'raw_simulation',
      plannerLogicActive: strategy.plannerLogicActive,
      guardrailsEnabled: strategy.plannerLogicActive,
      dynamicDefenseOrdering: strategy.dynamicDefenseOrdering,
      irmaaAwareWithdrawalBuffer: strategy.plannerLogicActive,
      preserveRothPreference: strategy.plannerLogicActive,
      withdrawalOrderLabel: ['cash', 'taxable', 'pretax', 'roth'],
      acaAwareWithdrawalOptimization: false,
    },
  );
}
