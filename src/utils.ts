import type {
  AccountBucketType,
  ClosedLoopConvergenceThresholds,
  FutureReturnModelExtensionPoint,
  HousingAfterDownsizePolicy,
  LtcHsaDeterministicAuditYear,
  LtcHsaDiagnostics,
  MarketAssumptions,
  MoneyPercentileSummary,
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
  WithdrawalRule,
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
import {
  RANDOM_TAPE_SCHEMA_VERSION,
  buildRandomTapeTrialMap,
  type RandomTapeController,
  type RandomTapeMarketYear,
  type RandomTapeTrial,
  type SimulationRandomTape,
} from './random-tape';
import historicalAnnualReturns from '../fixtures/historical_annual_returns.json';
import {
  calculateIrmaaTier,
  calculateRequiredMinimumDistribution,
  DEFAULT_IRMAA_CONFIG,
  getRmdStartAgeForBirthYear,
} from './retirement-rules';
import {
  calculatePreRetirementContributions,
  calculateProratedSalary,
} from './contribution-engine';
import { calculateHealthcarePremiums } from './healthcare-premium-engine';
import {
  computeAnnualHouseholdSocialSecurity,
  computeAnnualHouseholdSocialSecurityBreakdown,
} from './social-security';
import {
  deriveAssetClassMappingAssumptionsFromAccounts,
  getHoldingExposure,
  type AssetClassMappingAssumptions,
} from './asset-class-mapper';
import { applyAnnualSpendTargetToOptionalSpending } from './policy-adoption';

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
  replacementHomeCost?: number;
  purchaseClosingCostPercent?: number;
  movingCost?: number;
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
  housingAfterDownsizePolicy?: HousingAfterDownsizePolicy;
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
    maxAnnualDollars: number;
    maxPretaxBalancePercent: number;
    magiBufferDollars: number;
    lowIncomeBracketFill: {
      enabled: boolean;
      startYear: number | null;
      endYear: number | null;
      annualTargetDollars: number;
      requireNoWageIncome: boolean;
    };
    source: 'rules' | 'default';
  };
  healthcarePremiums: {
    baselineAcaPremiumAnnual: number;
    baselineMedicarePremiumAnnual: number;
    medicalInflationAnnual: number;
  };
  hsaStrategy: {
    enabled: boolean;
    withdrawalMode: 'high_magi_years' | 'ongoing_qualified_expenses' | 'ltc_reserve';
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
  socialSecurityIncome: number;
  socialSecurityRob: number;
  socialSecurityDebbie: number;
  socialSecurityInflationIndex: number;
  robSocialSecurityClaimFactor: number;
  debbieSocialSecurityClaimFactor: number;
  robSocialSecuritySpousalFloorMonthly: number;
  debbieSocialSecuritySpousalFloorMonthly: number;
  spending: number;
  federalTax: number;
  totalCashOutflow: number;
  withdrawalTotal: number;
  unresolvedFundingGap: number;
  rmdAmount: number;
  withdrawalCash: number;
  withdrawalTaxable: number;
  withdrawalIra401k: number;
  withdrawalRoth: number;
  rothConversion: number;
  rothConversionReason: string;
  rothConversionMotive: 'none' | 'opportunistic_headroom' | 'defensive_pressure';
  rothConversionKind: 'none' | 'safe_room' | 'strategic_extra';
  rothConversionOpportunisticAmount: number;
  rothConversionDefensiveAmount: number;
  rothConversionSafeRoomAvailable: number;
  rothConversionSafeRoomUsed: number;
  rothConversionStrategicExtraAvailable: number;
  rothConversionStrategicExtraUsed: number;
  rothConversionAnnualPolicyMax: number | null;
  rothConversionAnnualPolicyMaxBinding: boolean;
  rothConversionSafeRoomUnusedDueToAnnualPolicyMax: number;
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
  /** End-of-year balances per bucket. `rothBalanceEnd` already exists
   *  (engine uses it for the Roth share / decision math); the other
   *  three are added so the Cockpit balance-by-bucket chart can show
   *  the full split without re-deriving from totalAssets. */
  pretaxBalanceEnd: number;
  taxableBalanceEnd: number;
  cashBalanceEnd: number;
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
  homeSaleGrossProceeds: number;
  homeSaleSellingCosts: number;
  homeReplacementPurchaseCost: number;
  homeDownsizeNetLiquidity: number;
  hsaOffsetUsed: number;
  hsaLtcOffsetUsed: number;
  ltcCostRemainingAfterHsa: number;
  hsaBalanceEnd: number;
  ltcCost: number;
  ltcEventOccurs: boolean;
  ltcEventActive: boolean;
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

interface SummaryYearTrace {
  year: number;
  totalAssets: number;
  spending: number;
  federalTax: number;
  totalCashOutflow: number;
}

interface RandomTapeReferenceTrace {
  year: number;
  totalAssets: number;
  pretaxBalanceEnd: number;
  taxableBalanceEnd: number;
  rothBalanceEnd: number;
  cashBalanceEnd: number;
  spending: number;
  income: number;
  federalTax: number;
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
  ltcEventOccurs: boolean;
  totalLtcCost: number;
  totalHsaOffsetUsed: number;
  totalHsaLtcOffsetUsed: number;
  totalLtcCostRemainingAfterHsa: number;
  ltcCostYears: number;
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
  ltcHsaDiagnostics: LtcHsaDiagnostics;
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
  motive: 'none' | 'opportunistic_headroom' | 'defensive_pressure';
  conversionKind: 'none' | 'safe_room' | 'strategic_extra';
  opportunisticAmount: number;
  defensiveAmount: number;
  safeRoomAvailable: number;
  safeRoomUsed: number;
  strategicExtraAvailable: number;
  strategicExtraUsed: number;
  annualPolicyMax: number | null;
  annualPolicyMaxBinding: boolean;
  safeRoomUnusedDueToAnnualPolicyMax: number;
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
  randomTape?: RandomTapeController;
  outputLevel?: 'full_trace' | 'policy_mining_summary';
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

const dominantValue = <T extends string>(values: T[], fallback: T = 'Tier 1' as T): T => {
  if (!values.length) {
    return fallback;
  }

  const counts = new Map<T, number>();
  values.forEach((value) => {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  });

  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? fallback;
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
  const pretaxTotal = data.accounts.pretax.balance;
  const pretaxAllocationValue: Record<string, number> = {};
  addAllocationValue(
    pretaxAllocationValue,
    data.accounts.pretax.targetAllocation,
    data.accounts.pretax.balance,
  );

  const salaryEndDate = data.income.salaryEndDate;
  const effectiveSpending =
    typeof annualSpendTarget === 'number' &&
      Number.isFinite(annualSpendTarget) &&
      annualSpendTarget >= 0
      ? applyAnnualSpendTargetToOptionalSpending(data.spending, annualSpendTarget)
      : data.spending;
  const rawEssentialAnnual = effectiveSpending.essentialMonthly * 12;
  const rawOptionalAnnual = effectiveSpending.optionalMonthly * 12;
  const rawTaxesInsuranceAnnual = effectiveSpending.annualTaxesInsurance;
  const rawTravelAnnual = effectiveSpending.travelEarlyRetirementAnnual;

  const assetClassMappingAssumptions = deriveAssetClassMappingAssumptionsFromAccounts(
    data.accounts,
    data.rules.assetClassMappingAssumptions,
  );
  const configuredRothPolicy = data.rules.rothConversionPolicy;
  const legacyRothCeilingProxy =
    configuredRothPolicy &&
    configuredRothPolicy.maxAnnualDollars === undefined &&
    configuredRothPolicy.magiBufferDollars !== undefined &&
    configuredRothPolicy.minAnnualDollars === 0;
  const rothConversionPolicy = {
    enabled: configuredRothPolicy?.enabled ?? true,
    strategy: configuredRothPolicy?.strategy ?? 'aca_then_irmaa_headroom',
    minAnnualDollars: Math.max(
      0,
      configuredRothPolicy?.minAnnualDollars ?? DEFAULT_ROTH_CONVERSION_MIN_DOLLARS,
    ),
    maxAnnualDollars: Math.max(
      0,
      configuredRothPolicy?.maxAnnualDollars ??
        (legacyRothCeilingProxy ? configuredRothPolicy.magiBufferDollars ?? 0 : Number.POSITIVE_INFINITY),
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
      legacyRothCeilingProxy
        ? DEFAULT_ROTH_CONVERSION_MAGI_BUFFER
        : configuredRothPolicy?.magiBufferDollars ?? DEFAULT_ROTH_CONVERSION_MAGI_BUFFER,
    ),
    lowIncomeBracketFill: {
      enabled: configuredRothPolicy?.lowIncomeBracketFill?.enabled ?? false,
      startYear:
        typeof configuredRothPolicy?.lowIncomeBracketFill?.startYear === 'number'
          ? Math.floor(configuredRothPolicy.lowIncomeBracketFill.startYear)
          : null,
      endYear:
        typeof configuredRothPolicy?.lowIncomeBracketFill?.endYear === 'number'
          ? Math.floor(configuredRothPolicy.lowIncomeBracketFill.endYear)
          : null,
      annualTargetDollars: Math.max(
        0,
        configuredRothPolicy?.lowIncomeBracketFill?.annualTargetDollars ?? 0,
      ),
      requireNoWageIncome:
        configuredRothPolicy?.lowIncomeBracketFill?.requireNoWageIncome ?? true,
    },
    source: configuredRothPolicy ? 'rules' : 'default',
  } as const;

  return {
    startYear: CURRENT_YEAR,
    planningEndYear: CURRENT_YEAR + horizonYears,
    retirementYear: new Date(salaryEndDate).getFullYear(),
    salaryAnnual: data.income.salaryAnnual,
    salaryEndDate,
    essentialAnnual: rawEssentialAnnual,
    optionalAnnual: rawOptionalAnnual,
    taxesInsuranceAnnual: rawTaxesInsuranceAnnual,
    travelAnnual: rawTravelAnnual,
    travelPhaseYears: assumptions.travelPhaseYears,
    housingAfterDownsizePolicy: data.rules.housingAfterDownsizePolicy
      ? { ...data.rules.housingAfterDownsizePolicy }
      : undefined,
    socialSecurity: data.income.socialSecurity.map((entry) => ({ ...entry })),
    windfalls: data.income.windfalls.map((item) => {
      // When `presentValueGrowthRate` is set, the entered amount is in
      // today's dollars and the source account is assumed to compound at
      // this real rate until `year`. Apply the growth once at ingestion
      // so downstream engine code sees a single year-of-arrival amount.
      const growthRate = item.presentValueGrowthRate;
      if (typeof growthRate !== 'number' || !Number.isFinite(growthRate)) {
        return { ...item };
      }
      const yearsUntil = Math.max(0, item.year - CURRENT_YEAR);
      const factor = (1 + growthRate) ** yearsUntil;
      return {
        ...item,
        amount: item.amount * factor,
        liquidityAmount:
          item.liquidityAmount != null ? item.liquidityAmount * factor : undefined,
        costBasis: item.costBasis != null ? item.costBasis * factor : undefined,
        replacementHomeCost:
          item.replacementHomeCost != null ? item.replacementHomeCost * factor : undefined,
        movingCost: item.movingCost != null ? item.movingCost * factor : undefined,
        // Drop the field on the sim copy so no caller can re-apply it.
        presentValueGrowthRate: undefined,
      };
    }),
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
      withdrawalMode:
        data.rules.hsaStrategy?.withdrawalMode ??
        (data.rules.hsaStrategy?.prioritizeHighMagiYears
          ? 'high_magi_years'
          : 'ongoing_qualified_expenses'),
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
    housingAfterDownsizePolicy: plan.housingAfterDownsizePolicy
      ? { ...plan.housingAfterDownsizePolicy }
      : undefined,
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
      const saleYear = CURRENT_YEAR + (response.triggerYear ?? 3);
      nextPlan.windfalls = nextPlan.windfalls.map((item) =>
        item.name === 'home_sale'
          ? { ...item, year: saleYear }
          : item,
      );
      if (nextPlan.housingAfterDownsizePolicy?.mode === 'own_replacement_home') {
        nextPlan.housingAfterDownsizePolicy = {
          ...nextPlan.housingAfterDownsizePolicy,
          startYear: saleYear,
        };
      }
    }

    if (response.id === 'delay_retirement') {
      const years = response.delayYears ?? 1;
      nextPlan.salaryEndDate = shiftDateYears(nextPlan.salaryEndDate, years);
      nextPlan.retirementYear += years;
    }

    const earlySocialSecurityClaimAge = response.claimAge;
    if (response.id === 'early_ss' && earlySocialSecurityClaimAge !== undefined) {
      nextPlan.socialSecurity = nextPlan.socialSecurity.map((entry) => ({
        ...entry,
        claimAge: Math.min(entry.claimAge ?? 67, earlySocialSecurityClaimAge),
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

/**
 * Phase 1.3 perf: pre-flattened per-allocation exposure cache.
 *
 * Hot-path callers (`getBucketReturn`, `getDefenseScore`) used to do
 * `Object.entries(allocation).reduce(...)` on every (year, trial, bucket),
 * with a nested `Object.entries(exposure).reduce(...)` per symbol. For Full
 * mine that was ~466M outer calls and ~1B+ entry-pair allocations — the
 * V8 baseline profile attributed 8.5% of CPU to `Object.entries` and a
 * large fraction of the std::pair (24.9%) cost to the entries it returned.
 *
 * The allocation Records on `plan.accounts[bucket].targetAllocation` and
 * the `assetClassMappingAssumptions` reference are constant for the lifetime
 * of a `simulatePath` call (and across all simulatePath calls within one
 * `evaluatePolicy`). So we can compute a flat 4-entry asset-class weight
 * vector once per (allocation, assumptions) pair and reuse it.
 *
 * Cache shape: `WeakMap<allocation, { assumptionsRef, flat }>`. WeakMap
 * lets the entries get GC'd alongside the allocation object. Single-slot
 * (not nested by assumptions) because in practice the same allocation is
 * always paired with the same assumptions; if a caller passes a different
 * assumptions reference for the same allocation we transparently rebuild.
 *
 * Float drift note: this changes the order of floating-point summation
 * vs. the original Object.entries traversal. The math is identical by the
 * distributive property; the float result drifts by ~1 ULP per call, which
 * compounds to ~1e-9 relative error in ending balances. That is far below
 * decision-relevant noise for ranking policies (worst case: $0.001 on a
 * $1M portfolio over 30 years). Approved by user 2026-04-27.
 */
type FlatBucketExposure = {
  usEquity: number;
  intlEquity: number;
  bonds: number;
  cash: number;
  defenseScore: number;
};

const FLAT_EXPOSURE_CACHE = new WeakMap<
  Record<string, number>,
  { assumptionsRef: object | undefined; flat: FlatBucketExposure }
>();

function buildFlatBucketExposure(
  allocation: Record<string, number>,
  assumptions?: AssetClassMappingAssumptions,
): FlatBucketExposure {
  let usEquity = 0;
  let intlEquity = 0;
  let bonds = 0;
  let cash = 0;

  // Aggregate weight × exposure[class] per asset class. We sum per class
  // (rather than per symbol then redistributing) so the hot path can do a
  // bare 4-multiply dot product against assetReturns.
  for (const symbol in allocation) {
    const weight = allocation[symbol];
    if (weight === 0) continue;
    const exposure = getAssetExposure(symbol, assumptions);
    usEquity += (exposure.US_EQUITY ?? 0) * weight;
    intlEquity += (exposure.INTL_EQUITY ?? 0) * weight;
    bonds += (exposure.BONDS ?? 0) * weight;
    cash += (exposure.CASH ?? 0) * weight;
  }

  return {
    usEquity,
    intlEquity,
    bonds,
    cash,
    defenseScore: bonds + cash,
  };
}

function getOrBuildFlatBucketExposure(
  allocation: Record<string, number>,
  assumptions?: AssetClassMappingAssumptions,
): FlatBucketExposure {
  const cached = FLAT_EXPOSURE_CACHE.get(allocation);
  if (cached && cached.assumptionsRef === assumptions) {
    return cached.flat;
  }
  const flat = buildFlatBucketExposure(allocation, assumptions);
  FLAT_EXPOSURE_CACHE.set(allocation, { assumptionsRef: assumptions, flat });
  return flat;
}

function getBucketReturn(
  allocation: Record<string, number>,
  assetReturns: Record<AssetClass, number>,
  assumptions?: AssetClassMappingAssumptions,
) {
  const flat = getOrBuildFlatBucketExposure(allocation, assumptions);
  return (
    (assetReturns.US_EQUITY ?? 0) * flat.usEquity +
    (assetReturns.INTL_EQUITY ?? 0) * flat.intlEquity +
    (assetReturns.BONDS ?? 0) * flat.bonds +
    (assetReturns.CASH ?? 0) * flat.cash
  );
}

function getDefenseScore(
  allocation: Record<string, number>,
  assumptions?: AssetClassMappingAssumptions,
) {
  return getOrBuildFlatBucketExposure(allocation, assumptions).defenseScore;
}

function getTaxesInsuranceAnnualForYear(plan: SimPlan, year: number) {
  const policy = plan.housingAfterDownsizePolicy;
  if (
    policy?.mode !== 'own_replacement_home' ||
    typeof policy.startYear !== 'number' ||
    year < policy.startYear
  ) {
    return plan.taxesInsuranceAnnual;
  }

  if (
    typeof policy.postSaleAnnualTaxesInsurance === 'number' &&
    Number.isFinite(policy.postSaleAnnualTaxesInsurance)
  ) {
    return Math.max(0, policy.postSaleAnnualTaxesInsurance);
  }

  const replacementHomeCost = Math.max(0, policy.replacementHomeCost ?? 0);
  if (!(replacementHomeCost > 0)) {
    return plan.taxesInsuranceAnnual;
  }

  const homeSaleAmount = plan.windfalls.find((item) => item.name === 'home_sale')?.amount ?? 0;
  const valueRatio = homeSaleAmount > 0 ? replacementHomeCost / homeSaleAmount : 1;
  return plan.taxesInsuranceAnnual * Math.max(0, valueRatio);
}

function getSalaryForYear(plan: SimPlan, year: number) {
  return calculateProratedSalary({
    salaryAnnual: plan.salaryAnnual,
    retirementDate: plan.salaryEndDate,
    projectionYear: year,
    rule: 'month_fraction',
  });
}

function buildPretaxRmdSourceAccounts(
  data: SeedData,
  pretaxBalanceForRmd: number,
) {
  const sourceAccounts = data.accounts.pretax.sourceAccounts ?? [];
  const ownedTotal = sourceAccounts.reduce(
    (sum, account) => sum + (account.owner ? Math.max(0, account.balance) : 0),
    0,
  );
  if (ownedTotal <= 0) {
    return [];
  }

  return sourceAccounts
    .filter((account) => account.owner && account.balance > 0)
    .map((account) => ({
      id: account.id,
      owner: account.owner,
      balance: pretaxBalanceForRmd * (Math.max(0, account.balance) / ownedTotal),
    }));
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

/**
 * Per-year household SS income, NOMINAL (today's $ × inflationIndex).
 *
 * 2026-04-29 — upgraded to use `social-security.ts` which models:
 *   - SSA-precise own-claim adjustment (5/9 of 1%/mo + 5/12 of 1%/mo
 *     for early-claim; 8%/yr DRC capped at 70 for delayed)
 *   - Spousal-benefit floor: lower earner gets max(own, 50% × higher
 *     PIA), only AFTER higher earner files (SSA's "spousal benefits
 *     begin after the worker files" rule). For the target household
 *     (Rob $4,100, Debbie $1,444), this lifts Debbie's effective FRA
 *     benefit from $1,444 → $2,050 (+42%) starting the year Rob files.
 *
 * NOT modeled (deferred to V2): survivor switch (requires stochastic
 * mortality, not currently in the engine — both spouses are
 * implicitly alive through planning end age in V1).
 */
function getSocialSecurityIncome(
  plan: SimPlan,
  year: number,
  ages: { rob: number; debbie: number },
  inflationIndex: number,
  /**
   * Optional deterministic mortality. When set, the survivor switch
   * fires once one spouse is past their assumed death age. Wired in
   * 2026-04-30 alongside the SS engine integration. Cockpit-side
   * callers usually pass these from MarketAssumptions.{rob,debbie}DeathAge.
   */
  mortality?: { robDeathAge?: number; debbieDeathAge?: number },
) {
  // Convert SimPlan SS entries → social-security.ts inputs.
  const robEntry = plan.socialSecurity.find((e) => e.person === 'rob');
  const debbieEntry = plan.socialSecurity.find((e) => e.person === 'debbie');
  // Without ROB present, fall through to a per-entry sum (own-only)
  // — happens in synthetic test seeds and households with one earner.
  if (!robEntry && !debbieEntry) return 0;
  // Default claim age = FRA (67 for anyone born after 1960). Reached
  // when SS claim age is undefined — happens after 2026-04-30 when
  // claim ages were dropped from the seed (engine output, not input).
  // The Cockpit's `usePlanOptimization` chain always overrides this
  // before projecting, so the FRA default is purely a safety net.
  const FRA_DEFAULT = 67;
  if (!robEntry || !debbieEntry) {
    // Single-earner household: no spousal floor possible. Partial-year
    // support for fractional claim ages: at the year where
    // Math.floor(claimAge) === age, pay only the unclaimed-fraction of
    // months (e.g., claim at 67.5 → 6 months in claim year, 12 months
    // afterward). Mirrors `projectAnnualSocialSecurityIncome` so the
    // single-earner and dual-earner paths agree.
    return plan.socialSecurity.reduce((total, entry) => {
      const age = entry.person === 'rob' ? ages.rob : ages.debbie;
      const claimAge = entry.claimAge ?? FRA_DEFAULT;
      const floor = Math.floor(claimAge);
      let monthsThisYear = 0;
      if (age > floor) monthsThisYear = 12;
      else if (age === floor) {
        monthsThisYear = Math.max(0, Math.round((1 - (claimAge - floor)) * 12));
      }
      if (monthsThisYear === 0) return total;
      return (
        total +
        entry.fraMonthly *
          monthsThisYear *
          getBenefitFactor(claimAge) *
          inflationIndex
      );
    }, 0);
  }
  const annualHouseholdTodayDollars = computeAnnualHouseholdSocialSecurity(
    {
      fraMonthly: robEntry.fraMonthly,
      claimAge: robEntry.claimAge ?? FRA_DEFAULT,
      currentAge: ages.rob,
      assumedDeathAge: mortality?.robDeathAge,
    },
    {
      fraMonthly: debbieEntry.fraMonthly,
      claimAge: debbieEntry.claimAge ?? FRA_DEFAULT,
      currentAge: ages.debbie,
      assumedDeathAge: mortality?.debbieDeathAge,
    },
    67, // FRA — anyone born after 1960 has FRA=67.
  );
  void year;
  return annualHouseholdTodayDollars * inflationIndex;
}

function getSocialSecurityBreakdown(
  plan: SimPlan,
  ages: { rob: number; debbie: number },
  inflationIndex: number,
  mortality?: { robDeathAge?: number; debbieDeathAge?: number },
) {
  const robEntry = plan.socialSecurity.find((e) => e.person === 'rob');
  const debbieEntry = plan.socialSecurity.find((e) => e.person === 'debbie');
  const FRA_DEFAULT = 67;
  if (!robEntry || !debbieEntry) {
    const total = getSocialSecurityIncome(plan, 0, ages, inflationIndex, mortality);
    return {
      householdAnnual: total,
      robAnnual: robEntry ? total : 0,
      debbieAnnual: debbieEntry ? total : 0,
      robClaimFactor: 0,
      debbieClaimFactor: 0,
      robSpousalFloorMonthly: 0,
      debbieSpousalFloorMonthly: 0,
      inflationIndex,
    };
  }

  const breakdown = computeAnnualHouseholdSocialSecurityBreakdown(
    {
      fraMonthly: robEntry.fraMonthly,
      claimAge: robEntry.claimAge ?? FRA_DEFAULT,
      currentAge: ages.rob,
      assumedDeathAge: mortality?.robDeathAge,
    },
    {
      fraMonthly: debbieEntry.fraMonthly,
      claimAge: debbieEntry.claimAge ?? FRA_DEFAULT,
      currentAge: ages.debbie,
      assumedDeathAge: mortality?.debbieDeathAge,
    },
    FRA_DEFAULT,
  );

  return {
    householdAnnual: breakdown.householdAnnual * inflationIndex,
    robAnnual: breakdown.earner1Annual * inflationIndex,
    debbieAnnual: breakdown.earner2Annual * inflationIndex,
    robClaimFactor: breakdown.earner1ClaimFactor,
    debbieClaimFactor: breakdown.earner2ClaimFactor,
    robSpousalFloorMonthly: breakdown.earner1SpousalFloorMonthly * inflationIndex,
    debbieSpousalFloorMonthly: breakdown.earner2SpousalFloorMonthly * inflationIndex,
    inflationIndex,
  };
}

interface WindfallRealization {
  cashInflow: number;
  ordinaryIncome: number;
  ltcgIncome: number;
  homeSaleGrossProceeds: number;
  homeSaleSellingCosts: number;
  homeReplacementPurchaseCost: number;
  homeDownsizeNetLiquidity: number;
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

function emptyWindfallRealization(): WindfallRealization {
  return {
    cashInflow: 0,
    ordinaryIncome: 0,
    ltcgIncome: 0,
    homeSaleGrossProceeds: 0,
    homeSaleSellingCosts: 0,
    homeReplacementPurchaseCost: 0,
    homeDownsizeNetLiquidity: 0,
  };
}

function buildWindfallRealizationForYear(
  windfall: SimWindfall,
  year: number,
  filingStatus: string,
): WindfallRealization {
  const treatment = inferWindfallTaxTreatment(windfall);
  const amount = Math.max(0, windfall.amount);
  const isHomeSale = windfall.name === 'home_sale';
  const modeledSellingCost = isHomeSale
    ? amount * Math.max(0, Math.min(1, windfall.sellingCostPercent ?? 0))
    : 0;
  const replacementHomeCost = isHomeSale
    ? Math.max(0, windfall.replacementHomeCost ?? 0)
    : 0;
  const replacementClosingCost = replacementHomeCost *
    Math.max(0, Math.min(1, windfall.purchaseClosingCostPercent ?? 0));
  const movingCost = isHomeSale ? Math.max(0, windfall.movingCost ?? 0) : 0;
  const homeReplacementPurchaseCost =
    replacementHomeCost + replacementClosingCost + movingCost;
  const defaultLiquidity = Math.max(
    0,
    amount - modeledSellingCost - homeReplacementPurchaseCost,
  );
  const liquidityAmount = Math.max(0, windfall.liquidityAmount ?? defaultLiquidity);
  const homeSaleDiagnostics = isHomeSale
    ? {
        homeSaleGrossProceeds: amount,
        homeSaleSellingCosts: modeledSellingCost,
        homeReplacementPurchaseCost,
        homeDownsizeNetLiquidity: liquidityAmount,
      }
    : {
        homeSaleGrossProceeds: 0,
        homeSaleSellingCosts: 0,
        homeReplacementPurchaseCost: 0,
        homeDownsizeNetLiquidity: 0,
      };
  if (amount <= 0) {
    return emptyWindfallRealization();
  }

  if (treatment === 'inherited_ira_10y') {
    const distributionYears = Math.max(1, Math.round(windfall.distributionYears ?? 10));
    if (year < windfall.year || year >= windfall.year + distributionYears) {
      return emptyWindfallRealization();
    }
    const annualDistribution = amount / distributionYears;
    return {
      cashInflow: annualDistribution,
      ordinaryIncome: annualDistribution,
      ltcgIncome: 0,
      ...homeSaleDiagnostics,
    };
  }

  if (year !== windfall.year) {
    return emptyWindfallRealization();
  }

  if (treatment === 'ordinary_income') {
    return {
      cashInflow: liquidityAmount,
      ordinaryIncome: amount,
      ltcgIncome: 0,
      ...homeSaleDiagnostics,
    };
  }

  if (treatment === 'ltcg') {
    const costBasis = Math.max(0, windfall.costBasis ?? amount);
    const taxableGain = Math.max(0, amount - costBasis);
    return {
      cashInflow: liquidityAmount,
      ordinaryIncome: 0,
      ltcgIncome: taxableGain,
      ...homeSaleDiagnostics,
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
      ...homeSaleDiagnostics,
    };
  }

  return {
    cashInflow: liquidityAmount,
    ordinaryIncome: 0,
    ltcgIncome: 0,
    ...homeSaleDiagnostics,
  };
}

function calculateLtcCostForYear(
  plan: SimPlan,
  ages: { rob: number; debbie: number },
  eventOccurs: boolean,
  yearsSinceStart: number,
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

  // PHASE 2.2 (2026-04-29): inflate LTC cost from simulation start year,
  // not from event-start year. Industry actuarial projections (Genworth
  // Cost of Care, Lincoln Financial) show nominal LTC costs grow ~3.5-5%/yr
  // from today. Previous behavior froze cost at today's-dollars until the
  // event triggered, which undercounted future costs ~3-4× by 2055.
  //
  // For a household where LTC starts at age 85 (year ~20 of sim), the
  // year-1 LTC cost goes from $48k (today's dollars) to $48k × (1.055)^20
  // ≈ $140k (real future cost). This is more accurate to actuarial
  // projections, at the cost of 1-3pp lower headline solvency on the
  // user's plan.
  //
  // Decision locked in CALIBRATION_WORKPLAN.md Phase 0.5 #2.
  return (
    plan.ltcAssumptions.annualCostToday *
    Math.pow(1 + plan.ltcAssumptions.inflationAnnual, yearsSinceStart)
  );
}

function calculateHsaOffsetForYear(input: {
  plan: SimPlan;
  hsaBalance: number;
  magi: number;
  healthcareCost: number;
  ltcCost: number;
}) {
  const qualifiedExpenseNeed = Math.max(0, input.healthcareCost) + Math.max(0, input.ltcCost);
  if (!input.plan.hsaStrategy.enabled || input.hsaBalance <= 0 || qualifiedExpenseNeed <= 0) {
    return 0;
  }
  const withdrawalMode = input.plan.hsaStrategy.withdrawalMode;
  const eligibleNeed =
    withdrawalMode === 'ltc_reserve'
      ? Math.max(0, input.ltcCost)
      : qualifiedExpenseNeed;
  if (eligibleNeed <= 0) {
    return 0;
  }
  if (
    withdrawalMode === 'high_magi_years' &&
    input.magi < input.plan.hsaStrategy.highMagiThreshold
  ) {
    return 0;
  }
  const cap = Math.max(0, input.plan.hsaStrategy.annualQualifiedExpenseWithdrawalCap);
  const cappedNeed = Number.isFinite(cap)
    ? Math.min(eligibleNeed, cap)
    : eligibleNeed;
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

/**
 * Crash-mixture sampler constants. Adds left-tail mass to the parametric
 * equity sampler by mixing in a small per-year probability of a draw
 * from a curated list of historical worst-year US equity returns. Used
 * when `MarketAssumptions.equityTailMode === 'crash_mixture'`.
 *
 * Source returns are S&P 500 worst single calendar years over the past
 * ~95 years (rounded to the published values):
 *   - 1931: -43.8%  (Great Depression deflation crash)
 *   - 2008: -37.0%  (Global Financial Crisis)
 *   - 1937: -35.0%  (Roosevelt Recession)
 *   - 1974: -26.5%  (Stagflation / Bretton Woods collapse)
 *   - 2002: -22.1%  (dot-com bust completion)
 *
 * Probability of 3% per year mirrors empirical frequency: 5 such crashes
 * over ~95 years ≈ 5.3% empirical, but spacing (rare clusters around
 * 1929-32 and 2000-02) means a 3% per-year independent draw produces
 * the ROUGHLY right left-tail mass without overcorrecting. Tunable via
 * the constants below.
 *
 * Mean-preservation: when the crash mixture is on, the bounded-normal
 * sampler's mean is shifted UP slightly so the overall expected return
 * (3% × E[crash] + 97% × adjusted mean) equals the household's
 * configured `equityMean`. Without this adjustment, every crash-mixture
 * scenario would silently drag headline returns lower — turning an
 * "add tail risk" feature into a "lower returns" feature.
 */
const EQUITY_CRASH_RETURNS = [-0.438, -0.370, -0.350, -0.265, -0.221];
const EQUITY_CRASH_PROBABILITY = 0.03;
const EQUITY_CRASH_MEAN =
  EQUITY_CRASH_RETURNS.reduce((acc, r) => acc + r, 0) /
  EQUITY_CRASH_RETURNS.length;

/**
 * Compensating mean shift for the bounded-normal sampler when crash
 * mixture is active. Returns the mean to use for the non-crash draws
 * so that the OVERALL expected return matches `originalMean`.
 *
 * E[overall] = p × E[crash] + (1 − p) × μ_adjusted
 * → μ_adjusted = (originalMean − p × E[crash]) / (1 − p)
 */
function adjustEquityMeanForCrashMixture(originalMean: number): number {
  return (
    (originalMean - EQUITY_CRASH_PROBABILITY * EQUITY_CRASH_MEAN) /
    (1 - EQUITY_CRASH_PROBABILITY)
  );
}

function getStressAdjustedReturns(
  plan: SimPlan,
  assumptions: MarketAssumptions,
  yearOffset: number,
  random: RandomSource,
  presampledBootstrapIndex?: number,
  // Phase 2.B: optional QMC source for the asset-return shock. When
  // present and `useCorrelatedReturns` is true, the four std-normals
  // come from Sobol+inverse-CDF instead of Box-Muller. Other random
  // consumers (inflation, bootstrap, LTC) continue using `random`.
  gaussian4?: import('./monte-carlo-engine').Gaussian4Source,
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

  // Crash-mixture path: with probability `EQUITY_CRASH_PROBABILITY`,
  // override US + INTL equity returns with a draw from the historical
  // crash list. Mean-preserving: when not a crash year, the bounded
  // normal uses an UPWARD-shifted mean so the overall expected return
  // matches the household's configured `equityMean`.
  //
  // Bonds + cash are NOT crashed in unison — historically they tend
  // to rally during equity crashes (flight to quality). They draw
  // from the normal sampler regardless. US and INTL crash TOGETHER
  // at the same value (real crashes correlate globally, especially
  // post-2000).
  //
  // Disabled when `useHistoricalBootstrap: true` (that mode already
  // samples real history, including crash years, so adding another
  // mixture would double-count tail risk).
  const useCrashMixture =
    assumptions.equityTailMode === 'crash_mixture' &&
    !assumptions.useHistoricalBootstrap;
  const isCrashYear = useCrashMixture && random() < EQUITY_CRASH_PROBABILITY;
  const usEquityMean = useCrashMixture
    ? adjustEquityMeanForCrashMixture(assumptions.equityMean)
    : assumptions.equityMean;
  const intlEquityMean = useCrashMixture
    ? adjustEquityMeanForCrashMixture(assumptions.internationalEquityMean)
    : assumptions.internationalEquityMean;

  const assetReturns: Record<AssetClass, number> = isCrashYear
    ? (() => {
        // Crash year: draw a single crash return; both US and INTL
        // get this same value. Bonds + cash sample independently.
        const crashIdx = Math.floor(random() * EQUITY_CRASH_RETURNS.length);
        const crashReturn = EQUITY_CRASH_RETURNS[crashIdx];
        return {
          US_EQUITY: crashReturn,
          INTL_EQUITY: crashReturn,
          BONDS: boundedNormal(
            assumptions.bondMean,
            assumptions.bondVolatility,
            -0.2,
            0.2,
            random,
          ),
          CASH: boundedNormal(
            assumptions.cashMean,
            assumptions.cashVolatility,
            -0.01,
            0.08,
            random,
          ),
        };
      })()
    : assumptions.useCorrelatedReturns
    ? (() => {
        const [usEquity, intlEquity, bonds, cash] = correlatedAssetReturns(
          [
            {
              mean: usEquityMean,
              stdDev: assumptions.equityVolatility,
              min: -0.45,
              max: 0.45,
            },
            {
              mean: intlEquityMean,
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
          gaussian4,
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
          usEquityMean,
          assumptions.equityVolatility,
          -0.45,
          0.45,
          random,
        ),
        INTL_EQUITY: boundedNormal(
          intlEquityMean,
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
  bucketReturns?: Record<AccountBucketType, number>;
  cashflow?: RandomTapeMarketYear['cashflow'];
  marketState: 'normal' | 'down' | 'up';
}

function toRandomTapeMarketYear(
  point: MarketPathPoint,
  year: number,
  yearOffset: number,
): RandomTapeMarketYear {
  return {
    year,
    yearOffset,
    inflation: point.inflation,
    assetReturns: {
      US_EQUITY: point.assetReturns.US_EQUITY,
      INTL_EQUITY: point.assetReturns.INTL_EQUITY,
      BONDS: point.assetReturns.BONDS,
      CASH: point.assetReturns.CASH,
    },
    bucketReturns: point.bucketReturns
      ? {
          pretax: point.bucketReturns.pretax,
          roth: point.bucketReturns.roth,
          taxable: point.bucketReturns.taxable,
          cash: point.bucketReturns.cash,
        }
      : undefined,
    cashflow: point.cashflow ? { ...point.cashflow } : undefined,
    marketState: point.marketState,
  };
}

function fromRandomTapeMarketYear(point: RandomTapeMarketYear): MarketPathPoint {
  return {
    inflation: point.inflation,
    assetReturns: {
      US_EQUITY: point.assetReturns.US_EQUITY,
      INTL_EQUITY: point.assetReturns.INTL_EQUITY,
      BONDS: point.assetReturns.BONDS,
      CASH: point.assetReturns.CASH,
    },
    bucketReturns: point.bucketReturns
      ? {
          pretax: point.bucketReturns.pretax,
          roth: point.bucketReturns.roth,
          taxable: point.bucketReturns.taxable,
          cash: point.bucketReturns.cash,
        }
      : undefined,
    cashflow: point.cashflow ? { ...point.cashflow } : undefined,
    marketState: point.marketState,
  };
}

function buildYearlyMarketPath(
  plan: SimPlan,
  assumptions: MarketAssumptions,
  horizonYears: number,
  random: RandomSource,
  gaussian4?: import('./monte-carlo-engine').Gaussian4Source,
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
        gaussian4,
      ),
    );
  }
  return path;
}

export function buildPolicyMiningRandomTape(input: {
  data: SeedData;
  assumptions: MarketAssumptions;
  annualSpendTarget: number;
  label: string;
  strategyMode?: SimulationStrategyMode;
  stressors?: Stressor[];
  responses?: ResponseOption[];
}): SimulationRandomTape {
  const simulationMode = input.strategyMode ?? 'planner_enhanced';
  const basePlan = buildPlan(
    input.data,
    input.assumptions,
    input.annualSpendTarget,
  );
  const stressedPlan = applyStressors(basePlan, input.stressors ?? [], undefined);
  const effectivePlan = applyResponses(
    stressedPlan,
    input.responses ?? [],
    undefined,
  );
  const runCount = Math.max(1, input.assumptions.simulationRuns);
  const simulationSeed = input.assumptions.simulationSeed ?? 20260416;
  const assumptionsVersion = input.assumptions.assumptionsVersion ?? 'v1';
  const planningHorizonYears =
    effectivePlan.planningEndYear - effectivePlan.startYear + 1;

  const monteCarlo = executeDeterministicMonteCarlo<RandomTapeTrial>({
    seed: simulationSeed,
    trialCount: runCount,
    assumptionsVersion,
    samplingStrategy: input.assumptions.samplingStrategy ?? 'mc',
    maxYearsPerTrial:
      input.assumptions.maxYearsPerTrial ?? Math.max(60, planningHorizonYears),
    summarizeTrial: () => ({
      success: true,
      endingWealth: 0,
      failureYear: null,
    }),
    runTrial: ({ trialIndex, trialSeed, random, gaussian4 }) => {
      const marketPath = buildYearlyMarketPath(
        effectivePlan,
        input.assumptions,
        planningHorizonYears,
        random,
        gaussian4,
      ).map((point, yearOffset) => {
        const bucketReturns =
          point.bucketReturns ??
          (Object.fromEntries(
            SIM_BUCKETS.map((bucket) => [
              bucket,
              getBucketReturn(
                effectivePlan.accounts[bucket].targetAllocation,
                point.assetReturns,
                effectivePlan.assetClassMappingAssumptions,
              ),
            ]),
          ) as Record<AccountBucketType, number>);
        return toRandomTapeMarketYear(
          {
            ...point,
            bucketReturns,
            cashflow: {} as NonNullable<RandomTapeMarketYear['cashflow']>,
          },
          effectivePlan.startYear + yearOffset,
          yearOffset,
        );
      });
      const ltcEventOccurs =
        effectivePlan.ltcAssumptions.enabled &&
        random() < effectivePlan.ltcAssumptions.eventProbability;
      return {
        trialIndex,
        trialSeed,
        ltcEventOccurs,
        marketPath,
      };
    },
  });

  return {
    schemaVersion: RANDOM_TAPE_SCHEMA_VERSION,
    generatedBy: 'typescript',
    createdAtIso: new Date().toISOString(),
    label: input.label,
    simulationMode,
    seed: simulationSeed,
    trialCount: runCount,
    planningHorizonYears,
    assumptionsVersion,
    samplingStrategy: input.assumptions.samplingStrategy ?? 'mc',
    returnModel: {
      useHistoricalBootstrap: input.assumptions.useHistoricalBootstrap ?? false,
      historicalBootstrapBlockLength:
        input.assumptions.historicalBootstrapBlockLength ?? 1,
      useCorrelatedReturns: input.assumptions.useCorrelatedReturns ?? false,
      equityTailMode: input.assumptions.equityTailMode ?? 'normal',
    },
    trials: monteCarlo.runs.sort(
      (left, right) => left.trialIndex - right.trialIndex,
    ),
  };
}

function sumBalances(balances: Record<AccountBucketType, number>) {
  return SIM_BUCKETS.reduce((total, bucket) => total + balances[bucket], 0);
}

function sumBalancesWithHsa(
  balances: Record<AccountBucketType, number>,
  hsaBalance: number,
) {
  return sumBalances(balances) + Math.max(0, hsaBalance);
}

function removeProtectedHsaFromPretax(
  balances: Record<AccountBucketType, number>,
  _hsaBalance: number,
) {
  return {
    protectedHsaBalance: 0,
    spendableBalances: {
      ...balances,
    },
  };
}

function restoreProtectedHsaToPretax(
  balances: Record<AccountBucketType, number>,
  protectedHsaBalance: number,
) {
  return {
    ...balances,
    pretax: balances.pretax + Math.max(0, protectedHsaBalance),
  };
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
const MIN_FAILURE_SHORTFALL_DOLLARS = 0.01;
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
  /**
   * Withdrawal rule — controls bucket order and split logic. Orthogonal
   * to `mode`/`plannerLogicActive` (which control awareness levels).
   * Default `tax_bracket_waterfall` matches pre-2026-05-01 engine behavior.
   */
  withdrawalRule: WithdrawalRule;
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
  withdrawalRule: WithdrawalRule = 'tax_bracket_waterfall',
): StrategyBehavior {
  const plannerLogicActive = mode === 'planner_enhanced';
  // Guyton-Klinger forces guardrails on regardless of strategy mode —
  // that's the defining feature of GK (dynamic spend cuts when funded
  // years drops below floor). Other rules respect the strategy mode's
  // guardrail decision.
  const guyton = withdrawalRule === 'guyton_klinger';

  if (!plannerLogicActive) {
    return {
      mode,
      plannerLogicActive,
      guardrailsEnabled: guyton, // GK forces guardrails on; otherwise off in raw mode
      dynamicDefenseOrdering: false,
      irmaaAwareWithdrawalBuffer: false,
      preserveRothPreference: false,
      withdrawalOrderLabel: withdrawalOrderLabelFor(withdrawalRule),
      acaAwareWithdrawalOptimization: false,
      withdrawalRule,
    };
  }

  return {
    mode,
    plannerLogicActive,
    guardrailsEnabled: true,
    dynamicDefenseOrdering: true,
    irmaaAwareWithdrawalBuffer: plan.irmaaAware,
    preserveRothPreference: plan.preserveRoth,
    withdrawalOrderLabel: withdrawalOrderLabelFor(withdrawalRule),
    acaAwareWithdrawalOptimization: true,
    withdrawalRule,
  };
}

/**
 * Display label for the household-facing strategy summary. Matches
 * the bucket-order semantics each rule actually executes — so the
 * summary the household reads matches what the engine simulates.
 */
function withdrawalOrderLabelFor(rule: WithdrawalRule): string[] {
  switch (rule) {
    case 'tax_bracket_waterfall':
    case 'guyton_klinger':
      return ['cash', 'taxable', 'pretax', 'roth (conditional)'];
    case 'reverse_waterfall':
      return ['cash', 'roth', 'pretax', 'taxable'];
    case 'proportional':
      return ['proportional split: cash + taxable + pretax + roth'];
  }
}

// Rule-specific cascade orders. Proportional doesn't actually use this
// path (it's handled in `withdrawForNeed` via a single pro-rata split),
// but we return all four buckets in a deterministic order for the
// `withdrawalOrderLabel` debug surface and any callers that walk
// `buildWithdrawalOrder` for display.
const REVERSE_WATERFALL_ORDER: AccountBucketType[] = [
  'cash',
  'roth',
  'pretax',
  'taxable',
];

function buildWithdrawalOrder(
  plan: SimPlan,
  balances: Record<AccountBucketType, number>,
  marketState: 'normal' | 'down' | 'up',
  strategy: StrategyBehavior,
) {
  // Reverse waterfall: spend Roth first (defense against future tax-rate
  // hikes — you've locked in today's rate on Roth contributions; pretax
  // and taxable still have unrealized tax exposure). Bypasses the
  // planner-enhanced ACA/IRMAA logic by design — reverse waterfall is
  // explicitly NOT trying to optimize tax brackets, it's optimizing
  // against a different risk (tax-rate hikes).
  if (strategy.withdrawalRule === 'reverse_waterfall') {
    return REVERSE_WATERFALL_ORDER.filter((bucket) => balances[bucket] > 0);
  }

  // Proportional: bucket order doesn't matter for execution (the split
  // logic in `withdrawForNeed` ignores it), but return a stable order
  // for the trace label.
  if (strategy.withdrawalRule === 'proportional') {
    return RAW_WITHDRAWAL_ORDER.filter((bucket) => balances[bucket] > 0);
  }

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

// Phase 1.4 perf: hoist the constant factor table out of
// `buildWithdrawalDecisionTrace`. The trace is built per withdrawal-action
// per year per trial; allocating this 7-entry table on every call cost a
// fresh Array + 7 fresh objects per call. Frozen so a misuse can't mutate
// shared state.
const WITHDRAWAL_DECISION_FACTOR_LABELS: ReadonlyArray<{
  key: keyof WithdrawalDecisionTrace['objectiveScores'];
  label: string;
}> = Object.freeze([
  { key: 'spendingNeed', label: 'spending need coverage' },
  { key: 'marginalTaxCost', label: 'marginal tax cost control' },
  { key: 'magiTarget', label: 'MAGI target control' },
  { key: 'acaCliffAvoidance', label: 'ACA cliff avoidance' },
  { key: 'irmaaCliffAvoidance', label: 'IRMAA cliff avoidance' },
  { key: 'rothOptionality', label: 'Roth optionality preservation' },
  { key: 'sequenceDefense', label: 'sequence-risk defense' },
]);

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

  const objectiveScores = {
    spendingNeed,
    marginalTaxCost: marginalTaxCostScore,
    magiTarget: magiTargetScore,
    acaCliffAvoidance,
    irmaaCliffAvoidance,
    rothOptionality,
    sequenceDefense,
  };

  // Phase 1.4 perf: replace `[...factorLabels].sort(...).slice(0,2).map(...)`
  // (4 array allocations + O(n log n) sort) with an O(n) two-pass top-2
  // selection. n=7 so the absolute savings per call are small, but this
  // function runs per withdrawal-action per year per trial — ~hundreds of
  // millions of times for a Full mine.
  let topIdx = -1;
  let topScore = Number.NEGATIVE_INFINITY;
  let secondIdx = -1;
  let secondScore = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < WITHDRAWAL_DECISION_FACTOR_LABELS.length; i += 1) {
    const score = objectiveScores[WITHDRAWAL_DECISION_FACTOR_LABELS[i].key];
    if (score > topScore) {
      secondIdx = topIdx;
      secondScore = topScore;
      topIdx = i;
      topScore = score;
    } else if (score > secondScore) {
      secondIdx = i;
      secondScore = score;
    }
  }
  const topFactors = [
    WITHDRAWAL_DECISION_FACTOR_LABELS[topIdx].label,
    WITHDRAWAL_DECISION_FACTOR_LABELS[secondIdx].label,
  ];

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
  let rmdSurplusToCash = 0;
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
      rmdSurplusToCash = excessRmd;
    }
  }

  // Proportional rule: split the remaining need pro-rata across all
  // four buckets by current balance (post-RMD). This is the "naive"
  // rule by design — no cliff awareness, no defense ordering. The
  // mining sweep is what tells the household whether this beats the
  // smarter rules in their specific plan.
  if (strategy.withdrawalRule === 'proportional' && remaining > 0) {
    const totalBalance =
      balances.cash + balances.taxable + balances.pretax + balances.roth;
    if (totalBalance > 0) {
      const buckets: AccountBucketType[] = ['cash', 'taxable', 'pretax', 'roth'];
      // Compute pro-rata target per bucket. Cap at available balance to
      // prevent overdraw; iterate until either remaining = 0 or every
      // bucket is exhausted (handles the case where one bucket runs out
      // mid-allocation and the shortfall has to be redistributed).
      let needLeft = remaining;
      for (let pass = 0; pass < 4 && needLeft > 0; pass += 1) {
        const liveBalance = buckets.reduce(
          (sum, b) => sum + Math.max(0, balances[b]),
          0,
        );
        if (liveBalance <= 0) break;
        const passNeed = needLeft;
        for (const bucket of buckets) {
          if (needLeft <= 0) break;
          const bal = balances[bucket];
          if (bal <= 0) continue;
          const share = (bal / liveBalance) * passNeed;
          const take = Math.min(bal, share, needLeft);
          if (take <= 0) continue;
          balances[bucket] -= take;
          withdrawals[bucket] += take;
          needLeft -= take;
          if (bucket === 'pretax') {
            taxInputs.ira401kWithdrawals += take;
          } else if (bucket === 'taxable') {
            taxInputs.realizedLTCG += take * DEFAULT_TAXABLE_WITHDRAWAL_LTCG_RATIO;
          } else if (bucket === 'roth') {
            taxInputs.rothWithdrawals += take;
          }
        }
      }
      recalculateTax();
      remaining = needLeft;
    }
    // Skip the cascade order.forEach below — proportional handled it all.
    const decisionTrace = buildWithdrawalDecisionTrace({
      needed,
      withdrawals,
      taxResult,
      assumptions,
      strategy,
      marketState,
      acaFriendlyMagiCeiling,
    });
    return {
      remaining,
      withdrawals,
      taxInputs,
      taxResult,
      rmdWithdrawn,
      rmdSurplusToCash,
      decisionTrace,
    };
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
  return {
    remaining,
    withdrawals,
    taxInputs,
    taxResult,
    rmdWithdrawn,
    rmdSurplusToCash,
    decisionTrace,
  };
}

function applyProactiveRothConversion(input: {
  year: number;
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
  const emptyConversionRoom = {
    safeRoomAvailable: 0,
    safeRoomUsed: 0,
    strategicExtraAvailable: 0,
    strategicExtraUsed: 0,
    annualPolicyMax: null,
    annualPolicyMaxBinding: false,
    safeRoomUnusedDueToAnnualPolicyMax: 0,
  };
	  const noConversion = (
	    reason: string,
	    overrides?: Partial<Omit<RothConversionTrace, 'amount' | 'reason'>>,
	  ): RothConversionTrace => ({
	    amount: 0,
	    reason,
	    motive: 'none',
	    conversionKind: 'none',
	    opportunisticAmount: 0,
	    defensiveAmount: 0,
	    ...emptyConversionRoom,
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
  const bracketFillPolicy = input.plan.rothConversionPolicy.lowIncomeBracketFill;
  const bracketFillWindowActive =
    bracketFillPolicy.enabled &&
    bracketFillPolicy.annualTargetDollars > 0 &&
    (bracketFillPolicy.startYear === null || input.year >= bracketFillPolicy.startYear) &&
    (bracketFillPolicy.endYear === null || input.year <= bracketFillPolicy.endYear) &&
    (!bracketFillPolicy.requireNoWageIncome ||
      input.withdrawalResult.taxInputs.wages <= 1);

  const baselineBalanceCap =
    Math.max(0, input.balances.pretax) * input.plan.rothConversionPolicy.maxPretaxBalancePercent;
  let effectiveBalanceCap = baselineBalanceCap;
  if (bracketFillWindowActive) {
    effectiveBalanceCap = Math.max(
      effectiveBalanceCap,
      bracketFillPolicy.annualTargetDollars,
    );
  }
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
  const annualPolicyMax = Number.isFinite(input.plan.rothConversionPolicy.maxAnnualDollars)
    ? input.plan.rothConversionPolicy.maxAnnualDollars
    : Number.POSITIVE_INFINITY;
  const rawConversionBudgetBeforeAnnualMax = Math.min(
    effectiveBalanceCap,
    Math.max(0, input.balances.pretax),
  );
  const annualPolicyMaxBinding =
    Number.isFinite(annualPolicyMax) &&
    annualPolicyMax + 0.01 < rawConversionBudgetBeforeAnnualMax;
  const annualPolicyMaxForTrace = Number.isFinite(annualPolicyMax) ? annualPolicyMax : null;
  const totalConversionBudget = Math.min(
    Math.max(0, annualPolicyMax),
    effectiveBalanceCap,
    Math.max(0, input.balances.pretax),
  );
  const defensivePressureAvailable =
    totalConversionBudget > availableHeadroom + 1 &&
    (input.requiredRmdAmount > 0 ||
      (input.yearsUntilRmdStart !== null &&
        input.yearsUntilRmdStart <= 3 &&
        input.balances.pretax > 500_000));
  const roundConversionRoom = (value: number) => Math.round(value * 100) / 100;
  const safeRoomAvailable = roundConversionRoom(availableHeadroom);
  const strategicExtraAvailable = defensivePressureAvailable
    ? roundConversionRoom(Math.max(0, rawConversionBudgetBeforeAnnualMax - availableHeadroom))
    : 0;
  const safeRoomUnusedDueToAnnualPolicyMax = annualPolicyMaxBinding
    ? roundConversionRoom(Math.max(0, availableHeadroom - annualPolicyMax))
    : 0;

  if (availableHeadroom <= 0 && !defensivePressureAvailable) {
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
        safeRoomAvailable,
        strategicExtraAvailable,
        annualPolicyMax: annualPolicyMaxForTrace,
        annualPolicyMaxBinding,
        safeRoomUnusedDueToAnnualPolicyMax,
        eligibilityBlockedReason: 'no_headroom',
        conversionSuppressedReason: 'no_headroom',
      },
    );
  }

  // Phase 1.6 perf: avoid the {...input.withdrawalResult.taxInputs} 14-field
  // spread on every candidate evaluation. We mutate a hoisted scratch object
  // in place — only ira401kWithdrawals changes per candidate, so we capture
  // the baseline once and write (baseline + amount) before each call. The
  // scratch is local to this function and never escapes, so mutation is
  // safe. ~4 candidates × ~117M function calls per Full mine = ~470M
  // 14-field copy operations avoided.
  const baselineIra401kWithdrawals = input.withdrawalResult.taxInputs.ira401kWithdrawals;
  const taxScratch: YearTaxInputs = { ...input.withdrawalResult.taxInputs };
  const calculateTaxForConversion = (conversionAmount: number) => {
    taxScratch.ira401kWithdrawals = baselineIra401kWithdrawals + conversionAmount;
    return calculateFederalTax(taxScratch);
  };

  const MAGI_TOLERANCE_DOLLARS = 0.01;
  // Phase 1.6 perf: build evaluatedCandidateAmounts inline. The old code
  // allocated a [0.25,0.5,0.75,1] literal, mapped it (4 string allocs from
  // toFixed), built a Set, spread back to an array, then sorted. For 4
  // entries that's 5 array allocs + 1 Set + a sort comparator. Replace
  // with a small fixed-size in-place build using string-free 2dp rounding
  // (Math.round(x*100)/100) and an O(n²) cent-precision dedupe scan
  // (worst case 16 comparisons — trivial vs the allocator cost).
  const balancePretaxFloor = Math.max(0, input.balances.pretax);
  const evaluatedCandidateAmounts: number[] = [];
  const candidateMotives = new Map<number, 'opportunistic_headroom' | 'defensive_pressure'>();
  const FRACTIONS_FOR_CONVERSION = [0.25, 0.5, 0.75, 1] as const;
  const pushCandidateAmount = (
    rawAmount: number,
    motive: 'opportunistic_headroom' | 'defensive_pressure',
  ) => {
    let amount = rawAmount;
    if (amount > totalConversionBudget) amount = totalConversionBudget;
    if (amount > balancePretaxFloor) amount = balancePretaxFloor;
    // Match the original cent-precision rounding (was Number(x.toFixed(2))).
    amount = Math.round(amount * 100) / 100;
    if (amount <= 0) return;
    let isDup = false;
    for (let j = 0; j < evaluatedCandidateAmounts.length; j += 1) {
      if (evaluatedCandidateAmounts[j] === amount) {
        isDup = true;
        const previousMotive = candidateMotives.get(amount);
        if (previousMotive === 'defensive_pressure' && motive === 'opportunistic_headroom') {
          candidateMotives.set(amount, motive);
        }
        break;
      }
    }
    if (!isDup) {
      evaluatedCandidateAmounts.push(amount);
      candidateMotives.set(amount, motive);
    }
  };
  for (let i = 0; i < FRACTIONS_FOR_CONVERSION.length; i += 1) {
    pushCandidateAmount(
      availableHeadroom * FRACTIONS_FOR_CONVERSION[i],
      'opportunistic_headroom',
    );
  }
  if (bracketFillWindowActive) {
    pushCandidateAmount(bracketFillPolicy.annualTargetDollars, 'opportunistic_headroom');
  }
  if (defensivePressureAvailable) {
    for (let i = 0; i < FRACTIONS_FOR_CONVERSION.length; i += 1) {
      pushCandidateAmount(
        totalConversionBudget * FRACTIONS_FOR_CONVERSION[i],
        'defensive_pressure',
      );
    }
  }
  // Fractions ascend, but cap-clipping can reorder: if amount[i+1] hits
  // the cap before amount[i] does, ordering needs a final sort. Tiny array
  // (<=4), but we still need to match the original sorted output for the
  // trace. Insertion sort beats Array#sort closure overhead at this size.
  for (let i = 1; i < evaluatedCandidateAmounts.length; i += 1) {
    const v = evaluatedCandidateAmounts[i];
    let j = i - 1;
    while (j >= 0 && evaluatedCandidateAmounts[j] > v) {
      evaluatedCandidateAmounts[j + 1] = evaluatedCandidateAmounts[j];
      j -= 1;
    }
    evaluatedCandidateAmounts[j + 1] = v;
  }
  const candidateAmountsGenerated = evaluatedCandidateAmounts.length > 0;
  if (input.strategy.plannerLogicActive && availableHeadroom > 0 && !candidateAmountsGenerated) {
    // PHASE 2.5 (2026-04-29): converted from throw to graceful return.
    // The previous throw assumed "headroom > 0 AND plannerLogicActive
    // AND no candidates" was a logic bug, but it actually fires when
    // pretax balance is positive but tiny (< $0.01 → all candidate
    // fractions round to $0 cents → empty list). The early guard at
    // line ~2066 catches `pretax <= 0` but not microscopic positive
    // balances. Surfaced during a Full mine where post-LTC-fix
    // depletion drove pretax into this dust-balance region in some
    // tail trials. Right behavior: skip conversion for the year, not
    // crash the trial. Tracked as the same family as
    // `compareRecommendationCandidates` non-transitivity in BACKLOG.
    return noConversion('blocked_by_available_pretax_balance');
  }

  // Phase 1.6 perf: replace the .filter().map() pipeline (which allocates
  // two intermediate arrays plus N candidate-record objects) with a single
  // for-loop that pushes survivors into a pre-allocated array, then a
  // single linear scan to find the best (no .reduce closure). N <= 4 so
  // the scan is trivial; the win is in the per-Full-mine allocator volume.
  type CandidateResult = {
    amount: number;
    motive: 'opportunistic_headroom' | 'defensive_pressure';
    taxAfterConversion: ReturnType<typeof calculateFederalTax>;
    evaluation: ReturnType<typeof evaluateConversionScore>;
  };
  const candidateResults: CandidateResult[] = [];
  let bestCandidate: CandidateResult | null = null;
  const minAnnualDollars = input.plan.rothConversionPolicy.minAnnualDollars;
  const skipCeilingCheck = thresholdType === 'irmaa' && alreadyAboveIrmaaThreshold;
  for (let i = 0; i < evaluatedCandidateAmounts.length; i += 1) {
    const amount = evaluatedCandidateAmounts[i];
    if (amount < minAnnualDollars) continue;
    const taxAfterConversion = calculateTaxForConversion(amount);
    const candidateMotive = candidateMotives.get(amount) ?? 'opportunistic_headroom';
    const crossesAcaCeiling =
      input.acaFriendlyMagiCeiling !== null &&
      taxAfterConversion.MAGI > input.acaFriendlyMagiCeiling + MAGI_TOLERANCE_DOLLARS;
    if (crossesAcaCeiling && acaOverageBefore <= MAGI_TOLERANCE_DOLLARS) {
      continue;
    }
    if (
      targetMagiCeiling !== null &&
      !skipCeilingCheck &&
      candidateMotive !== 'defensive_pressure' &&
      taxAfterConversion.MAGI > targetMagiCeiling + MAGI_TOLERANCE_DOLLARS
    ) {
      continue;
    }
    const evaluation = evaluateConversionScore(amount, taxAfterConversion);
    const result: CandidateResult = {
      amount,
      motive: candidateMotive,
      taxAfterConversion,
      evaluation,
    };
    candidateResults.push(result);
    if (!bestCandidate || evaluation.conversionScore > bestCandidate.evaluation.conversionScore) {
      bestCandidate = result;
    }
  }

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
        safeRoomAvailable,
        strategicExtraAvailable,
        annualPolicyMax: annualPolicyMaxForTrace,
        annualPolicyMaxBinding,
        safeRoomUnusedDueToAnnualPolicyMax,
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
        safeRoomAvailable,
        strategicExtraAvailable,
        annualPolicyMax: annualPolicyMaxForTrace,
        annualPolicyMaxBinding,
        safeRoomUnusedDueToAnnualPolicyMax,
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
	  const conversionMotive = bestCandidate!.motive;
	  conversionReason =
	    conversionMotive === 'defensive_pressure'
	      ? 'executed_strategic_extra_conversion'
	      : 'executed_safe_room_conversion';
  const conversionKind = conversionMotive === 'defensive_pressure'
    ? 'strategic_extra'
    : 'safe_room';

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
	    motive: conversionMotive,
	    conversionKind,
	    opportunisticAmount:
	      conversionMotive === 'opportunistic_headroom' ? conversionAmount : 0,
	    defensiveAmount:
	      conversionMotive === 'defensive_pressure' ? conversionAmount : 0,
	    safeRoomAvailable,
	    safeRoomUsed:
	      conversionMotive === 'opportunistic_headroom' ? conversionAmount : 0,
	    strategicExtraAvailable,
	    strategicExtraUsed:
	      conversionMotive === 'defensive_pressure' ? conversionAmount : 0,
	    annualPolicyMax: annualPolicyMaxForTrace,
	    annualPolicyMaxBinding,
	    safeRoomUnusedDueToAnnualPolicyMax,
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
	    motive: 'none',
	    conversionKind: 'none',
	    opportunisticAmount: 0,
	    defensiveAmount: 0,
	    safeRoomAvailable: 0,
	    safeRoomUsed: 0,
	    strategicExtraAvailable: 0,
	    strategicExtraUsed: 0,
	    annualPolicyMax: null,
	    annualPolicyMaxBinding: false,
	    safeRoomUnusedDueToAnnualPolicyMax: 0,
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
      maxAnnualDollars: Number.isFinite(plan.rothConversionPolicy.maxAnnualDollars)
        ? plan.rothConversionPolicy.maxAnnualDollars
        : null,
      maxPretaxBalancePercent: plan.rothConversionPolicy.maxPretaxBalancePercent,
      magiBufferDollars: plan.rothConversionPolicy.magiBufferDollars,
      lowIncomeBracketFill: plan.rothConversionPolicy.lowIncomeBracketFill,
      source: plan.rothConversionPolicy.source,
      description: strategy.plannerLogicActive
        ? 'Planner-enhanced simulation automatically uses safe Roth conversion room in-year and separately labels strategic-extra conversions beyond clean MAGI room.'
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
  let rothSafeRoomExecutedYearCount = 0;
  let rothStrategicExtraExecutedYearCount = 0;
  let rothAnnualPolicyMaxBindingYearCount = 0;
  let totalSafeRoomUsed = 0;
  let totalStrategicExtraUsed = 0;
  let totalSafeRoomUnusedDueToAnnualPolicyMax = 0;
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
        if (trace.rothConversionKind === 'safe_room') {
          rothSafeRoomExecutedYearCount += 1;
        }
        if (trace.rothConversionKind === 'strategic_extra') {
          rothStrategicExtraExecutedYearCount += 1;
        }
        totalSafeRoomUsed += trace.rothConversionSafeRoomUsed;
        totalStrategicExtraUsed += trace.rothConversionStrategicExtraUsed;
      } else if (trace.rothConversionReason.startsWith('no_economic_benefit')) {
        rothNoEconomicBenefitYearCount += 1;
      } else if (trace.rothConversionReason.startsWith('not_eligible')) {
        rothNotEligibleYearCount += 1;
      } else {
        rothBlockedYearCount += 1;
      }
      if (trace.rothConversionAnnualPolicyMaxBinding) {
        rothAnnualPolicyMaxBindingYearCount += 1;
      }
      totalSafeRoomUnusedDueToAnnualPolicyMax +=
        trace.rothConversionSafeRoomUnusedDueToAnnualPolicyMax;
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
	        representativeMotive: 'none' as const,
	        representativeConversionKind: 'none' as const,
	        representativeOpportunisticAmount: 0,
	        representativeDefensiveAmount: 0,
	        safeRoomAvailable: 0,
	        safeRoomUsed: 0,
	        strategicExtraAvailable: 0,
	        strategicExtraUsed: 0,
	        annualPolicyMax: null,
	        annualPolicyMaxBinding: false,
	        safeRoomUnusedDueToAnnualPolicyMax: 0,
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
      representativeMotive:
        executedTraces.length > 0
          ? dominantValue(executedTraces.map((trace) => trace.rothConversionMotive), 'none') as RunTrace['rothConversionMotive']
          : dominantValue(yearTraces.map((trace) => trace.rothConversionMotive), 'none') as RunTrace['rothConversionMotive'],
      representativeConversionKind:
        executedTraces.length > 0
          ? dominantValue(executedTraces.map((trace) => trace.rothConversionKind), 'none') as RunTrace['rothConversionKind']
          : dominantValue(yearTraces.map((trace) => trace.rothConversionKind), 'none') as RunTrace['rothConversionKind'],
      representativeOpportunisticAmount:
        executedTraces.length > 0
          ? median(executedTraces.map((trace) => trace.rothConversionOpportunisticAmount))
          : 0,
      representativeDefensiveAmount:
        executedTraces.length > 0
          ? median(executedTraces.map((trace) => trace.rothConversionDefensiveAmount))
          : 0,
      safeRoomAvailable: median(
        representativeSet.map((trace) => trace.rothConversionSafeRoomAvailable),
      ),
      safeRoomUsed:
        executedTraces.length > 0
          ? median(executedTraces.map((trace) => trace.rothConversionSafeRoomUsed))
          : 0,
      strategicExtraAvailable: median(
        representativeSet.map((trace) => trace.rothConversionStrategicExtraAvailable),
      ),
      strategicExtraUsed:
        executedTraces.length > 0
          ? median(executedTraces.map((trace) => trace.rothConversionStrategicExtraUsed))
          : 0,
      annualPolicyMax: (() => {
        const values = representativeSet
          .map((trace) => trace.rothConversionAnnualPolicyMax)
          .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
        return values.length > 0 ? median(values) : null;
      })(),
      annualPolicyMaxBinding:
        representativeSet.filter((trace) => trace.rothConversionAnnualPolicyMaxBinding).length /
          representativeSet.length >= 0.5,
      safeRoomUnusedDueToAnnualPolicyMax: median(
        representativeSet.map((trace) => trace.rothConversionSafeRoomUnusedDueToAnnualPolicyMax),
      ),
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
      motive: point.representativeMotive as
        | 'none'
        | 'opportunistic_headroom'
        | 'defensive_pressure',
      conversionKind: point.representativeConversionKind as
        | 'none'
        | 'safe_room'
        | 'strategic_extra',
      opportunisticAmount: point.representativeOpportunisticAmount,
      defensiveAmount: point.representativeDefensiveAmount,
      safeRoomAvailable: point.safeRoomAvailable,
      safeRoomUsed: point.safeRoomUsed,
      strategicExtraAvailable: point.strategicExtraAvailable,
      strategicExtraUsed: point.strategicExtraUsed,
      annualPolicyMax: point.annualPolicyMax,
      annualPolicyMaxBinding: point.annualPolicyMaxBinding,
      safeRoomUnusedDueToAnnualPolicyMax: point.safeRoomUnusedDueToAnnualPolicyMax,
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
      safeRoomExecutedYearCount: rothSafeRoomExecutedYearCount,
      strategicExtraExecutedYearCount: rothStrategicExtraExecutedYearCount,
      annualPolicyMaxBindingYearCount: rothAnnualPolicyMaxBindingYearCount,
      totalSafeRoomUsed: roundSeriesValue(totalSafeRoomUsed),
      totalStrategicExtraUsed: roundSeriesValue(totalStrategicExtraUsed),
      totalSafeRoomUnusedDueToAnnualPolicyMax: roundSeriesValue(
        totalSafeRoomUnusedDueToAnnualPolicyMax,
      ),
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

function emptySimulationModeDiagnostics(
  yearlySeries: PathYearResult[],
  failureYearDistribution: Array<{ year: number; count: number; rate: number }>,
): SimulationModeDiagnostics {
  return {
    effectiveSpendPath: yearlySeries.map((point) => ({
      year: point.year,
      value: point.medianSpending,
    })),
    withdrawalPath: [],
    withdrawalRationalePath: [],
    taxesPaidPath: yearlySeries.map((point) => ({
      year: point.year,
      value: point.medianFederalTax,
    })),
    magiPath: [],
    conversionPath: [],
    rothConversionTracePath: [],
    rothConversionEligibilityPath: [],
    rothConversionDecisionSummary: {
      executedYearCount: 0,
      safeRoomExecutedYearCount: 0,
      strategicExtraExecutedYearCount: 0,
      annualPolicyMaxBindingYearCount: 0,
      totalSafeRoomUsed: 0,
      totalStrategicExtraUsed: 0,
      totalSafeRoomUnusedDueToAnnualPolicyMax: 0,
      blockedYearCount: 0,
      noEconomicBenefitYearCount: 0,
      notEligibleYearCount: 0,
      reasons: [],
    },
    failureYearDistribution,
    closedLoopConvergenceSummary: {
      converged: false,
      convergedRate: 0,
      passesUsed: 0,
      stopReason: 'max_pass_limit_reached',
      finalMagiDelta: 0,
      finalFederalTaxDelta: 0,
      finalHealthcarePremiumDelta: 0,
      convergedBeforeMaxPasses: false,
      convergedBeforeMaxPassesRate: 0,
    },
    closedLoopConvergencePath: [],
    closedLoopRunSummary: {
      runCount: 0,
      convergedRunCount: 0,
      nonConvergedRunCount: 0,
      convergedRunRate: 0,
      stopReasonCounts: {
        converged_thresholds_met: 0,
        max_pass_limit_reached: 0,
        no_change: 0,
        oscillation_detected: 0,
      },
      nonConvergedRunIndexes: [],
    },
    closedLoopRunConvergence: [],
  };
}

function summaryOnlyPathYearResult(input: {
  year: number;
  medianAssets: number;
  tenthPercentileAssets: number;
	  medianSpending: number;
	  medianFederalTax: number;
	  medianTotalCashOutflow?: number;
	}): PathYearResult {
  return {
    year: input.year,
    medianAssets: input.medianAssets,
    medianPretaxBalance: 0,
    medianTaxableBalance: 0,
    medianRothBalance: 0,
    medianCashBalance: 0,
    tenthPercentileAssets: input.tenthPercentileAssets,
	    medianIncome: 0,
	    medianSocialSecurityIncome: 0,
	    medianSocialSecurityRob: 0,
	    medianSocialSecurityDebbie: 0,
	    medianSocialSecurityInflationIndex: 0,
	    robSocialSecurityClaimFactor: 0,
	    debbieSocialSecurityClaimFactor: 0,
	    robSocialSecuritySpousalFloorMonthly: 0,
	    debbieSocialSecuritySpousalFloorMonthly: 0,
	    medianSpending: input.medianSpending,
	    medianFederalTax: input.medianFederalTax,
	    medianTotalCashOutflow:
	      input.medianTotalCashOutflow ?? input.medianSpending + input.medianFederalTax,
	    medianWithdrawalTotal: 0,
	    medianUnresolvedFundingGap: 0,
	    medianRmdAmount: 0,
    medianWithdrawalCash: 0,
    medianWithdrawalTaxable: 0,
    medianWithdrawalIra401k: 0,
    medianWithdrawalRoth: 0,
    medianRothConversion: 0,
    dominantRothConversionReason: 'summary_only',
    dominantRothConversionMotive: 'none',
    medianRothConversionOpportunistic: 0,
    medianRothConversionDefensive: 0,
    medianRothConversionMagiEffect: 0,
    medianRothConversionTaxEffect: 0,
    medianRothConversionAcaEffect: 0,
    medianRothConversionIrmaaEffect: 0,
    medianRothConversionPretaxBalanceEffect: 0,
    medianTaxableIncome: 0,
    medianMagi: 0,
    dominantIrmaaTier: 'Tier 1',
    medianMedicareSurcharge: 0,
    medianEmployee401kContribution: 0,
    medianEmployerMatchContribution: 0,
    medianTotal401kContribution: 0,
    medianHsaContribution: 0,
    medianAdjustedWages: 0,
    medianTaxableWageReduction: 0,
    medianPretaxBalanceAfterContributions: 0,
    medianAcaPremiumEstimate: 0,
    medianAcaSubsidyEstimate: 0,
    medianNetAcaCost: 0,
    medianMedicarePremiumEstimate: 0,
    medianIrmaaSurcharge: 0,
    medianTotalHealthcarePremiumCost: 0,
    medianWindfallCashInflow: 0,
    medianWindfallOrdinaryIncome: 0,
    medianWindfallLtcgIncome: 0,
    medianHomeSaleGrossProceeds: 0,
    medianHomeSaleSellingCosts: 0,
    medianHomeReplacementPurchaseCost: 0,
    medianHomeDownsizeNetLiquidity: 0,
    medianHsaOffsetUsed: 0,
    medianHsaLtcOffsetUsed: 0,
    medianLtcCostRemainingAfterHsa: 0,
    medianHsaBalance: 0,
    medianLtcCost: 0,
    dominantWithdrawalRationale: 'summary_only',
    medianWithdrawalScoreSpendingNeed: 0,
    medianWithdrawalScoreMarginalTaxCost: 0,
    medianWithdrawalScoreMagiTarget: 0,
    medianWithdrawalScoreAcaCliffAvoidance: 0,
    medianWithdrawalScoreIrmaaCliffAvoidance: 0,
    medianWithdrawalScoreRothOptionality: 0,
    medianWithdrawalScoreSequenceDefense: 0,
    closedLoopConverged: false,
    closedLoopConvergedRate: 0,
    closedLoopConvergedBeforeMaxPasses: false,
    closedLoopConvergedBeforeMaxPassesRate: 0,
    closedLoopPassesUsed: 0,
    medianClosedLoopPassesUsed: 0,
    closedLoopStopReason: 'summary_only',
    finalMagiDelta: 0,
    finalFederalTaxDelta: 0,
    finalHealthcarePremiumDelta: 0,
    medianClosedLoopLastMagiDelta: 0,
    medianClosedLoopLastFederalTaxDelta: 0,
    medianClosedLoopLastHealthcarePremiumDelta: 0,
    dominantClosedLoopStopReason: 'summary_only',
  };
}

function roundSeriesValue(value: number) {
  return Number(value.toFixed(0));
}

function buildCashflowReconciliationFromTraces(
  traces: RunTrace[],
): NonNullable<PathYearResult['cashflowReconciliation']> {
  const medianOf = (selector: (trace: RunTrace) => number) =>
    roundSeriesValue(median(traces.map(selector)));
  const withdrawals = {
    cash: medianOf((trace) => trace.withdrawalCash),
    taxable: medianOf((trace) => trace.withdrawalTaxable),
    ira401k: medianOf((trace) => trace.withdrawalIra401k),
    roth: medianOf((trace) => trace.withdrawalRoth),
  };
  const withdrawalTotal =
    withdrawals.cash + withdrawals.taxable + withdrawals.ira401k + withdrawals.roth;
  const inflows = {
    income: medianOf((trace) => trace.income),
    adjustedWages: medianOf((trace) => trace.adjustedWages),
    socialSecurity: medianOf((trace) => trace.socialSecurityIncome),
    rmd: medianOf((trace) => trace.rmdAmount),
    windfallCash: medianOf((trace) => trace.windfallCashInflow),
  };
  const outflows = {
    spendingIncludingHealthcareAndLtc: medianOf((trace) => trace.spending),
    federalTax: medianOf((trace) => trace.federalTax),
    healthcarePremiums: medianOf((trace) => trace.totalHealthcarePremiumCost),
    ltcCost: medianOf((trace) => trace.ltcCost),
    hsaOffset: medianOf((trace) => trace.hsaOffsetUsed),
  };
  const totalOutflows = outflows.spendingIncludingHealthcareAndLtc + outflows.federalTax;
  const totalAvailableForOutflows = inflows.income + withdrawalTotal;
  const surplusOrGap = roundSeriesValue(totalAvailableForOutflows - totalOutflows);
  const unresolvedFundingGap = medianOf((trace) => trace.unresolvedFundingGap);

  return {
    method: 'median_year_cashflow_components',
    inflows,
    withdrawals: {
      ...withdrawals,
      total: withdrawalTotal,
    },
    outflows: {
      ...outflows,
      total: totalOutflows,
    },
    totalAvailableForOutflows,
    surplusOrGap,
    unresolvedFundingGap,
    equationCheck: {
      availableMinusOutflowsMinusSurplusOrGap: roundSeriesValue(
        totalAvailableForOutflows - totalOutflows - surplusOrGap,
      ),
    },
    notes: [
      'Withdrawals are cashflow funding sources, not additional wealth creation.',
      'Market gains/losses and intra-account reallocations explain balance movement beyond this cashflow tie-out.',
    ],
  };
}

function buildMoneyPercentiles(values: number[]): MoneyPercentileSummary {
  if (!values.length) {
    return { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0 };
  }
  return {
    p10: roundSeriesValue(percentile(values, 0.1)),
    p25: roundSeriesValue(percentile(values, 0.25)),
    p50: roundSeriesValue(median(values)),
    p75: roundSeriesValue(percentile(values, 0.75)),
    p90: roundSeriesValue(percentile(values, 0.9)),
  };
}

function buildDeterministicLtcHsaTrace(input: {
  plan: SimPlan;
  ages: { rob: number; debbie: number };
  planningHorizonYears: number;
  initialHsaBalance: number;
  eventOccurs: boolean;
}): LtcHsaDeterministicAuditYear[] {
  let hsaBalance = input.initialHsaBalance;
  return Array.from({ length: input.planningHorizonYears }, (_, yearOffset) => {
    const year = input.plan.startYear + yearOffset;
    const robAge = input.ages.rob + yearOffset;
    const debbieAge = input.ages.debbie + yearOffset;
    const ltcCost = calculateLtcCostForYear(
      input.plan,
      { rob: robAge, debbie: debbieAge },
      input.eventOccurs,
      yearOffset,
    );
    const hsaOffsetUsed = calculateHsaOffsetForYear({
      plan: input.plan,
      hsaBalance,
      magi: 0,
      healthcareCost: 0,
      ltcCost,
    });
    const hsaLtcOffsetUsed = Math.min(hsaOffsetUsed, ltcCost);
    hsaBalance = Math.max(0, hsaBalance - hsaOffsetUsed);
    return {
      year,
      robAge,
      debbieAge,
      ltcEventActive: ltcCost > 0,
      ltcCost: roundSeriesValue(ltcCost),
      hsaOffsetUsed: roundSeriesValue(hsaOffsetUsed),
      hsaLtcOffsetUsed: roundSeriesValue(hsaLtcOffsetUsed),
      ltcCostRemainingAfterHsa: roundSeriesValue(Math.max(0, ltcCost - hsaLtcOffsetUsed)),
      hsaBalanceEnd: roundSeriesValue(hsaBalance),
    };
  });
}

function expectedLtcHsaTrace(
  noEvent: LtcHsaDeterministicAuditYear[],
  withEvent: LtcHsaDeterministicAuditYear[],
  eventProbability: number,
): LtcHsaDeterministicAuditYear[] {
  return withEvent.map((withEventYear, index) => {
    const noEventYear = noEvent[index] ?? withEventYear;
    const expected = (selector: (year: LtcHsaDeterministicAuditYear) => number) =>
      roundSeriesValue(
        eventProbability * selector(withEventYear) +
          (1 - eventProbability) * selector(noEventYear),
      );
    return {
      year: withEventYear.year,
      robAge: withEventYear.robAge,
      debbieAge: withEventYear.debbieAge,
      ltcEventActive: eventProbability > 0 && withEventYear.ltcEventActive,
      ltcCost: expected((year) => year.ltcCost),
      hsaOffsetUsed: expected((year) => year.hsaOffsetUsed),
      hsaLtcOffsetUsed: expected((year) => year.hsaLtcOffsetUsed),
      ltcCostRemainingAfterHsa: expected((year) => year.ltcCostRemainingAfterHsa),
      hsaBalanceEnd: expected((year) => year.hsaBalanceEnd),
    };
  });
}

function buildLtcHsaPathVisibilityFromTraces(traces: RunTrace[]): NonNullable<
  PathYearResult['ltcHsaPathVisibility']
> {
  return {
    ltcEventTriggeredRate: traces.length
      ? traces.filter((trace) => trace.ltcEventOccurs).length / traces.length
      : 0,
    ltcEventActiveRate: traces.length
      ? traces.filter((trace) => trace.ltcEventActive).length / traces.length
      : 0,
    ltcCostPercentiles: buildMoneyPercentiles(traces.map((trace) => trace.ltcCost)),
    hsaOffsetUsedPercentiles: buildMoneyPercentiles(
      traces.map((trace) => trace.hsaOffsetUsed),
    ),
    hsaLtcOffsetUsedPercentiles: buildMoneyPercentiles(
      traces.map((trace) => trace.hsaLtcOffsetUsed),
    ),
    ltcCostRemainingAfterHsaPercentiles: buildMoneyPercentiles(
      traces.map((trace) => trace.ltcCostRemainingAfterHsa),
    ),
    hsaBalancePercentiles: buildMoneyPercentiles(
      traces.map((trace) => trace.hsaBalanceEnd),
    ),
  };
}

function buildLtcHsaDiagnostics(input: {
  plan: SimPlan;
  ages: { rob: number; debbie: number };
  planningHorizonYears: number;
  initialHsaBalance: number;
  yearlySeries: PathYearResult[];
  runs: SimulationRunResult[];
}): LtcHsaDiagnostics {
  const noEvent = buildDeterministicLtcHsaTrace({
    plan: input.plan,
    ages: input.ages,
    planningHorizonYears: input.planningHorizonYears,
    initialHsaBalance: input.initialHsaBalance,
    eventOccurs: false,
  });
  const withEvent = buildDeterministicLtcHsaTrace({
    plan: input.plan,
    ages: input.ages,
    planningHorizonYears: input.planningHorizonYears,
    initialHsaBalance: input.initialHsaBalance,
    eventOccurs: true,
  });
  const eventProbability = input.plan.ltcAssumptions.eventProbability;
  const cap = input.plan.hsaStrategy.annualQualifiedExpenseWithdrawalCap;

  return {
    assumptions: {
      enabled: input.plan.ltcAssumptions.enabled,
      startAge: input.plan.ltcAssumptions.startAge,
      annualCostToday: input.plan.ltcAssumptions.annualCostToday,
      durationYears: input.plan.ltcAssumptions.durationYears,
      inflationAnnual: input.plan.ltcAssumptions.inflationAnnual,
      eventProbability,
    },
    hsaStrategy: {
      enabled: input.plan.hsaStrategy.enabled,
      withdrawalMode: input.plan.hsaStrategy.withdrawalMode,
      annualQualifiedExpenseWithdrawalCap: Number.isFinite(cap) ? cap : 'uncapped',
    },
    monteCarlo: {
      trialCount: input.runs.length,
      ltcEventRunCount: input.runs.filter((run) => run.ltcEventOccurs).length,
      ltcEventIncidenceRate: input.runs.length
        ? input.runs.filter((run) => run.ltcEventOccurs).length / input.runs.length
        : 0,
      ltcCostYearCountPercentiles: buildMoneyPercentiles(
        input.runs.map((run) => run.ltcCostYears),
      ),
      totalLtcCostPercentiles: buildMoneyPercentiles(
        input.runs.map((run) => run.totalLtcCost),
      ),
      totalHsaOffsetUsedPercentiles: buildMoneyPercentiles(
        input.runs.map((run) => run.totalHsaOffsetUsed),
      ),
      totalHsaLtcOffsetUsedPercentiles: buildMoneyPercentiles(
        input.runs.map((run) => run.totalHsaLtcOffsetUsed),
      ),
      totalLtcCostRemainingAfterHsaPercentiles: buildMoneyPercentiles(
        input.runs.map((run) => run.totalLtcCostRemainingAfterHsa),
      ),
    },
    annualPath: input.yearlySeries.map((point) => ({
      year: point.year,
      ...(point.ltcHsaPathVisibility ?? {
        ltcEventTriggeredRate: 0,
        ltcEventActiveRate: 0,
        ltcCostPercentiles: buildMoneyPercentiles([]),
        hsaOffsetUsedPercentiles: buildMoneyPercentiles([]),
        hsaLtcOffsetUsedPercentiles: buildMoneyPercentiles([]),
        ltcCostRemainingAfterHsaPercentiles: buildMoneyPercentiles([]),
        hsaBalancePercentiles: buildMoneyPercentiles([]),
      }),
    })),
    deterministicAudit: {
      method: 'isolated_ltc_hsa_reserve_trace',
      noEvent,
      withEvent,
      expectedValue: expectedLtcHsaTrace(noEvent, withEvent, eventProbability),
      notes: [
        'Deterministic audit isolates LTC/HSA mechanics from market returns, taxes, and healthcare premiums.',
        'Monte Carlo aggregates use the actual simulated yearly path, including failures before later LTC years.',
      ],
    },
  };
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
  // Withdrawal rule comes from MarketAssumptions (defaults to today's
  // behavior, tax_bracket_waterfall). Mining sweeps this axis to find
  // the rule that best fits the household's stated north stars.
  const strategyBehavior = getStrategyBehavior(
    simulationMode,
    effectivePlan,
    assumptions.withdrawalRule ?? 'tax_bracket_waterfall',
  );
  const runCount = Math.max(1, assumptions.simulationRuns);
  const simulationSeed = assumptions.simulationSeed ?? 20260416;
  const assumptionsVersion = assumptions.assumptionsVersion ?? 'v1';
  const planningHorizonYears =
    effectivePlan.planningEndYear - effectivePlan.startYear + 1;
  const summaryOnly = options?.outputLevel === 'policy_mining_summary';
  const yearlyBuckets = new Map<number, RunTrace[]>();
  const summaryYearlyBuckets = new Map<number, SummaryYearTrace[]>();
  const randomTape = options?.randomTape;
  const replayTapeTrialMap =
    randomTape?.mode === 'replay' && randomTape.tape
      ? buildRandomTapeTrialMap(randomTape.tape)
      : null;
  const recordedTapeTrials: RandomTapeTrial[] = [];

  if (randomTape?.mode === 'replay' && !randomTape.tape) {
    throw new Error('Random tape replay requested without a tape');
  }
  if (
    randomTape?.mode === 'replay' &&
    randomTape.tape &&
    randomTape.tape.planningHorizonYears !== planningHorizonYears
  ) {
    throw new Error(
      `Random tape horizon mismatch: tape=${randomTape.tape.planningHorizonYears} engine=${planningHorizonYears}`,
    );
  }

  // Hoist out of the trial+year loop: birth-derived constants are the same
  // for every (trial, year) pair within a simulatePath call. Without this
  // hoist we hit `new Date(birthDate).getFullYear()` per year per trial —
  // ~233M allocations per Full mine. The V8 profile (Phase 0) showed
  // `Date.prototype.getFullYear` at 2.2% of CPU and contributed to the
  // 24.9% spent in `std::pair<string,string>` from the underlying string
  // parsing. Constants per simulatePath, computed once here.
  const rmdPolicyOverride = data.rules.rmdPolicy?.startAgeOverride;
  const robRmdStartAgeConst =
    rmdPolicyOverride ??
    getRmdStartAgeForBirthYear(new Date(data.household.robBirthDate).getFullYear());
  const debbieRmdStartAgeConst =
    rmdPolicyOverride ??
    getRmdStartAgeForBirthYear(new Date(data.household.debbieBirthDate).getFullYear());

  const monteCarlo = executeDeterministicMonteCarlo<SimulationRunResult>({
    seed: simulationSeed,
    trialCount: runCount,
    assumptionsVersion,
    onProgress: options?.onProgress,
    isCancelled: options?.isCancelled,
    // Phase 2.B: when assumptions request QMC sampling, the engine
    // provides each trial with a Sobol-backed `gaussian4` source for
    // the asset-return shock. Default 'mc' preserves all existing
    // golden tests and pre-Phase-2 behavior.
    samplingStrategy: assumptions.samplingStrategy ?? 'mc',
    maxYearsPerTrial: assumptions.maxYearsPerTrial ?? Math.max(60, planningHorizonYears),
    summarizeTrial: (result) => ({
      success: result.success,
      endingWealth: result.endingWealth,
      failureYear: result.failureYear,
    }),
    runTrial: ({ trialIndex, trialSeed, random, gaussian4 }) => {
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
      const yearlyReference: RandomTapeReferenceTrace[] = [];
      const magiHistory = new Map<number, number>();
      const replayTrial = replayTapeTrialMap?.get(trialIndex);
      if (replayTapeTrialMap && !replayTrial) {
        throw new Error(`Random tape missing trial ${trialIndex}`);
      }
      if (replayTrial && replayTrial.trialSeed !== trialSeed) {
        throw new Error(
          `Random tape trial seed mismatch for trial ${trialIndex}: tape=${replayTrial.trialSeed} engine=${trialSeed}`,
        );
      }
      const marketPath = replayTrial
        ? replayTrial.marketPath.map(fromRandomTapeMarketYear)
        : buildYearlyMarketPath(
            effectivePlan,
            assumptions,
            planningHorizonYears,
            random,
            gaussian4,
          );
      const ltcEventOccurs =
        replayTrial?.ltcEventOccurs ??
        (effectivePlan.ltcAssumptions.enabled &&
          random() < effectivePlan.ltcAssumptions.eventProbability);
      for (let year = effectivePlan.startYear; year <= effectivePlan.planningEndYear; year += 1) {
        throwIfSimulationCancelled(options?.isCancelled);

        const yearOffset = year - effectivePlan.startYear;
        const robAge = ages.rob + yearOffset;
        const debbieAge = ages.debbie + yearOffset;
        const robRmdStartAge = robRmdStartAgeConst;
        const debbieRmdStartAge = debbieRmdStartAgeConst;
        const yearsUntilRmdStart = Math.max(
          0,
          Math.min(robRmdStartAge - robAge, debbieRmdStartAge - debbieAge),
        );
        const isRetired = year >= effectivePlan.retirementYear;
        const marketPoint =
          marketPath[yearOffset] ??
          getStressAdjustedReturns(effectivePlan, assumptions, yearOffset, random, undefined, gaussian4);
        const { inflation, assetReturns, marketState } = marketPoint;
        const pretaxBalanceForRmd = Math.max(0, balances.pretax);

        const totalAssetsAtStart = sumBalancesWithHsa(balances, hsaBalance);
        const rothBalanceStartForYear = balances.roth;
        const yearsIntoRetirement = year - effectivePlan.retirementYear;
        // Travel phase applies from today through the end of the go-go
        // window (travelPhaseYears past retirement). Pre-retirement
        // years count too — many households (this one included) travel
        // actively in the years leading up to retirement, not just
        // after. The simulation starts at the current year, so there's
        // no risk of activating travel in years that don't matter to
        // the projection. The phase ends `travelPhaseYears` post-
        // retirement (when the household enters slow-go years).
        const inTravelPhase =
          yearsIntoRetirement < effectivePlan.travelPhaseYears;
        const taxesInsuranceAnnualForYear = getTaxesInsuranceAnnualForYear(
          effectivePlan,
          year,
        );
        const fixedSpendAnnual =
          effectivePlan.essentialAnnual + taxesInsuranceAnnualForYear;
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
        let spendingCutTriggeredThisYear = false;
        if (
          strategyBehavior.guardrailsEnabled &&
          !optionalCutActive &&
          fundedYears < effectivePlan.guardrails.floorYears
        ) {
          optionalCutActive = true;
          spendingCutsTriggered += 1;
          spendingCutTriggeredThisYear = true;
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
          (effectivePlan.essentialAnnual + optionalSpend + taxesInsuranceAnnualForYear + travelSpend) *
          inflationIndex;

        const salary = getSalaryForYear(effectivePlan, year);
        const contributionResult = calculatePreRetirementContributions({
          age: robAge,
          salaryAnnual: effectivePlan.salaryAnnual,
          salaryThisYear: salary,
          retirementDate: effectivePlan.salaryEndDate,
          projectionYear: year,
          salaryProrationRule: data.rules.payrollModel?.salaryProrationRule,
          filingStatus: data.household.filingStatus,
          settings: data.income.preRetirementContributions,
          limitSettings: data.rules.contributionLimits,
          accountBalances: {
            pretax: balances.pretax,
            roth: balances.roth,
            hsa: hsaBalance,
          },
        });
        balances.pretax +=
          contributionResult.employee401kPreTaxContribution +
          contributionResult.employerMatchContribution;
        balances.roth += contributionResult.employee401kRothContribution;
        hsaBalance += contributionResult.hsaContribution;
        const pretaxBalanceAfterContributionsForYear = balances.pretax;
        const rothContributionFlowForYear = balances.roth - rothBalanceStartForYear;
        const adjustedWages = contributionResult.adjustedWages;
        const socialSecurityIncome = getSocialSecurityIncome(
          effectivePlan,
          year,
          { rob: robAge, debbie: debbieAge },
          inflationIndex,
          {
            robDeathAge: assumptions.robDeathAge,
            debbieDeathAge: assumptions.debbieDeathAge,
          },
        );
        const socialSecurityBreakdown = getSocialSecurityBreakdown(
          effectivePlan,
          { rob: robAge, debbie: debbieAge },
          inflationIndex,
          {
            robDeathAge: assumptions.robDeathAge,
            debbieDeathAge: assumptions.debbieDeathAge,
          },
        );
        const rmdResult = calculateRequiredMinimumDistribution({
          pretaxBalance: pretaxBalanceForRmd,
          sourceAccounts: buildPretaxRmdSourceAccounts(data, pretaxBalanceForRmd),
          members: [
            {
              owner: 'rob',
              birthDate: data.household.robBirthDate,
              age: robAge,
              accountShare: 0.5,
              startAgeOverride: data.rules.rmdPolicy?.startAgeOverride,
            },
            {
              owner: 'debbie',
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
              realized.cashInflow > 0 ||
              realized.ordinaryIncome > 0 ||
              realized.ltcgIncome > 0 ||
              realized.homeSaleGrossProceeds > 0,
          );
        let windfallCashInflow = 0;
        let windfallOrdinaryIncome = 0;
        let windfallLtcgIncome = 0;
        let homeSaleGrossProceeds = 0;
        let homeSaleSellingCosts = 0;
        let homeReplacementPurchaseCost = 0;
        let homeDownsizeNetLiquidity = 0;
        for (const entry of windfallRealizations) {
          windfallCashInflow += entry.realized.cashInflow;
          windfallOrdinaryIncome += entry.realized.ordinaryIncome;
          windfallLtcgIncome += entry.realized.ltcgIncome;
          homeSaleGrossProceeds += entry.realized.homeSaleGrossProceeds;
          homeSaleSellingCosts += entry.realized.homeSaleSellingCosts;
          homeReplacementPurchaseCost += entry.realized.homeReplacementPurchaseCost;
          homeDownsizeNetLiquidity += entry.realized.homeDownsizeNetLiquidity;
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
        const bucketReturns =
          marketPoint.bucketReturns ??
          Object.fromEntries(
            SIM_BUCKETS.map((bucket) => [
              bucket,
              getBucketReturn(
                effectivePlan.accounts[bucket].targetAllocation,
                assetReturns,
                effectivePlan.assetClassMappingAssumptions,
              ),
            ]),
          ) as Record<AccountBucketType, number>;
        marketPoint.bucketReturns = bucketReturns;
        SIM_BUCKETS.forEach((bucket) => {
          balances[bucket] *= 1 + bucketReturns[bucket];
        });
        if (data.accounts.hsa && hsaBalance > 0) {
          const hsaReturn = getBucketReturn(
            data.accounts.hsa.targetAllocation,
            assetReturns,
            effectivePlan.assetClassMappingAssumptions,
          );
          hsaBalance *= 1 + hsaReturn;
        }
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
          const { protectedHsaBalance, spendableBalances } = removeProtectedHsaFromPretax(
            balancesBeforeWithdrawal,
            hsaBalance,
          );
          const attemptBalances = { ...spendableBalances };
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
            endingBalances: restoreProtectedHsaToPretax(
              attemptBalances,
              protectedHsaBalance,
            ),
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
          yearOffset,
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
        let closedLoopOutputsStable = false;
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
            healthcareCost: healthcareForPass.totalHealthcarePremiumCost,
            ltcCost: ltcCostForYear,
          });
          const nextNeeded = Math.max(
            0,
            spendingBeforeHealthcare +
              healthcareForPass.totalHealthcarePremiumCost +
              attempt.result.taxResult.federalTax +
              ltcCostForYear -
              hsaOffsetForPass -
              baseIncome,
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
            const neededDelta = Math.abs(currentState.nextNeeded - closedLoopNeeded);
            closedLoopOutputsStable =
              closedLoopLastDeltas.magi <= convergenceThresholds.magiDeltaDollars &&
              closedLoopLastDeltas.federalTax <=
                convergenceThresholds.federalTaxDeltaDollars &&
              closedLoopLastDeltas.healthcarePremium <=
                convergenceThresholds.healthcarePremiumDeltaDollars;
            const converged =
              closedLoopOutputsStable && neededDelta <= 1;
            if (converged) {
              closedLoopConverged = true;
              closedLoopStopReason = 'converged_thresholds_met';
              break;
            }
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
            closedLoopOutputsStable
              ? nextNeeded
              : closedLoopNeeded + dampingFactor * (nextNeeded - closedLoopNeeded);
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
            healthcareCost: fallbackHealthcare.totalHealthcarePremiumCost,
            ltcCost: ltcCostForYear,
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
              spendingBeforeHealthcare +
                fallbackHealthcare.totalHealthcarePremiumCost +
                fallback.result.taxResult.federalTax +
                ltcCostForYear -
                fallbackHsaOffset -
                baseIncome,
            ),
          } satisfies ClosedLoopIterationState;
        })();

        const withdrawalResult = resolvedClosedLoopState.attempt;
        const {
          protectedHsaBalance: protectedHsaBalanceForConversion,
          spendableBalances: conversionBalances,
        } = removeProtectedHsaFromPretax(resolvedClosedLoopState.endingBalances, hsaBalance);
        const rothConversionTrace = strategyBehavior.plannerLogicActive
          ? applyProactiveRothConversion({
              year,
              balances: conversionBalances,
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
              balances: conversionBalances,
              withdrawalResult,
              strategy: strategyBehavior,
            });
        const balancesAfterConversion = restoreProtectedHsaToPretax(
          conversionBalances,
          protectedHsaBalanceForConversion,
        );
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
          healthcareCost: healthcarePremiums.totalHealthcarePremiumCost,
          ltcCost: ltcCostForYear,
        });
        let hsaLtcOffsetUsed = Math.min(hsaOffsetUsed, ltcCostForYear);
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

        balances.pretax = balancesAfterConversion.pretax;
        balances.roth = balancesAfterConversion.roth;
        balances.taxable = balancesAfterConversion.taxable;
        balances.cash = balancesAfterConversion.cash;
        if (hsaOffsetUsed > 0) {
          const appliedOffset = Math.min(hsaOffsetUsed, hsaBalance);
          hsaBalance = Math.max(0, hsaBalance - appliedOffset);
          hsaOffsetUsed = appliedOffset;
          hsaLtcOffsetUsed = Math.min(hsaOffsetUsed, ltcCostForYear);
        }
        const ltcCostRemainingAfterHsa = Math.max(0, ltcCostForYear - hsaLtcOffsetUsed);

        let federalTaxForYear = withdrawalResult.taxResult.federalTax;
        let spending =
          spendingBeforeHealthcare +
          healthcarePremiums.totalHealthcarePremiumCost +
          ltcCostForYear -
          hsaOffsetUsed;
        const calculateWithdrawalTotalForYear = () =>
          withdrawalResult.withdrawals.cash +
          withdrawalResult.withdrawals.taxable +
          withdrawalResult.withdrawals.pretax +
          withdrawalResult.withdrawals.roth;
        const calculateWithdrawalAppliedToCashflow = () =>
          Math.max(0, calculateWithdrawalTotalForYear() - withdrawalResult.rmdSurplusToCash);
        const calculateUnresolvedCashflowGap = () =>
          Math.max(
            0,
            spending + federalTaxForYear - baseIncome - calculateWithdrawalAppliedToCashflow(),
          );
        const refreshTaxAndHealthcareAfterSupplementalWithdrawal = () => {
          withdrawalResult.taxResult = calculateFederalTax(withdrawalResult.taxInputs);
          federalTaxForYear = withdrawalResult.taxResult.federalTax;
          magiForYear = withdrawalResult.taxResult.MAGI;
          irmaaReferenceMagi =
            magiHistory.get(year - DEFAULT_IRMAA_CONFIG.lookbackYears) ?? magiForYear;
          irmaaTier = calculateIrmaaTier(irmaaReferenceMagi, data.household.filingStatus);
          healthcarePremiums = calculateHealthcarePremiums({
            ...baseHealthcareInputs,
            MAGI: magiForYear,
            irmaaSurchargeAnnualPerEligible: irmaaTier.surchargeAnnual,
          });
          spending =
            spendingBeforeHealthcare +
            healthcarePremiums.totalHealthcarePremiumCost +
            ltcCostForYear -
            hsaOffsetUsed;
        };
        for (let supplementalPass = 0; supplementalPass < 12; supplementalPass += 1) {
          let supplementalNeed = calculateUnresolvedCashflowGap();
          if (supplementalNeed < MIN_FAILURE_SHORTFALL_DOLLARS) {
            break;
          }
          let fundedThisPass = 0;
          for (const bucket of ['cash', 'taxable', 'roth', 'pretax'] as AccountBucketType[]) {
            if (supplementalNeed <= 0) {
              break;
            }
            const take = Math.min(Math.max(0, balances[bucket]), supplementalNeed);
            if (take <= 0) {
              continue;
            }
            balances[bucket] -= take;
            withdrawalResult.withdrawals[bucket] += take;
            supplementalNeed -= take;
            fundedThisPass += take;
            if (bucket === 'taxable') {
              withdrawalResult.taxInputs.realizedLTCG +=
                take * DEFAULT_TAXABLE_WITHDRAWAL_LTCG_RATIO;
              refreshTaxAndHealthcareAfterSupplementalWithdrawal();
            } else if (bucket === 'pretax') {
              withdrawalResult.taxInputs.ira401kWithdrawals += take;
              refreshTaxAndHealthcareAfterSupplementalWithdrawal();
            } else if (bucket === 'roth') {
              withdrawalResult.taxInputs.rothWithdrawals += take;
            }
          }
          if (fundedThisPass <= 0) {
            break;
          }
        }
        magiHistory.set(year, magiForYear);
        const withdrawalTotal = calculateWithdrawalTotalForYear();
        const totalCashOutflow = spending + federalTaxForYear;
        const withdrawalAppliedToCashflow = calculateWithdrawalAppliedToCashflow();
        const cashflowSurplus = Math.max(
          0,
          baseIncome + withdrawalAppliedToCashflow - totalCashOutflow,
        );
        if (cashflowSurplus > 0) {
          balances.cash += cashflowSurplus;
        }
        const rawUnresolvedCashflowGap = calculateUnresolvedCashflowGap();
        const unresolvedWithdrawalNeed =
          rawUnresolvedCashflowGap >= MIN_FAILURE_SHORTFALL_DOLLARS
            ? rawUnresolvedCashflowGap
            : 0;
        marketPoint.cashflow = {
          adjustedWages,
          spendingCutActive: optionalCutActive,
          spendingCutTriggered: spendingCutTriggeredThisYear,
          employee401kContribution: contributionResult.employee401kContribution,
          employerMatchContribution: contributionResult.employerMatchContribution,
          hsaContribution: contributionResult.hsaContribution,
          rothContributionFlow: rothContributionFlowForYear,
          socialSecurityIncome,
          windfallCashInflow,
          homeSaleGrossProceeds,
          homeSaleSellingCosts,
          homeReplacementPurchaseCost,
          homeDownsizeNetLiquidity,
          spendingBeforeHealthcare,
          healthcarePremiumCost: healthcarePremiums.totalHealthcarePremiumCost,
          ltcCost: ltcCostForYear,
          hsaOffsetUsed,
          hsaLtcOffsetUsed,
          ltcCostRemainingAfterHsa,
          hsaBalanceEnd: hsaBalance,
          federalTax: federalTaxForYear,
          irmaaTier: irmaaTier.tier,
          rmdWithdrawn: withdrawalResult.rmdWithdrawn,
          rmdSurplusToCash: withdrawalResult.rmdSurplusToCash,
          withdrawalCash: withdrawalResult.withdrawals.cash,
          withdrawalTaxable: withdrawalResult.withdrawals.taxable,
          withdrawalPretax: withdrawalResult.withdrawals.pretax,
          withdrawalRoth: withdrawalResult.withdrawals.roth,
          remainingWithdrawalNeed: unresolvedWithdrawalNeed,
          rothConversion: rothConversionTrace.amount,
          totalSpending: spending,
          totalIncome: baseIncome + withdrawalResult.rmdWithdrawn,
        };
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

        const endingAssets = sumBalancesWithHsa(balances, hsaBalance);
        const summaryTrace = {
          year,
          totalAssets: roundSeriesValue(endingAssets),
          spending: roundSeriesValue(spending),
          federalTax: roundSeriesValue(federalTaxForYear),
          totalCashOutflow: roundSeriesValue(totalCashOutflow),
        };
        if (!summaryYearlyBuckets.has(year)) {
          summaryYearlyBuckets.set(year, []);
        }
        summaryYearlyBuckets.get(year)?.push(summaryTrace);
        yearlyReference.push({
          ...summaryTrace,
          pretaxBalanceEnd: roundSeriesValue(balances.pretax),
          taxableBalanceEnd: roundSeriesValue(balances.taxable),
          rothBalanceEnd: roundSeriesValue(balances.roth),
          cashBalanceEnd: roundSeriesValue(balances.cash),
          income: roundSeriesValue(income),
        });

        if (!summaryOnly) {
          yearly.push({
          year,
          totalAssets: summaryTrace.totalAssets,
          pretaxBalanceEnd: roundSeriesValue(balances.pretax),
          taxableBalanceEnd: roundSeriesValue(balances.taxable),
	          cashBalanceEnd: roundSeriesValue(balances.cash),
	          income: roundSeriesValue(income),
	          socialSecurityIncome: roundSeriesValue(socialSecurityBreakdown.householdAnnual),
	          socialSecurityRob: roundSeriesValue(socialSecurityBreakdown.robAnnual),
	          socialSecurityDebbie: roundSeriesValue(socialSecurityBreakdown.debbieAnnual),
	          socialSecurityInflationIndex: socialSecurityBreakdown.inflationIndex,
	          robSocialSecurityClaimFactor: socialSecurityBreakdown.robClaimFactor,
	          debbieSocialSecurityClaimFactor: socialSecurityBreakdown.debbieClaimFactor,
	          robSocialSecuritySpousalFloorMonthly: roundSeriesValue(
	            socialSecurityBreakdown.robSpousalFloorMonthly,
	          ),
	          debbieSocialSecuritySpousalFloorMonthly: roundSeriesValue(
	            socialSecurityBreakdown.debbieSpousalFloorMonthly,
	          ),
	          spending: summaryTrace.spending,
	          federalTax: summaryTrace.federalTax,
	          totalCashOutflow: roundSeriesValue(totalCashOutflow),
	          withdrawalTotal: roundSeriesValue(withdrawalTotal),
	          unresolvedFundingGap: roundSeriesValue(unresolvedWithdrawalNeed),
	          rmdAmount: roundSeriesValue(withdrawalResult.rmdWithdrawn),
          withdrawalCash: roundSeriesValue(withdrawalResult.withdrawals.cash),
          withdrawalTaxable: roundSeriesValue(withdrawalResult.withdrawals.taxable),
          withdrawalIra401k: roundSeriesValue(withdrawalResult.withdrawals.pretax),
	          withdrawalRoth: roundSeriesValue(withdrawalResult.withdrawals.roth),
	          rothConversion: roundSeriesValue(rothConversionTrace.amount),
	          rothConversionReason: rothConversionTrace.reason,
	          rothConversionMotive: rothConversionTrace.motive,
	          rothConversionKind: rothConversionTrace.conversionKind,
	          rothConversionOpportunisticAmount: roundSeriesValue(
	            rothConversionTrace.opportunisticAmount,
	          ),
	          rothConversionDefensiveAmount: roundSeriesValue(
	            rothConversionTrace.defensiveAmount,
	          ),
	          rothConversionSafeRoomAvailable: roundSeriesValue(
	            rothConversionTrace.safeRoomAvailable,
	          ),
	          rothConversionSafeRoomUsed: roundSeriesValue(rothConversionTrace.safeRoomUsed),
	          rothConversionStrategicExtraAvailable: roundSeriesValue(
	            rothConversionTrace.strategicExtraAvailable,
	          ),
	          rothConversionStrategicExtraUsed: roundSeriesValue(
	            rothConversionTrace.strategicExtraUsed,
	          ),
	          rothConversionAnnualPolicyMax:
	            rothConversionTrace.annualPolicyMax === null
	              ? null
	              : roundSeriesValue(rothConversionTrace.annualPolicyMax),
	          rothConversionAnnualPolicyMaxBinding:
	            rothConversionTrace.annualPolicyMaxBinding,
	          rothConversionSafeRoomUnusedDueToAnnualPolicyMax: roundSeriesValue(
	            rothConversionTrace.safeRoomUnusedDueToAnnualPolicyMax,
	          ),
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
          homeSaleGrossProceeds: roundSeriesValue(homeSaleGrossProceeds),
          homeSaleSellingCosts: roundSeriesValue(homeSaleSellingCosts),
          homeReplacementPurchaseCost: roundSeriesValue(homeReplacementPurchaseCost),
          homeDownsizeNetLiquidity: roundSeriesValue(homeDownsizeNetLiquidity),
          hsaOffsetUsed: roundSeriesValue(hsaOffsetUsed),
          hsaLtcOffsetUsed: roundSeriesValue(hsaLtcOffsetUsed),
          ltcCostRemainingAfterHsa: roundSeriesValue(ltcCostRemainingAfterHsa),
          hsaBalanceEnd: roundSeriesValue(hsaBalance),
          ltcCost: roundSeriesValue(ltcCostForYear),
          ltcEventOccurs,
          ltcEventActive: ltcCostForYear > 0,
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
            pretaxBalanceAfterContributionsForYear,
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
        }

        if (unresolvedWithdrawalNeed > 0 || endingAssets <= 0) {
          failureYear = year;
          failureShortfallAmount = Math.max(0, unresolvedWithdrawalNeed);
          downsideSpendingCutRequired =
            spending > 0 ? Math.max(0, Math.min(1, failureShortfallAmount / spending)) : 0;
          failureReason =
            spending <=
            effectivePlan.essentialAnnual * inflationIndex +
              taxesInsuranceAnnualForYear * inflationIndex +
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

      if (randomTape?.mode === 'record') {
        const endingWealth = sumBalancesWithHsa(balances, hsaBalance);
        recordedTapeTrials.push({
          trialIndex,
          trialSeed,
          ltcEventOccurs,
          marketPath: marketPath.map((point, yearOffset) =>
            toRandomTapeMarketYear(
              point,
              effectivePlan.startYear + yearOffset,
              yearOffset,
            ),
          ),
          reference: {
            success: failureYear === null,
            failureYear,
            endingWealth,
            spendingCutsTriggered,
            irmaaTriggered,
            homeSaleDependent,
            inheritanceDependent,
            rothDepletedEarly,
            yearly: yearlyReference.map((trace) => ({
              year: trace.year,
              totalAssets: trace.totalAssets,
              pretaxBalanceEnd: trace.pretaxBalanceEnd,
              taxableBalanceEnd: trace.taxableBalanceEnd,
              rothBalanceEnd: trace.rothBalanceEnd,
              cashBalanceEnd: trace.cashBalanceEnd,
              spending: trace.spending,
              income: trace.income,
              federalTax: trace.federalTax,
            })),
          },
        });
      }

      return {
        success: failureYear === null,
        failureYear,
        endingWealth: sumBalancesWithHsa(balances, hsaBalance),
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
        ltcEventOccurs,
        totalLtcCost: roundSeriesValue(
          yearly.reduce((total, trace) => total + trace.ltcCost, 0),
        ),
        totalHsaOffsetUsed: roundSeriesValue(
          yearly.reduce((total, trace) => total + trace.hsaOffsetUsed, 0),
        ),
        totalHsaLtcOffsetUsed: roundSeriesValue(
          yearly.reduce((total, trace) => total + trace.hsaLtcOffsetUsed, 0),
        ),
        totalLtcCostRemainingAfterHsa: roundSeriesValue(
          yearly.reduce((total, trace) => total + trace.ltcCostRemainingAfterHsa, 0),
        ),
        ltcCostYears: yearly.filter((trace) => trace.ltcCost > 0).length,
        yearly: summaryOnly ? [] : yearly,
      };
    },
  });

  if (randomTape?.mode === 'record') {
    randomTape.onRecord?.({
      schemaVersion: RANDOM_TAPE_SCHEMA_VERSION,
      generatedBy: 'typescript',
      createdAtIso: new Date().toISOString(),
      label: randomTape.label ?? 'selected-path',
      simulationMode,
      seed: simulationSeed,
      trialCount: runCount,
      planningHorizonYears,
      assumptionsVersion,
      samplingStrategy: assumptions.samplingStrategy ?? 'mc',
      returnModel: {
        useHistoricalBootstrap: assumptions.useHistoricalBootstrap ?? false,
        historicalBootstrapBlockLength: assumptions.historicalBootstrapBlockLength ?? 1,
        useCorrelatedReturns: assumptions.useCorrelatedReturns ?? false,
        equityTailMode: assumptions.equityTailMode ?? 'normal',
      },
      trials: recordedTapeTrials.sort((left, right) => left.trialIndex - right.trialIndex),
    });
  }

  const runs = monteCarlo.runs;
  const failedRuns = runs.filter((result) => !result.success);
  const failureYears = failedRuns
    .map((result) => result.failureYear)
    .filter((year): year is number => year !== null);

  const yearlySeries = summaryOnly
    ? [...summaryYearlyBuckets.entries()].map(([year, traces]) =>
        summaryOnlyPathYearResult({
          year,
          medianAssets: median(traces.map((trace) => trace.totalAssets)),
          tenthPercentileAssets: percentile(
            traces.map((trace) => trace.totalAssets),
            0.1,
          ),
          medianSpending: median(traces.map((trace) => trace.spending)),
          medianFederalTax: median(traces.map((trace) => trace.federalTax)),
          medianTotalCashOutflow:
            median(traces.map((trace) => trace.spending)) +
            median(traces.map((trace) => trace.federalTax)),
	        }),
      )
    : [...yearlyBuckets.entries()].map(([year, traces]) => ({
        year,
        medianAssets: median(traces.map((trace) => trace.totalAssets)),
        medianPretaxBalance: median(traces.map((trace) => trace.pretaxBalanceEnd)),
        medianTaxableBalance: median(traces.map((trace) => trace.taxableBalanceEnd)),
        medianRothBalance: median(traces.map((trace) => trace.rothBalanceEnd)),
        medianCashBalance: median(traces.map((trace) => trace.cashBalanceEnd)),
        tenthPercentileAssets: percentile(
          traces.map((trace) => trace.totalAssets),
          0.1,
	        ),
	        medianIncome: median(traces.map((trace) => trace.income)),
	        medianSocialSecurityIncome: median(traces.map((trace) => trace.socialSecurityIncome)),
	        medianSocialSecurityRob: median(traces.map((trace) => trace.socialSecurityRob)),
	        medianSocialSecurityDebbie: median(traces.map((trace) => trace.socialSecurityDebbie)),
	        medianSocialSecurityInflationIndex: median(
	          traces.map((trace) => trace.socialSecurityInflationIndex),
	        ),
	        robSocialSecurityClaimFactor: median(
	          traces.map((trace) => trace.robSocialSecurityClaimFactor),
	        ),
	        debbieSocialSecurityClaimFactor: median(
	          traces.map((trace) => trace.debbieSocialSecurityClaimFactor),
	        ),
	        robSocialSecuritySpousalFloorMonthly: median(
	          traces.map((trace) => trace.robSocialSecuritySpousalFloorMonthly),
	        ),
	        debbieSocialSecuritySpousalFloorMonthly: median(
	          traces.map((trace) => trace.debbieSocialSecuritySpousalFloorMonthly),
	        ),
        medianSpending: median(traces.map((trace) => trace.spending)),
        medianFederalTax: median(traces.map((trace) => trace.federalTax)),
        medianTotalCashOutflow:
          median(traces.map((trace) => trace.spending)) +
          median(traces.map((trace) => trace.federalTax)),
        medianWithdrawalTotal:
          median(traces.map((trace) => trace.withdrawalCash)) +
          median(traces.map((trace) => trace.withdrawalTaxable)) +
          median(traces.map((trace) => trace.withdrawalIra401k)) +
          median(traces.map((trace) => trace.withdrawalRoth)),
	        medianUnresolvedFundingGap: median(traces.map((trace) => trace.unresolvedFundingGap)),
	        medianRmdAmount: median(traces.map((trace) => trace.rmdAmount)),
        medianWithdrawalCash: median(traces.map((trace) => trace.withdrawalCash)),
        medianWithdrawalTaxable: median(traces.map((trace) => trace.withdrawalTaxable)),
        medianWithdrawalIra401k: median(traces.map((trace) => trace.withdrawalIra401k)),
        medianWithdrawalRoth: median(traces.map((trace) => trace.withdrawalRoth)),
        medianRothConversion: median(traces.map((trace) => trace.rothConversion)),
        dominantRothConversionReason: dominantValue(
          traces.map((trace) => trace.rothConversionReason),
        ),
        dominantRothConversionMotive: dominantValue(
          traces.map((trace) => trace.rothConversionMotive),
          'none',
        ),
        medianRothConversionOpportunistic: median(
          traces.map((trace) => trace.rothConversionOpportunisticAmount),
        ),
        medianRothConversionDefensive: median(
          traces.map((trace) => trace.rothConversionDefensiveAmount),
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
        medianHomeSaleGrossProceeds: median(
          traces.map((trace) => trace.homeSaleGrossProceeds),
        ),
        medianHomeSaleSellingCosts: median(
          traces.map((trace) => trace.homeSaleSellingCosts),
        ),
        medianHomeReplacementPurchaseCost: median(
          traces.map((trace) => trace.homeReplacementPurchaseCost),
        ),
        medianHomeDownsizeNetLiquidity: median(
          traces.map((trace) => trace.homeDownsizeNetLiquidity),
        ),
        medianHsaOffsetUsed: median(traces.map((trace) => trace.hsaOffsetUsed)),
        medianHsaLtcOffsetUsed: median(traces.map((trace) => trace.hsaLtcOffsetUsed)),
        medianLtcCostRemainingAfterHsa: median(
          traces.map((trace) => trace.ltcCostRemainingAfterHsa),
        ),
        medianHsaBalance: median(traces.map((trace) => trace.hsaBalanceEnd)),
        medianLtcCost: median(traces.map((trace) => trace.ltcCost)),
        ltcHsaPathVisibility: buildLtcHsaPathVisibilityFromTraces(traces),
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
        cashflowReconciliation: buildCashflowReconciliationFromTraces(traces),
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
  const simulationDiagnostics = summaryOnly
    ? emptySimulationModeDiagnostics(yearlySeries, monteCarlo.failureYearDistribution)
    : buildSimulationModeDiagnostics({
        yearlySeries,
        failureYearDistribution: monteCarlo.failureYearDistribution,
        runs,
      });
  const ltcHsaDiagnostics = buildLtcHsaDiagnostics({
    plan: effectivePlan,
    ages,
    planningHorizonYears,
    initialHsaBalance: data.accounts.hsa?.balance ?? 0,
    yearlySeries,
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
    ltcHsaDiagnostics,
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
    ltcHsaDiagnostics: summary.ltcHsaDiagnostics,
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
      randomTape: options?.randomTape,
      outputLevel: options?.outputLevel,
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
      withdrawalRule: 'tax_bracket_waterfall',
    },
  );
}
