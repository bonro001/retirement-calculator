import {
  deriveAssetClassMappingAssumptionsFromAccounts,
  getAssetClassMappingMetadata,
} from './asset-class-mapper';
import {
  calculatePreRetirementContributions,
  deriveAnnual401kTargets,
  deriveAnnualHsaTarget,
} from './contribution-engine';
import type { PlanEvaluation } from './plan-evaluation';
import { getRmdStartAgeForBirthYear } from './retirement-rules';
import type {
  MarketAssumptions,
  PathResult,
  PreRetirementContributionSettings,
  SeedData,
} from './types';
import { buildPathResults } from './utils';
import { calculateRunwayGapMetrics } from './runway-utils';

const CURRENT_DATE = new Date('2026-04-16T12:00:00Z');
const CURRENT_YEAR = CURRENT_DATE.getUTCFullYear();
const DEFAULT_PLAYBOOK_SIMULATION_RUNS = 48;
const SENSITIVITY_SIGN_TOLERANCE = 0.08;
const SENSITIVITY_SPEND_FLOOR = 40;
const CASH_SYMBOL = 'CASH';
const ACA_GUARDRAIL_BUFFER_DOLLARS = 5_000;
const RUNWAY_TARGET_MONTHS = 18;
const RUNWAY_GAP_MONTHS_FOR_PRIORITY_SHIFT = 6;
const DEFAULT_PAYROLL_RUNWAY_ESTIMATED_TAKE_HOME_FACTOR = 0.72;
const ROTH_CONCENTRATION_SYMBOL = 'FCNTX';
const ROTH_CONCENTRATION_WATCH_SHARE = 0.5;
const ROTH_CONCENTRATION_NOW_SHARE = 0.75;
const ROTH_CONCENTRATION_SPLIT_TO_VTI = 0.75;
const ROTH_CONCENTRATION_SPLIT_TO_VXUS = 0.25;

export type PlaybookPriority = 'now' | 'soon' | 'watch';
export type PlaybookPhaseId =
  | 'pre_retirement'
  | 'aca_bridge'
  | 'medicare_irmaa'
  | 'pre_rmd'
  | 'rmd_phase';
export type PlaybookPhaseStatus = 'active' | 'upcoming' | 'completed';
export type PortfolioBucket = 'pretax' | 'roth' | 'taxable' | 'cash' | 'hsa';
export type PlaybookModelCompleteness = 'faithful' | 'reconstructed';
export type AcaSubsidyRiskBand = 'green' | 'yellow' | 'red' | 'unknown';
export type AcaBridgeStatus = 'safe' | 'watch' | 'mitigated' | 'breach' | 'unknown';
export type RetirementFlowRegime = 'standard' | 'aca_bridge' | 'unknown';

export interface FlightPathTradeInstruction {
  accountBucket: PortfolioBucket;
  sourceAccountId: string | null;
  sourceAccountName: string;
  fromSymbol: string;
  toSymbol: string;
  percentOfHolding: number;
  dollarAmount: number;
  estimatedFromTargetAllocation: boolean;
}

export interface FlightPathActionImpactEstimate {
  supportedMonthlyDelta: number;
  successRateDelta: number;
  medianEndingWealthDelta: number;
  annualFederalTaxDelta: number;
  yearsFundedDelta: number;
  earlyFailureProbabilityDelta: number;
  worstDecileEndingWealthDelta: number;
  spendingCutRateDelta: number;
  equitySalesInAdverseEarlyYearsRateDelta: number;
}

export interface FlightPathActionSensitivityScenario {
  name: 'base' | 'adverse_macro' | 'benign_macro';
  supportedMonthlyDelta: number;
  successRateDelta: number;
  directionConsistent: boolean;
}

export interface FlightPathActionSensitivity {
  baseSeed: number;
  simulationRunsPerScenario: number;
  directionConsistencyScore: number;
  scenarios: FlightPathActionSensitivityScenario[];
}

export interface FlightPathActionLaymanExpansion {
  templateVersion: 'layman_v1';
  cacheKey: string;
  storyHook: string;
  plainEnglishTask: string;
  whyImportant: string;
  walkthroughSteps: string[];
  watchOuts: string[];
}

export interface FlightPathContributionSettingsPatch {
  employee401kPreTaxAnnualAmount?: number;
  employee401kRothAnnualAmount?: number;
  hsaAnnualAmount?: number;
}

export interface FlightPathAcaMetrics {
  bridgeYear: number | null;
  projectedMagi: number;
  acaFriendlyMagiCeiling: number | null;
  headroomToCeiling: number | null;
  requiredMagiReduction: number;
  guardrailBufferDollars: number;
  targetMagiCeilingWithBuffer: number | null;
  requiredMagiReductionWithBuffer: number;
  unmitigatedProjectedMagi: number;
  unmitigatedRequiredMagiReduction: number;
  acaMitigationDelta: number;
  acaStatus: AcaBridgeStatus;
  estimatedAcaPremiumAtRisk: number;
  subsidyRiskBand: AcaSubsidyRiskBand;
  modelCompleteness: PlaybookModelCompleteness;
  inferredAssumptions: string[];
  intermediateCalculations: Record<string, number | string>;
}

export interface FlightPathRetirementFlowYear {
  year: number;
  monthsInRetirement: number;
  regime: RetirementFlowRegime;
  taxableFlow: number;
  rothFlow: number;
  iraFlow: number;
  cashFlow: number;
  rmdFlow: number;
  salaryIncome: number;
  socialSecurityIncome: number;
  windfallIncome: number;
  totalIncome: number;
  expectedMagi: number;
  acaFriendlyMagiCeiling: number | null;
  acaHeadroomToCeiling: number | null;
  irmaaStatus: string;
  irmaaHeadroom: number | null;
  irmaaLookbackTaxYear: number | null;
  modelCompleteness: PlaybookModelCompleteness;
  inferredAssumptions: string[];
  intermediateCalculations: Record<string, number | string>;
}

export interface FlightPathPhaseAction {
  id: string;
  phaseId: PlaybookPhaseId;
  title: string;
  priority: PlaybookPriority;
  rankWithinPhase: number;
  rankScore: number;
  isTopRecommendation: boolean;
  objective: string;
  whyNow: string;
  tradeInstructions: FlightPathTradeInstruction[];
  contributionSettingsPatch: FlightPathContributionSettingsPatch | null;
  fullGoalDollars: number;
  estimatedImpact: FlightPathActionImpactEstimate;
  sensitivity: FlightPathActionSensitivity;
  laymanExpansion: FlightPathActionLaymanExpansion;
  modelCompleteness: PlaybookModelCompleteness;
  inferredAssumptions: string[];
  intermediateCalculations: Record<string, number | string>;
}

export interface FlightPathPhasePlaybookSection {
  id: PlaybookPhaseId;
  label: string;
  windowStartYear: number;
  windowEndYear: number;
  status: PlaybookPhaseStatus;
  objective: string;
  acaMetrics?: FlightPathAcaMetrics;
  actions: FlightPathPhaseAction[];
}

export interface FlightPathPhasePlaybookDiagnostics {
  scenarioRuns: number;
  simulationSeed: number;
  acaGuardrailAdjustment: {
    mode: 'normal' | 'watch' | 'recovery' | 'unknown';
    active: boolean;
    subsidyRiskBand: AcaSubsidyRiskBand;
    requiredMagiReduction: number;
    prioritizedPhaseIds: PlaybookPhaseId[];
    acaBridgeScoreBoost: number;
    priorityDriver: 'aca_bridge_first' | 'runway_first';
    runwayGapMonths: number;
    yearsUntilBridge: number | null;
  };
  inferredAssumptions: string[];
}

export interface FlightPathPhasePlaybook {
  phases: FlightPathPhasePlaybookSection[];
  retirementFlowYears: FlightPathRetirementFlowYear[];
  diagnostics: FlightPathPhasePlaybookDiagnostics;
}

export interface FlightPathPhasePlaybookInput {
  evaluation: PlanEvaluation | null;
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressors: string[];
  selectedResponses: string[];
  nowYear?: number;
  executedSimulationOutcome?: PathResult | null;
  unmitigatedSimulationOutcome?: PathResult | null;
}

interface HoldingPosition {
  accountBucket: PortfolioBucket;
  sourceAccountId: string | null;
  sourceAccountName: string;
  symbol: string;
  value: number;
  estimatedFromTargetAllocation: boolean;
}

interface PhaseDefinition {
  id: PlaybookPhaseId;
  label: string;
  objective: string;
  windowStartYear: number;
  windowEndYear: number;
  status: PlaybookPhaseStatus;
}

interface ActionDraft {
  id: string;
  phaseId: PlaybookPhaseId;
  title: string;
  priority: PlaybookPriority;
  objective: string;
  whyNow: string;
  tradeInstructions: FlightPathTradeInstruction[];
  contributionSettingsPatch?: FlightPathContributionSettingsPatch | null;
  fullGoalDollars: number;
  inferredAssumptions: string[];
  intermediateCalculations: Record<string, number | string>;
}

interface ScenarioProfile {
  name: FlightPathActionSensitivityScenario['name'];
  assumptions: MarketAssumptions;
}

interface AcaBridgeYearSummary {
  year: number;
  regime: string;
  estimatedMAGI: number;
  acaFriendlyMagiCeiling: number | null;
}

interface AcaPathYearSummary {
  year: number;
  medianMagi: number;
  medianRothConversion: number;
}

interface RetirementFlowSourceYear {
  year: number;
  regime: string;
  withdrawalCash: number;
  withdrawalTaxable: number;
  withdrawalIra401k: number;
  withdrawalRoth: number;
  estimatedMAGI: number;
  rmdAmount: number;
  acaFriendlyMagiCeiling: number | null;
  irmaaStatus: string;
  irmaaHeadroom: number | null;
  robAge: number;
  debbieAge: number;
}

const roundMoney = (value: number) => Number(value.toFixed(2));
const roundPercent = (value: number) => Number(value.toFixed(2));

function resolvePayrollTakeHomeFactor(data: SeedData) {
  const configured = data.rules.payrollModel?.takeHomeFactor;
  if (typeof configured !== 'number' || !Number.isFinite(configured)) {
    return DEFAULT_PAYROLL_RUNWAY_ESTIMATED_TAKE_HOME_FACTOR;
  }
  return clamp(configured, 0.3, 0.95);
}

function formatMoneyLabel(value: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(roundMoney(value));
}

function formatSignedMoneyLabel(value: number) {
  const rounded = roundMoney(value);
  const sign = rounded >= 0 ? '+' : '-';
  return `${sign}${formatMoneyLabel(Math.abs(rounded))}`;
}

function formatSignedPointsLabel(value: number) {
  const points = value * 100;
  const sign = points >= 0 ? '+' : '-';
  return `${sign}${Math.abs(points).toFixed(1)} pts`;
}

function portfolioBucketLabel(bucket: PortfolioBucket) {
  if (bucket === 'pretax') {
    return 'pre-tax';
  }
  if (bucket === 'roth') {
    return 'Roth';
  }
  if (bucket === 'taxable') {
    return 'taxable';
  }
  if (bucket === 'hsa') {
    return 'HSA';
  }
  return 'cash';
}

function joinReadableList(values: string[]) {
  if (!values.length) {
    return '';
  }
  if (values.length === 1) {
    return values[0];
  }
  if (values.length === 2) {
    return `${values[0]} and ${values[1]}`;
  }
  return `${values.slice(0, -1).join(', ')}, and ${values[values.length - 1]}`;
}

function priorityBoost(priority: PlaybookPriority) {
  if (priority === 'now') {
    return 0.55;
  }
  if (priority === 'soon') {
    return 0.3;
  }
  return 0.1;
}

function parseYear(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.getUTCFullYear();
}

function parseDateSafe(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function normalizeAllocation(allocation: Record<string, number>) {
  const entries = Object.entries(allocation).map(([symbol, weight]) => [
    symbol.toUpperCase(),
    Math.max(0, weight),
  ]) as Array<[string, number]>;
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (total <= 0) {
    return { [CASH_SYMBOL]: 1 };
  }
  return Object.fromEntries(entries.map(([symbol, weight]) => [symbol, weight / total]));
}

function cloneSeedData(data: SeedData): SeedData {
  return structuredClone(data) as SeedData;
}

function firstYearSupportedMonthly(path: PathResult) {
  return (path.yearlySeries[0]?.medianSpending ?? 0) / 12;
}

function resolvePathRiskMetrics(path: PathResult) {
  return {
    earlyFailureProbability: path.riskMetrics?.earlyFailureProbability ?? 0,
    worstDecileEndingWealth:
      path.riskMetrics?.worstDecileEndingWealth ?? path.tenthPercentileEndingWealth ?? 0,
    equitySalesInAdverseEarlyYearsRate:
      path.riskMetrics?.equitySalesInAdverseEarlyYearsRate ?? 0,
  };
}

function directionWithTolerance(value: number) {
  if (value > SENSITIVITY_SIGN_TOLERANCE) {
    return 1;
  }
  if (value < -SENSITIVITY_SIGN_TOLERANCE) {
    return -1;
  }
  return 0;
}

function inferPhaseStatus(nowYear: number, windowStartYear: number, windowEndYear: number): PlaybookPhaseStatus {
  if (nowYear < windowStartYear) {
    return 'upcoming';
  }
  if (nowYear > windowEndYear) {
    return 'completed';
  }
  return 'active';
}

function resolvePortfolioBucketState(data: SeedData, bucket: PortfolioBucket) {
  if (bucket === 'hsa') {
    return data.accounts.hsa;
  }
  return data.accounts[bucket];
}

function collectPositionsForSymbol(input: {
  data: SeedData;
  symbol: string;
  buckets: PortfolioBucket[];
}) {
  const normalizedSymbol = input.symbol.toUpperCase();
  const positions: HoldingPosition[] = [];
  const inferredAssumptions: string[] = [];

  input.buckets.forEach((bucket) => {
    const bucketState = resolvePortfolioBucketState(input.data, bucket);
    if (!bucketState) {
      return;
    }
    const sourceAccounts = bucketState.sourceAccounts ?? [];
    sourceAccounts.forEach((account) => {
      const holding = (account.holdings ?? []).find(
        (item) => item.symbol.toUpperCase() === normalizedSymbol,
      );
      if (!holding || !(holding.value > 0)) {
        return;
      }
      positions.push({
        accountBucket: bucket,
        sourceAccountId: account.id,
        sourceAccountName: account.name,
        symbol: normalizedSymbol,
        value: holding.value,
        estimatedFromTargetAllocation: false,
      });
    });

    const foundFromSource = positions.some((position) => position.accountBucket === bucket);
    if (foundFromSource) {
      return;
    }

    const targetWeight = bucketState.targetAllocation[normalizedSymbol];
    if (!(targetWeight > 0)) {
      return;
    }

    const estimatedValue = bucketState.balance * targetWeight;
    if (!(estimatedValue > 0)) {
      return;
    }

    inferredAssumptions.push(
      `Estimated ${normalizedSymbol} value in ${bucket} bucket from target allocation because source holdings were unavailable.`,
    );
    positions.push({
      accountBucket: bucket,
      sourceAccountId: null,
      sourceAccountName: `${bucket.toUpperCase()} bucket (estimated)`,
      symbol: normalizedSymbol,
      value: estimatedValue,
      estimatedFromTargetAllocation: true,
    });
  });

  return {
    positions,
    inferredAssumptions,
  };
}

function collectPositionsForLargestTaxableRiskSymbol(data: SeedData) {
  const taxable = data.accounts.taxable;
  const positions: HoldingPosition[] = [];
  const inferredAssumptions: string[] = [];
  const bySymbol = new Map<string, HoldingPosition[]>();

  const sourceAccounts = taxable.sourceAccounts ?? [];
  sourceAccounts.forEach((account) => {
    (account.holdings ?? []).forEach((holding) => {
      const symbol = holding.symbol.toUpperCase();
      if (!holding.value || symbol === CASH_SYMBOL || symbol === 'MUB') {
        return;
      }
      const next: HoldingPosition = {
        accountBucket: 'taxable',
        sourceAccountId: account.id,
        sourceAccountName: account.name,
        symbol,
        value: holding.value,
        estimatedFromTargetAllocation: false,
      };
      const current = bySymbol.get(symbol) ?? [];
      bySymbol.set(symbol, [...current, next]);
    });
  });

  if (!bySymbol.size) {
    const entries = Object.entries(taxable.targetAllocation).filter(
      ([symbol, weight]) =>
        symbol.toUpperCase() !== CASH_SYMBOL && symbol.toUpperCase() !== 'MUB' && weight > 0,
    );
    entries.forEach(([symbol, weight]) => {
      const normalized = symbol.toUpperCase();
      const estimatedValue = taxable.balance * weight;
      const current = bySymbol.get(normalized) ?? [];
      bySymbol.set(normalized, [
        ...current,
        {
          accountBucket: 'taxable',
          sourceAccountId: null,
          sourceAccountName: 'Taxable bucket (estimated)',
          symbol: normalized,
          value: estimatedValue,
          estimatedFromTargetAllocation: true,
        },
      ]);
      inferredAssumptions.push(
        `Estimated taxable ${normalized} value from target allocation because source holdings were unavailable.`,
      );
    });
  }

  const sorted = [...bySymbol.entries()]
    .map(([symbol, symbolPositions]) => ({
      symbol,
      positions: symbolPositions,
      totalValue: symbolPositions.reduce((sum, item) => sum + item.value, 0),
    }))
    .sort((left, right) => right.totalValue - left.totalValue);

  const top = sorted[0];
  if (!top) {
    return {
      symbol: null,
      positions,
      inferredAssumptions,
    };
  }

  return {
    symbol: top.symbol,
    positions: top.positions,
    inferredAssumptions,
  };
}

function buildTradeInstructionsFromPositions(input: {
  positions: HoldingPosition[];
  toSymbol: string;
  moveDollarsTotal: number;
}) {
  const totalValue = input.positions.reduce((sum, item) => sum + item.value, 0);
  if (!(totalValue > 0) || !(input.moveDollarsTotal > 0)) {
    return [];
  }

  const cappedMoveDollarsTotal = Math.min(totalValue, input.moveDollarsTotal);
  let assigned = 0;
  const instructions = input.positions.map((position, index) => {
    const isLast = index === input.positions.length - 1;
    const proportionalTarget = cappedMoveDollarsTotal * (position.value / totalValue);
    const rawMove = isLast ? cappedMoveDollarsTotal - assigned : proportionalTarget;
    const move = clamp(roundMoney(rawMove), 0, roundMoney(position.value));
    assigned += move;
    return {
      accountBucket: position.accountBucket,
      sourceAccountId: position.sourceAccountId,
      sourceAccountName: position.sourceAccountName,
      fromSymbol: position.symbol.toUpperCase(),
      toSymbol: input.toSymbol.toUpperCase(),
      percentOfHolding: roundPercent((move / Math.max(1, position.value)) * 100),
      dollarAmount: move,
      estimatedFromTargetAllocation: position.estimatedFromTargetAllocation,
    } satisfies FlightPathTradeInstruction;
  });

  return instructions.filter((item) => item.dollarAmount > 0);
}

function buildSplitTradeInstructionsFromPositions(input: {
  positions: HoldingPosition[];
  splitTargets: Array<{ toSymbol: string; weight: number }>;
  moveDollarsTotal: number;
}) {
  const normalizedTargets = input.splitTargets
    .map((target) => ({
      toSymbol: target.toSymbol.toUpperCase(),
      weight: Math.max(0, target.weight),
    }))
    .filter((target) => target.weight > 0);
  const totalWeight = normalizedTargets.reduce((sum, target) => sum + target.weight, 0);
  if (!(totalWeight > 0)) {
    return [];
  }
  return normalizedTargets.flatMap((target) =>
    buildTradeInstructionsFromPositions({
      positions: input.positions,
      toSymbol: target.toSymbol,
      moveDollarsTotal: input.moveDollarsTotal * (target.weight / totalWeight),
    }),
  );
}

function buildMoveSizeVariants(input: {
  baseMoveDollars: number;
  maxAvailableDollars: number;
  multipliers: number[];
}) {
  const variants = input.multipliers
    .map((multiplier) => roundMoney(input.baseMoveDollars * multiplier))
    .map((value) => clamp(value, 0, roundMoney(input.maxAvailableDollars)))
    .filter((value) => value > 0);
  return Array.from(new Set(variants));
}

function applyTradeInstructionsToData(data: SeedData, instructions: FlightPathTradeInstruction[]) {
  const next = cloneSeedData(data);

  instructions.forEach((instruction) => {
    const bucketState = resolvePortfolioBucketState(next, instruction.accountBucket);
    if (!bucketState || !(bucketState.balance > 0)) {
      return;
    }

    const normalizedFrom = instruction.fromSymbol.toUpperCase();
    const normalizedTo = instruction.toSymbol.toUpperCase();
    const allocation = { ...bucketState.targetAllocation };
    const fromWeight = allocation[normalizedFrom] ?? 0;
    if (!(fromWeight > 0)) {
      return;
    }
    const shiftWeight = clamp(instruction.dollarAmount / bucketState.balance, 0, fromWeight);
    allocation[normalizedFrom] = Math.max(0, fromWeight - shiftWeight);
    allocation[normalizedTo] = (allocation[normalizedTo] ?? 0) + shiftWeight;
    bucketState.targetAllocation = normalizeAllocation(allocation);

    if (!bucketState.sourceAccounts?.length) {
      return;
    }

    const sourceAccount = instruction.sourceAccountId
      ? bucketState.sourceAccounts.find((account) => account.id === instruction.sourceAccountId)
      : null;
    if (!sourceAccount?.holdings) {
      return;
    }
    const fromHolding = sourceAccount.holdings.find(
      (holding) => holding.symbol.toUpperCase() === normalizedFrom,
    );
    if (!fromHolding || !(fromHolding.value > 0)) {
      return;
    }
    const move = clamp(instruction.dollarAmount, 0, fromHolding.value);
    fromHolding.value = roundMoney(fromHolding.value - move);
    const toHolding =
      sourceAccount.holdings.find((holding) => holding.symbol.toUpperCase() === normalizedTo) ??
      (() => {
        const created = { symbol: normalizedTo, value: 0 };
        sourceAccount.holdings?.push(created);
        return created;
      })();
    toHolding.value = roundMoney(toHolding.value + move);
  });

  return next;
}

function applyContributionSettingsPatchToData(
  data: SeedData,
  patch: FlightPathContributionSettingsPatch | null | undefined,
) {
  if (!patch) {
    return cloneSeedData(data);
  }
  const next = cloneSeedData(data);
  const current = normalizeContributionSettings(next);
  next.income.preRetirementContributions = {
    ...(next.income.preRetirementContributions ?? {}),
    employee401kPreTaxAnnualAmount:
      patch.employee401kPreTaxAnnualAmount ?? current.employee401kPreTaxAnnualAmount,
    employee401kRothAnnualAmount:
      patch.employee401kRothAnnualAmount ?? current.employee401kRothAnnualAmount,
    hsaAnnualAmount: patch.hsaAnnualAmount ?? current.hsaAnnualAmount,
  };
  if (patch.employee401kPreTaxAnnualAmount !== undefined) {
    delete next.income.preRetirementContributions.employee401kPreTaxAnnualAmountByYear;
    delete next.income.preRetirementContributions.employee401kAnnualAmountByYear;
  }
  if (patch.employee401kRothAnnualAmount !== undefined) {
    delete next.income.preRetirementContributions.employee401kRothAnnualAmountByYear;
  }
  if (patch.hsaAnnualAmount !== undefined) {
    delete next.income.preRetirementContributions.hsaAnnualAmountByYear;
  }
  return next;
}

function resolvePlaybookAssumptionVariants(assumptions: MarketAssumptions): ScenarioProfile[] {
  const runCount = Math.max(
    24,
    Math.min(assumptions.simulationRuns, DEFAULT_PLAYBOOK_SIMULATION_RUNS),
  );
  return [
    {
      name: 'base',
      assumptions: {
        ...assumptions,
        simulationRuns: runCount,
        assumptionsVersion: assumptions.assumptionsVersion
          ? `${assumptions.assumptionsVersion}-phase-playbook-base`
          : 'phase-playbook-base',
      },
    },
    {
      name: 'adverse_macro',
      assumptions: {
        ...assumptions,
        simulationRuns: runCount,
        equityMean: assumptions.equityMean - 0.01,
        inflation: Math.max(-0.98, assumptions.inflation + 0.005),
        assumptionsVersion: assumptions.assumptionsVersion
          ? `${assumptions.assumptionsVersion}-phase-playbook-adverse`
          : 'phase-playbook-adverse',
      },
    },
    {
      name: 'benign_macro',
      assumptions: {
        ...assumptions,
        simulationRuns: runCount,
        equityMean: assumptions.equityMean + 0.005,
        inflation: Math.max(-0.98, assumptions.inflation - 0.003),
        assumptionsVersion: assumptions.assumptionsVersion
          ? `${assumptions.assumptionsVersion}-phase-playbook-benign`
          : 'phase-playbook-benign',
      },
    },
  ];
}

function socialSecurityBenefitFactor(claimAge: number) {
  if (claimAge < 67) {
    return Math.max(0.7, 1 - (67 - claimAge) * 0.06);
  }
  if (claimAge > 67) {
    return 1 + (claimAge - 67) * 0.08;
  }
  return 1;
}

function salaryIncomeForYear(data: SeedData, year: number) {
  const salaryEndDate = parseDateSafe(data.income.salaryEndDate);
  if (!salaryEndDate) {
    return {
      salaryIncome: 0,
      inferredAssumptions: [
        'income.salaryEndDate was invalid; salary contribution to yearly flow was assumed to be 0.',
      ],
    };
  }
  const salaryEndYear = salaryEndDate.getUTCFullYear();
  if (year < salaryEndYear) {
    return {
      salaryIncome: roundMoney(data.income.salaryAnnual),
      inferredAssumptions: [],
    };
  }
  if (year > salaryEndYear) {
    return {
      salaryIncome: 0,
      inferredAssumptions: [],
    };
  }
  const salaryProrationRule = data.rules.payrollModel?.salaryProrationRule ?? 'month_fraction';
  const monthFraction = salaryEndDate.getUTCMonth() / 12;
  const dailyFraction = (() => {
    const yearStart = Date.UTC(salaryEndYear, 0, 1);
    const yearEnd = Date.UTC(salaryEndYear + 1, 0, 1);
    const elapsed = Math.max(0, salaryEndDate.getTime() - yearStart);
    return clamp(elapsed / Math.max(1, yearEnd - yearStart), 0, 1);
  })();
  const fraction = salaryProrationRule === 'daily' ? dailyFraction : monthFraction;
  return {
    salaryIncome: roundMoney(data.income.salaryAnnual * fraction),
    inferredAssumptions: [],
  };
}

function ageForYear(data: SeedData, year: number) {
  const robBirthYear = parseYear(data.household.robBirthDate);
  if (robBirthYear !== null) {
    return Math.max(0, year - robBirthYear);
  }
  const debbieBirthYear = parseYear(data.household.debbieBirthDate);
  if (debbieBirthYear !== null) {
    return Math.max(0, year - debbieBirthYear);
  }
  return 55;
}

function normalizeContributionSettings(
  data: SeedData,
): Required<
  Pick<
    PreRetirementContributionSettings,
    'employee401kPreTaxAnnualAmount' | 'employee401kRothAnnualAmount' | 'hsaAnnualAmount'
  >
> &
  Pick<PreRetirementContributionSettings, 'hsaCoverageType' | 'employerMatch'> {
  const settings = data.income.preRetirementContributions;
  const annual401kTargets = deriveAnnual401kTargets(settings, data.income.salaryAnnual);
  const annualHsaTarget = deriveAnnualHsaTarget(settings, data.income.salaryAnnual);
  return {
    employee401kPreTaxAnnualAmount: roundMoney(annual401kTargets.preTaxAnnualTarget),
    employee401kRothAnnualAmount: roundMoney(annual401kTargets.rothAnnualTarget),
    hsaAnnualAmount: roundMoney(annualHsaTarget),
    hsaCoverageType: settings?.hsaCoverageType ?? 'family',
    employerMatch: settings?.employerMatch ?? {
      matchRate: 0,
      maxEmployeeContributionPercentOfSalary: 0,
    },
  };
}

function monthsInRetirementForYear(data: SeedData, year: number) {
  const salaryEndDate = parseDateSafe(data.income.salaryEndDate);
  if (!salaryEndDate) {
    return {
      monthsInRetirement: 12,
      inferredAssumptions: [
        'income.salaryEndDate was invalid; assumed full retirement year (12 months).',
      ],
    };
  }
  const salaryEndYear = salaryEndDate.getUTCFullYear();
  if (year < salaryEndYear) {
    return {
      monthsInRetirement: 0,
      inferredAssumptions: [],
    };
  }
  if (year > salaryEndYear) {
    return {
      monthsInRetirement: 12,
      inferredAssumptions: [],
    };
  }
  return {
    monthsInRetirement: clamp(12 - salaryEndDate.getUTCMonth(), 0, 12),
    inferredAssumptions: [],
  };
}

function windfallIncomeForYear(data: SeedData, year: number) {
  return roundMoney(
    data.income.windfalls
      .filter((entry) => entry.year === year)
      .reduce((sum, entry) => sum + entry.amount, 0),
  );
}

function socialSecurityIncomeForYear(data: SeedData, year: RetirementFlowSourceYear) {
  const inferredAssumptions: string[] = [];
  const income = data.income.socialSecurity.reduce((sum, entry) => {
    const normalizedPerson = entry.person.toLowerCase();
    const modeledAge = normalizedPerson.includes('deb') ? year.debbieAge : year.robAge;
    if (!(modeledAge >= entry.claimAge)) {
      return sum;
    }
    if (!normalizedPerson.includes('deb') && !normalizedPerson.includes('rob')) {
      inferredAssumptions.push(
        `Social Security entry for "${entry.person}" was mapped to Rob by default because person label was unrecognized.`,
      );
    }
    return sum + entry.fraMonthly * 12 * socialSecurityBenefitFactor(entry.claimAge);
  }, 0);

  if (income > 0) {
    inferredAssumptions.push(
      'Social Security flow assumes full-year benefits once modeled age reaches claim age.',
    );
  }

  return {
    socialSecurityIncome: roundMoney(income),
    inferredAssumptions,
  };
}

function buildRetirementFlowYears(input: {
  data: SeedData;
  autopilotYears: RetirementFlowSourceYear[];
}): FlightPathRetirementFlowYear[] {
  if (!input.autopilotYears.length) {
    return [
      {
        year: parseYear(input.data.income.salaryEndDate) ?? CURRENT_YEAR,
        monthsInRetirement: 12,
        regime: 'unknown',
        taxableFlow: 0,
        rothFlow: 0,
        iraFlow: 0,
        cashFlow: 0,
        rmdFlow: 0,
        salaryIncome: 0,
        socialSecurityIncome: 0,
        windfallIncome: 0,
        totalIncome: 0,
        expectedMagi: 0,
        acaFriendlyMagiCeiling: null,
        acaHeadroomToCeiling: null,
        irmaaStatus: 'not_modeled',
        irmaaHeadroom: null,
        irmaaLookbackTaxYear: null,
        modelCompleteness: 'reconstructed',
        inferredAssumptions: [
          'Autopilot yearly flow data was unavailable; retirement flow rows defaulted to zero values.',
        ],
        intermediateCalculations: {
          source: 'autopilot_years_missing',
        },
      },
    ];
  }

  const rows: FlightPathRetirementFlowYear[] = [];
  input.autopilotYears.forEach((year) => {
    const monthsResult = monthsInRetirementForYear(input.data, year.year);
    if (!(monthsResult.monthsInRetirement > 0)) {
      return;
    }
    const salaryResult = salaryIncomeForYear(input.data, year.year);
    const socialSecurityResult = socialSecurityIncomeForYear(input.data, year);
    const windfallIncome = windfallIncomeForYear(input.data, year.year);
    const taxableFlow = roundMoney(year.withdrawalTaxable);
    const rothFlow = roundMoney(year.withdrawalRoth);
    const iraFlow = roundMoney(year.withdrawalIra401k);
    const cashFlow = roundMoney(year.withdrawalCash);
    const rmdFlow = roundMoney(year.rmdAmount);
    const acaFriendlyMagiCeiling = year.acaFriendlyMagiCeiling;
    const acaHeadroomToCeiling =
      acaFriendlyMagiCeiling === null ? null : roundMoney(acaFriendlyMagiCeiling - year.estimatedMAGI);
    const hasMedicareHouseholdMember = year.robAge >= 65 || year.debbieAge >= 65;
    const irmaaLookbackTaxYear = hasMedicareHouseholdMember ? year.year - 2 : null;
    const totalIncome = roundMoney(
      taxableFlow +
        rothFlow +
        iraFlow +
        cashFlow +
        salaryResult.salaryIncome +
        socialSecurityResult.socialSecurityIncome +
        windfallIncome,
    );
    const inferredAssumptions = Array.from(
      new Set([
        ...monthsResult.inferredAssumptions,
        ...salaryResult.inferredAssumptions,
        ...socialSecurityResult.inferredAssumptions,
      ]),
    );
    const regime: RetirementFlowRegime =
      year.regime === 'aca_bridge' || year.regime === 'standard' ? year.regime : 'unknown';
    const row: FlightPathRetirementFlowYear = {
      year: year.year,
      monthsInRetirement: monthsResult.monthsInRetirement,
      regime,
      taxableFlow,
      rothFlow,
      iraFlow,
      cashFlow,
      rmdFlow,
      salaryIncome: salaryResult.salaryIncome,
      socialSecurityIncome: socialSecurityResult.socialSecurityIncome,
      windfallIncome,
      totalIncome,
      expectedMagi: roundMoney(year.estimatedMAGI),
      acaFriendlyMagiCeiling,
      acaHeadroomToCeiling,
      irmaaStatus: year.irmaaStatus,
      irmaaHeadroom: year.irmaaHeadroom,
      irmaaLookbackTaxYear,
      modelCompleteness: inferredAssumptions.length ? 'reconstructed' : 'faithful',
      inferredAssumptions,
      intermediateCalculations: {
        withdrawalTaxable: taxableFlow,
        withdrawalRoth: rothFlow,
        withdrawalIra401k: iraFlow,
        withdrawalCash: cashFlow,
        salaryIncome: salaryResult.salaryIncome,
        socialSecurityIncome: socialSecurityResult.socialSecurityIncome,
        windfallIncome,
        expectedMagi: roundMoney(year.estimatedMAGI),
        acaFriendlyMagiCeiling: acaFriendlyMagiCeiling ?? 'not_modeled',
        acaHeadroomToCeiling: acaHeadroomToCeiling ?? 'not_modeled',
        irmaaStatus: year.irmaaStatus,
        irmaaHeadroom: year.irmaaHeadroom ?? 'not_modeled',
        irmaaLookbackTaxYear: irmaaLookbackTaxYear ?? 'not_applicable',
      },
    };
    rows.push(row);
  });
  return rows;
}

function pathAcaYearSummaries(path: PathResult | null | undefined): AcaPathYearSummary[] {
  return (path?.yearlySeries ?? []).map((year) => ({
    year: year.year,
    medianMagi: year.medianMagi,
    medianRothConversion: year.medianRothConversion,
  }));
}

function resolveAcaSubsidyRiskBand(input: {
  projectedMagi: number;
  acaFriendlyMagiCeiling: number | null;
  guardrailBufferDollars: number;
}): AcaSubsidyRiskBand {
  if (input.acaFriendlyMagiCeiling === null) {
    return 'unknown';
  }
  const headroom = input.acaFriendlyMagiCeiling - input.projectedMagi;
  if (headroom < 0) {
    return 'red';
  }
  if (headroom <= input.guardrailBufferDollars) {
    return 'yellow';
  }
  return 'green';
}

function nonMedicareCountForYear(data: SeedData, year: number | null) {
  if (year === null) {
    return 0;
  }
  return [data.household.robBirthDate, data.household.debbieBirthDate].reduce((count, birthDate) => {
    const birthYear = parseYear(birthDate);
    if (birthYear === null) {
      return count;
    }
    return count + (year - birthYear < 65 ? 1 : 0);
  }, 0);
}

function estimateAcaPremiumAtRisk(input: { data: SeedData; bridgeYear: number | null }) {
  const baselinePremium = input.data.rules.healthcarePremiums?.baselineAcaPremiumAnnual ?? 0;
  if (!(baselinePremium > 0) || input.bridgeYear === null) {
    return 0;
  }
  const nonMedicareCount = nonMedicareCountForYear(input.data, input.bridgeYear);
  if (!(nonMedicareCount > 0)) {
    return 0;
  }
  const medicalInflation =
    input.data.rules.healthcarePremiums?.medicalInflationAnnual ?? 0.055;
  const years = Math.max(0, input.bridgeYear - CURRENT_YEAR);
  return roundMoney(baselinePremium * nonMedicareCount * Math.pow(1 + medicalInflation, years));
}

function buildAcaBridgeMetrics(input: {
  data: SeedData;
  nowYear: number;
  firstMedicareYear: number;
  autopilotYears: AcaBridgeYearSummary[];
  executedPathYears?: AcaPathYearSummary[];
  unmitigatedPathYears?: AcaPathYearSummary[];
}): FlightPathAcaMetrics {
  const inferredAssumptions: string[] = [];
  const bridgeYearRecord = input.autopilotYears.find((year) => year.regime === 'aca_bridge');
  const bridgeYear = bridgeYearRecord?.year ?? Math.max(input.nowYear, input.firstMedicareYear - 1);
  const executedPathYear = input.executedPathYears?.find((year) => year.year === bridgeYear);
  const unmitigatedPathYear = input.unmitigatedPathYears?.find((year) => year.year === bridgeYear);
  const projectedMagi = roundMoney(
    executedPathYear?.medianMagi ?? bridgeYearRecord?.estimatedMAGI ?? 0,
  );
  const unmitigatedProjectedMagi = roundMoney(
    unmitigatedPathYear?.medianMagi ?? bridgeYearRecord?.estimatedMAGI ?? projectedMagi,
  );
  const acaFriendlyMagiCeiling = bridgeYearRecord?.acaFriendlyMagiCeiling ?? null;
  const headroomToCeiling =
    acaFriendlyMagiCeiling === null ? null : roundMoney(acaFriendlyMagiCeiling - projectedMagi);
  const requiredMagiReduction =
    acaFriendlyMagiCeiling === null
      ? 0
      : roundMoney(Math.max(0, projectedMagi - acaFriendlyMagiCeiling));
  const unmitigatedRequiredMagiReduction =
    acaFriendlyMagiCeiling === null
      ? 0
      : roundMoney(Math.max(0, unmitigatedProjectedMagi - acaFriendlyMagiCeiling));
  const acaMitigationDelta = roundMoney(
    Math.max(0, unmitigatedProjectedMagi - projectedMagi),
  );
  const targetMagiCeilingWithBuffer =
    acaFriendlyMagiCeiling === null
      ? null
      : roundMoney(Math.max(0, acaFriendlyMagiCeiling - ACA_GUARDRAIL_BUFFER_DOLLARS));
  const requiredMagiReductionWithBuffer =
    targetMagiCeilingWithBuffer === null
      ? 0
      : roundMoney(Math.max(0, projectedMagi - targetMagiCeilingWithBuffer));

  if (!bridgeYearRecord) {
    inferredAssumptions.push(
      `No modeled ACA bridge year was available; estimated bridge year as ${bridgeYear}.`,
    );
    inferredAssumptions.push(
      'Projected bridge-year MAGI was unavailable; defaulted projected MAGI to 0.',
    );
  }
  if (bridgeYearRecord && acaFriendlyMagiCeiling === null) {
    inferredAssumptions.push(
      `ACA-friendly MAGI ceiling was unavailable for modeled bridge year ${bridgeYear}.`,
    );
  }
  if (!executedPathYear) {
    inferredAssumptions.push(
      'Executed ACA MAGI used autopilot year estimate because no executed simulation year was provided.',
    );
  }
  if (!unmitigatedPathYear) {
    inferredAssumptions.push(
      'Unmitigated ACA MAGI used the same bridge-year estimate because no raw simulation year was provided.',
    );
  }

  const subsidyRiskBand = resolveAcaSubsidyRiskBand({
    projectedMagi,
    acaFriendlyMagiCeiling,
    guardrailBufferDollars: ACA_GUARDRAIL_BUFFER_DOLLARS,
  });
  const estimatedAcaPremiumAtRisk =
    subsidyRiskBand === 'red' || subsidyRiskBand === 'yellow' || unmitigatedRequiredMagiReduction > 0
      ? estimateAcaPremiumAtRisk({ data: input.data, bridgeYear })
      : 0;
  const acaStatus: AcaBridgeStatus =
    acaFriendlyMagiCeiling === null
      ? 'unknown'
      : requiredMagiReduction > 0
        ? 'breach'
        : unmitigatedRequiredMagiReduction > 0
          ? 'mitigated'
          : headroomToCeiling !== null && headroomToCeiling <= ACA_GUARDRAIL_BUFFER_DOLLARS
            ? 'watch'
            : 'safe';

  return {
    bridgeYear,
    projectedMagi,
    acaFriendlyMagiCeiling,
    headroomToCeiling,
    requiredMagiReduction,
    guardrailBufferDollars: ACA_GUARDRAIL_BUFFER_DOLLARS,
    targetMagiCeilingWithBuffer,
    requiredMagiReductionWithBuffer,
    unmitigatedProjectedMagi,
    unmitigatedRequiredMagiReduction,
    acaMitigationDelta,
    acaStatus,
    estimatedAcaPremiumAtRisk,
    subsidyRiskBand,
    modelCompleteness: inferredAssumptions.length ? 'reconstructed' : 'faithful',
    inferredAssumptions,
    intermediateCalculations: {
      bridgeYear,
      firstMedicareYear: input.firstMedicareYear,
      projectedMagi,
      unmitigatedProjectedMagi,
      acaFriendlyMagiCeiling: acaFriendlyMagiCeiling ?? 'not_modeled',
      headroomToCeiling: headroomToCeiling ?? 'not_modeled',
      requiredMagiReduction,
      unmitigatedRequiredMagiReduction,
      acaMitigationDelta,
      acaStatus,
      guardrailBufferDollars: ACA_GUARDRAIL_BUFFER_DOLLARS,
      targetMagiCeilingWithBuffer: targetMagiCeilingWithBuffer ?? 'not_modeled',
      requiredMagiReductionWithBuffer,
      estimatedAcaPremiumAtRisk,
    },
  };
}

function runSeededPath(input: {
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressors: string[];
  selectedResponses: string[];
}) {
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

function evaluateDraftImpact(input: {
  draft: ActionDraft;
  baseData: SeedData;
  assumptions: MarketAssumptions;
  selectedStressors: string[];
  selectedResponses: string[];
  baselineByScenario: Map<FlightPathActionSensitivityScenario['name'], PathResult>;
}) {
  const tradePatchedData = applyTradeInstructionsToData(input.baseData, input.draft.tradeInstructions);
  const patchedData = applyContributionSettingsPatchToData(
    tradePatchedData,
    input.draft.contributionSettingsPatch,
  );
  const scenarioProfiles = resolvePlaybookAssumptionVariants(input.assumptions);
  const scenarioDeltas = scenarioProfiles.map((scenario) => {
    const baselinePath = input.baselineByScenario.get(scenario.name);
    if (!baselinePath) {
      return {
        name: scenario.name,
        supportedMonthlyDelta: 0,
        successRateDelta: 0,
      };
    }
    const counterfactualPath = runSeededPath({
      data: patchedData,
      assumptions: scenario.assumptions,
      selectedStressors: input.selectedStressors,
      selectedResponses: input.selectedResponses,
    });
    const baselineRiskMetrics = resolvePathRiskMetrics(baselinePath);
    const counterfactualRiskMetrics = resolvePathRiskMetrics(counterfactualPath);
    const baselineSpendingCutRate = Number.isFinite(baselinePath.spendingCutRate)
      ? baselinePath.spendingCutRate
      : 0;
    const counterfactualSpendingCutRate = Number.isFinite(counterfactualPath.spendingCutRate)
      ? counterfactualPath.spendingCutRate
      : 0;
    return {
      name: scenario.name,
      supportedMonthlyDelta: roundMoney(
        firstYearSupportedMonthly(counterfactualPath) - firstYearSupportedMonthly(baselinePath),
      ),
      successRateDelta: Number((counterfactualPath.successRate - baselinePath.successRate).toFixed(4)),
      medianEndingWealthDelta: roundMoney(
        counterfactualPath.medianEndingWealth - baselinePath.medianEndingWealth,
      ),
      annualFederalTaxDelta: roundMoney(
        counterfactualPath.annualFederalTaxEstimate - baselinePath.annualFederalTaxEstimate,
      ),
      yearsFundedDelta: roundMoney(counterfactualPath.yearsFunded - baselinePath.yearsFunded),
      earlyFailureProbabilityDelta: Number(
        (
          counterfactualRiskMetrics.earlyFailureProbability -
          baselineRiskMetrics.earlyFailureProbability
        ).toFixed(4),
      ),
      worstDecileEndingWealthDelta: roundMoney(
        counterfactualRiskMetrics.worstDecileEndingWealth -
          baselineRiskMetrics.worstDecileEndingWealth,
      ),
      spendingCutRateDelta: Number(
        (counterfactualSpendingCutRate - baselineSpendingCutRate).toFixed(4),
      ),
      equitySalesInAdverseEarlyYearsRateDelta: Number(
        (
          counterfactualRiskMetrics.equitySalesInAdverseEarlyYearsRate -
          baselineRiskMetrics.equitySalesInAdverseEarlyYearsRate
        ).toFixed(4),
      ),
    };
  });

  const baseDelta = scenarioDeltas.find((item) => item.name === 'base');
  const impact: FlightPathActionImpactEstimate = {
    supportedMonthlyDelta: baseDelta?.supportedMonthlyDelta ?? 0,
    successRateDelta: baseDelta?.successRateDelta ?? 0,
    medianEndingWealthDelta: baseDelta?.medianEndingWealthDelta ?? 0,
    annualFederalTaxDelta: baseDelta?.annualFederalTaxDelta ?? 0,
    yearsFundedDelta: baseDelta?.yearsFundedDelta ?? 0,
    earlyFailureProbabilityDelta: baseDelta?.earlyFailureProbabilityDelta ?? 0,
    worstDecileEndingWealthDelta: baseDelta?.worstDecileEndingWealthDelta ?? 0,
    spendingCutRateDelta: baseDelta?.spendingCutRateDelta ?? 0,
    equitySalesInAdverseEarlyYearsRateDelta:
      baseDelta?.equitySalesInAdverseEarlyYearsRateDelta ?? 0,
  };

  const basePrimaryDirection = directionWithTolerance(
    Math.abs(impact.supportedMonthlyDelta) >= SENSITIVITY_SPEND_FLOOR
      ? impact.supportedMonthlyDelta
      : impact.successRateDelta * 100,
  );
  const sensitivityScenarios = scenarioDeltas.map((scenario) => {
    const primaryDirection = directionWithTolerance(
      Math.abs(scenario.supportedMonthlyDelta) >= SENSITIVITY_SPEND_FLOOR
        ? scenario.supportedMonthlyDelta
        : scenario.successRateDelta * 100,
    );
    return {
      name: scenario.name,
      supportedMonthlyDelta: scenario.supportedMonthlyDelta,
      successRateDelta: scenario.successRateDelta,
      directionConsistent: basePrimaryDirection === 0
        ? primaryDirection === 0
        : primaryDirection === basePrimaryDirection,
    } satisfies FlightPathActionSensitivityScenario;
  });
  const consistencyScore = sensitivityScenarios.length
    ? sensitivityScenarios.filter((item) => item.directionConsistent).length /
      sensitivityScenarios.length
    : 0;

  return {
    impact,
    sensitivity: {
      baseSeed: input.assumptions.simulationSeed ?? 20260416,
      simulationRunsPerScenario: scenarioProfiles[0]?.assumptions.simulationRuns ?? DEFAULT_PLAYBOOK_SIMULATION_RUNS,
      directionConsistencyScore: Number(consistencyScore.toFixed(2)),
      scenarios: sensitivityScenarios,
    } satisfies FlightPathActionSensitivity,
  };
}

function scoreAction(input: {
  phaseId: PlaybookPhaseId;
  priority: PlaybookPriority;
  impact: FlightPathActionImpactEstimate;
  sensitivity: FlightPathActionSensitivity;
  acaGuardrailMode: 'normal' | 'watch' | 'recovery' | 'unknown';
  acaBridgeScoreBoost: number;
  isContributionSettingsAction: boolean;
}) {
  const successPoints = input.impact.successRateDelta * 100;
  const spendScore = input.impact.supportedMonthlyDelta / 250;
  const legacyScore = input.impact.medianEndingWealthDelta / 300_000;
  const taxScore = -Math.max(0, input.impact.annualFederalTaxDelta) / 25_000;
  const downsideScore =
    Math.max(0, -input.impact.earlyFailureProbabilityDelta) * 18 +
    Math.max(0, -input.impact.spendingCutRateDelta) * 8 +
    Math.max(0, -input.impact.equitySalesInAdverseEarlyYearsRateDelta) * 8 +
    Math.max(0, input.impact.worstDecileEndingWealthDelta) / 140_000;
  const consistencyScore = input.sensitivity.directionConsistencyScore;
  const acaBridgeBoost = input.phaseId === 'aca_bridge' ? input.acaBridgeScoreBoost : 0;
  const payrollActionBoost =
    input.isContributionSettingsAction && input.phaseId === 'aca_bridge'
      ? input.acaGuardrailMode === 'recovery'
        ? 0.28
        : input.acaGuardrailMode === 'watch'
          ? 0.14
          : 0.08
      : 0;
  const nonAcaPenalty =
    input.phaseId !== 'aca_bridge' && input.acaGuardrailMode === 'recovery' ? -0.08 : 0;
  const total =
    successPoints * 0.09 +
    spendScore * 0.32 +
    legacyScore * 0.16 +
    taxScore * 0.08 +
    downsideScore * 0.18 +
    consistencyScore * 0.35 +
    acaBridgeBoost +
    payrollActionBoost +
    nonAcaPenalty +
    priorityBoost(input.priority);
  return Number(total.toFixed(3));
}

function hasRunwayDownsideBenefit(impact: FlightPathActionImpactEstimate) {
  return (
    impact.earlyFailureProbabilityDelta <= -0.0025 ||
    impact.worstDecileEndingWealthDelta >= 5_000 ||
    impact.spendingCutRateDelta <= -0.01 ||
    impact.equitySalesInAdverseEarlyYearsRateDelta <= -0.01
  );
}

function buildAcaGuardrailAdjustment(input: {
  metrics: FlightPathAcaMetrics;
  data: SeedData;
  nowYear: number;
}): FlightPathPhasePlaybookDiagnostics['acaGuardrailAdjustment'] {
  const mode =
    input.metrics.subsidyRiskBand === 'red'
      ? 'recovery'
      : input.metrics.subsidyRiskBand === 'yellow'
        ? 'watch'
        : input.metrics.subsidyRiskBand === 'unknown'
          ? 'unknown'
          : 'normal';
  const runway = calculateRunwayGapMetrics({
    data: input.data,
    targetMonths: RUNWAY_TARGET_MONTHS,
  });
  const runwayGapMonths = runway.runwayGapMonths;
  const yearsUntilBridge =
    input.metrics.bridgeYear === null ? null : input.metrics.bridgeYear - input.nowYear;
  const preferRunwayFirst =
    (mode === 'recovery' || mode === 'watch') &&
    runwayGapMonths >= RUNWAY_GAP_MONTHS_FOR_PRIORITY_SHIFT &&
    yearsUntilBridge !== null &&
    yearsUntilBridge >= 1;
  const prioritizedPhaseIds: PlaybookPhaseId[] = preferRunwayFirst
    ? ['pre_retirement', 'aca_bridge', 'medicare_irmaa', 'pre_rmd', 'rmd_phase']
    : mode === 'recovery' || mode === 'watch'
      ? ['aca_bridge', 'pre_retirement', 'medicare_irmaa', 'pre_rmd', 'rmd_phase']
      : ['pre_retirement', 'aca_bridge', 'medicare_irmaa', 'pre_rmd', 'rmd_phase'];
  const requiredMagiReduction = input.metrics.requiredMagiReductionWithBuffer;

  return {
    mode,
    active: mode === 'recovery' || mode === 'watch',
    subsidyRiskBand: input.metrics.subsidyRiskBand,
    requiredMagiReduction,
    prioritizedPhaseIds,
    acaBridgeScoreBoost: preferRunwayFirst
      ? mode === 'recovery'
        ? 0.24
        : mode === 'watch'
          ? 0.12
          : 0
      : mode === 'recovery'
        ? 0.45
        : mode === 'watch'
          ? 0.2
          : 0,
    priorityDriver: preferRunwayFirst ? 'runway_first' : 'aca_bridge_first',
    runwayGapMonths,
    yearsUntilBridge,
  };
}

function resolveLaymanStoryHook(phaseId: PlaybookPhaseId) {
  if (phaseId === 'pre_retirement') {
    return 'Think of this as building a runway before your paycheck turns off.';
  }
  if (phaseId === 'aca_bridge') {
    return 'This is a bridge move so healthcare income rules do not force bad timing decisions.';
  }
  if (phaseId === 'medicare_irmaa') {
    return 'This creates room so IRMAA lookback years are less likely to surprise your premiums.';
  }
  if (phaseId === 'pre_rmd') {
    return 'This is a risk-shaping move before RMDs become mandatory.';
  }
  return 'This is a logistics move so RMD withdrawals can happen without forced selling.';
}

function resolveLaymanTiming(priority: PlaybookPriority) {
  if (priority === 'now') {
    return 'Do this in the next 30 days.';
  }
  if (priority === 'soon') {
    return 'Queue this for the next quarter.';
  }
  return 'Set a reminder and review this monthly until the trigger appears.';
}

function buildLaymanExpansion(input: {
  draft: ActionDraft;
  impact: FlightPathActionImpactEstimate;
  sensitivity: FlightPathActionSensitivity;
}) {
  const contributionPatch = input.draft.contributionSettingsPatch ?? null;
  if (contributionPatch) {
    const patchSummary = [
      typeof contributionPatch.employee401kPreTaxAnnualAmount === 'number'
        ? `pre-tax 401(k) target to ${formatMoneyLabel(contributionPatch.employee401kPreTaxAnnualAmount)}/yr`
        : null,
      typeof contributionPatch.employee401kRothAnnualAmount === 'number'
        ? `Roth 401(k) target to ${formatMoneyLabel(contributionPatch.employee401kRothAnnualAmount)}/yr`
        : null,
      typeof contributionPatch.hsaAnnualAmount === 'number'
        ? `HSA target to ${formatMoneyLabel(contributionPatch.hsaAnnualAmount)}/yr`
        : null,
    ].filter((item): item is string => Boolean(item));
    const whyImportantLead =
      input.draft.phaseId === 'pre_retirement'
        ? 'This helps build spendable runway cash while salary is still active.'
        : 'This reduces MAGI pressure before retirement withdrawals start.';
    return {
      templateVersion: 'layman_v1',
      cacheKey: [
        input.draft.id,
        contributionPatch.employee401kPreTaxAnnualAmount ?? 'na',
        contributionPatch.employee401kRothAnnualAmount ?? 'na',
        contributionPatch.hsaAnnualAmount ?? 'na',
        input.impact.supportedMonthlyDelta.toFixed(2),
        input.impact.successRateDelta.toFixed(4),
      ].join('|'),
      storyHook: resolveLaymanStoryHook(input.draft.phaseId),
      plainEnglishTask: `Update payroll settings: ${patchSummary.join(', ')}.`,
      whyImportant: `${whyImportantLead} Base scenario impact is ${formatSignedPointsLabel(
        input.impact.successRateDelta,
      )} success and ${formatSignedMoneyLabel(
        input.impact.supportedMonthlyDelta,
      )} per month of supported spending, with ${Math.round(
        input.sensitivity.directionConsistencyScore * 100,
      )}% direction consistency in sensitivity runs.`,
      walkthroughSteps: [
        resolveLaymanTiming(input.draft.priority),
        'Open payroll elections and set pre-tax 401(k), Roth 401(k), and HSA to the target values shown.',
        input.draft.phaseId === 'pre_retirement'
          ? 'If the move lowers pre-tax deferrals to build cash runway, set a reminder to revisit deferrals before ACA bridge years.'
          : 'If ACA headroom is tight, favor pre-tax + HSA first and move Roth deferrals only if needed.',
        'After payroll changes are in place, rerun the plan and verify runway and ACA headroom moved in the intended direction.',
      ],
      watchOuts: [
        'Payroll election changes can take one or two pay cycles to show up; timing matters late in the year.',
        'Do not exceed annual IRS limits across pre-tax + Roth employee 401(k) deferrals combined.',
        'HSA contributions require HSA eligibility; keep coverage type and eligibility current.',
      ],
    } satisfies FlightPathActionLaymanExpansion;
  }

  const instructionTotal = roundMoney(
    input.draft.tradeInstructions.reduce((sum, instruction) => sum + instruction.dollarAmount, 0),
  );
  const fromSymbols = Array.from(
    new Set(input.draft.tradeInstructions.map((instruction) => instruction.fromSymbol.toUpperCase())),
  );
  const toSymbols = Array.from(
    new Set(input.draft.tradeInstructions.map((instruction) => instruction.toSymbol.toUpperCase())),
  );
  const buckets = Array.from(
    new Set(input.draft.tradeInstructions.map((instruction) => portfolioBucketLabel(instruction.accountBucket))),
  );

  const plainEnglishTask = input.draft.tradeInstructions.length
    ? `Move about ${formatMoneyLabel(instructionTotal)} from ${joinReadableList(fromSymbols)} into ${joinReadableList(
      toSymbols,
    )} across your ${joinReadableList(buckets)} accounts.`
    : 'No direct fund move is required yet. Keep this phase monitored and ready.';

  const whyImportant = `Base scenario impact is ${formatSignedPointsLabel(
    input.impact.successRateDelta,
  )} success and ${formatSignedMoneyLabel(
    input.impact.supportedMonthlyDelta,
  )} per month of supported spending, with ${Math.round(
    input.sensitivity.directionConsistencyScore * 100,
  )}% direction consistency in sensitivity runs.`;

  const walkthroughSteps = [
    resolveLaymanTiming(input.draft.priority),
    ...input.draft.tradeInstructions.map((instruction, index) => {
      const accountName = instruction.sourceAccountName || `${portfolioBucketLabel(instruction.accountBucket)} account`;
      return `Step ${index + 1}: In ${accountName}, move about ${formatMoneyLabel(
        instruction.dollarAmount,
      )} (${instruction.percentOfHolding.toFixed(1)}% of ${instruction.fromSymbol}) from ${instruction.fromSymbol} to ${instruction.toSymbol}.`;
    }),
    'After the trades settle, run the plan again and compare success rate, supported spending, and annual federal tax.',
  ];

  const watchOuts = [
    input.draft.tradeInstructions.some((instruction) => instruction.accountBucket === 'taxable')
      ? 'Taxable-account moves can realize capital gains; check tax lot impact before trading.'
      : 'Keep this inside the same tax bucket to avoid accidental tax consequences.',
    input.draft.tradeInstructions.some((instruction) => instruction.estimatedFromTargetAllocation)
      ? 'At least one step used estimated holdings; verify exact account holdings before placing orders.'
      : 'Use these dollar amounts as guides; if prices move, keep the direction and approximate size.',
    'Pause and re-check if this conflicts with near-term cash needs, withdrawals, or required distributions.',
  ];

  return {
    templateVersion: 'layman_v1',
    cacheKey: [
      input.draft.id,
      instructionTotal.toFixed(2),
      input.impact.supportedMonthlyDelta.toFixed(2),
      input.impact.successRateDelta.toFixed(4),
    ].join('|'),
    storyHook: resolveLaymanStoryHook(input.draft.phaseId),
    plainEnglishTask,
    whyImportant,
    walkthroughSteps,
    watchOuts,
  } satisfies FlightPathActionLaymanExpansion;
}

function resolvePhaseWindows(input: {
  data: SeedData;
  nowYear: number;
  autopilotYears: Array<{ year: number; rmdAmount: number }>;
}) {
  const inferredAssumptions: string[] = [];
  const salaryEndYear = parseYear(input.data.income.salaryEndDate);
  const retirementYear = salaryEndYear ?? input.nowYear + 1;
  if (salaryEndYear === null) {
    inferredAssumptions.push(
      'income.salaryEndDate was invalid; defaulted retirement phase boundary to now + 1 year.',
    );
  }

  const birthYears = [input.data.household.robBirthDate, input.data.household.debbieBirthDate]
    .map(parseYear)
    .filter((value): value is number => value !== null);
  const firstMedicareYear = birthYears.length
    ? Math.min(...birthYears.map((year) => year + 65))
    : retirementYear + 3;
  if (!birthYears.length) {
    inferredAssumptions.push(
      'Household birth dates were invalid; estimated first Medicare year as retirement year + 3.',
    );
  }

  const firstModeledRmdYear = input.autopilotYears.find((year) => year.rmdAmount > 1)?.year;
  const explicitRmdStartAge = input.data.rules.rmdPolicy?.startAgeOverride;
  const estimatedRmdYearFromBirth = birthYears.length
    ? Math.min(
      ...birthYears.map(
        (birthYear) => birthYear + (explicitRmdStartAge ?? getRmdStartAgeForBirthYear(birthYear)),
      ),
    )
    : firstMedicareYear + (explicitRmdStartAge ? Math.max(0, explicitRmdStartAge - 65) : 8);
  if (!firstModeledRmdYear && !birthYears.length) {
    inferredAssumptions.push(
      'Unable to derive RMD start from birth dates; estimated first RMD year as first Medicare year + 8.',
    );
  }
  const firstRmdYear = firstModeledRmdYear ?? estimatedRmdYearFromBirth;
  if (!firstModeledRmdYear && explicitRmdStartAge === undefined) {
    inferredAssumptions.push(
      `No modeled RMD year was present; used estimated RMD start year ${firstRmdYear}.`,
    );
  }

  const planningEndYear = input.autopilotYears.at(-1)?.year ?? input.nowYear + 30;

  const rawPhases: Array<Omit<PhaseDefinition, 'status'>> = [
    {
      id: 'pre_retirement',
      label: 'Pre-Retirement',
      objective: 'Build runway and execution readiness before earned income stops.',
      windowStartYear: input.nowYear,
      windowEndYear: retirementYear,
    },
    {
      id: 'aca_bridge',
      label: 'Bridge To Medicare',
      objective: 'Manage MAGI and withdrawal sourcing while ACA subsidy sensitivity is highest.',
      windowStartYear: retirementYear + 1,
      windowEndYear: Math.max(retirementYear + 1, firstMedicareYear - 1),
    },
    {
      id: 'medicare_irmaa',
      label: 'Medicare + IRMAA Shaping',
      objective: 'Stay ahead of two-year IRMAA lookback pressure with smoother income timing.',
      windowStartYear: Math.max(input.nowYear, firstMedicareYear - 2),
      windowEndYear: Math.min(planningEndYear, firstMedicareYear + 3),
    },
    {
      id: 'pre_rmd',
      label: 'Pre-RMD Tax Shaping',
      objective: 'Use pre-RMD years to improve tax flexibility before forced distributions begin.',
      windowStartYear: Math.max(firstMedicareYear, retirementYear + 1),
      windowEndYear: Math.max(firstMedicareYear, firstRmdYear - 1),
    },
    {
      id: 'rmd_phase',
      label: 'RMD Phase',
      objective: 'Stage liquidity and withdrawal logistics for mandatory distributions.',
      windowStartYear: firstRmdYear,
      windowEndYear: planningEndYear,
    },
  ];

  const phases = rawPhases
    .filter((phase) => phase.windowEndYear >= phase.windowStartYear)
    .map((phase) => ({
      ...phase,
      status: inferPhaseStatus(input.nowYear, phase.windowStartYear, phase.windowEndYear),
    }));

  return {
    phases,
    retirementYear,
    firstMedicareYear,
    firstRmdYear,
    inferredAssumptions,
  };
}

function buildPreRetirementDraft(input: {
  data: SeedData;
  nowYear: number;
  retirementYear: number;
}): ActionDraft[] {
  const positionsResult = collectPositionsForSymbol({
    data: input.data,
    symbol: 'VTI',
    buckets: ['pretax', 'roth', 'hsa'],
  });
  const positions = positionsResult.positions;
  const totalVti = positions.reduce((sum, item) => sum + item.value, 0);

  const runway = calculateRunwayGapMetrics({
    data: input.data,
    targetMonths: RUNWAY_TARGET_MONTHS,
  });
  const essentialWithFixedMonthly = runway.essentialWithFixedMonthly;
  const targetCashRunway = runway.targetCashRunway;
  const directCashBalance = runway.directCashBalance;
  const investmentCashSleeves = runway.investmentCashSleeves;
  const currentRunwayLiquidity = runway.currentRunwayLiquidity;
  const cashGap = runway.cashGap;
  const tradeDrafts = (() => {
    if (!(totalVti > 0)) {
      return [] as ActionDraft[];
    }
    const moveDollars = cashGap > 0
      ? Math.min(totalVti * 0.2, Math.max(totalVti * 0.05, cashGap))
      : totalVti * 0.1;
    const fullGoalDollars = cashGap > 0 ? Math.min(totalVti, cashGap) : moveDollars;
    const moveSizeVariants = buildMoveSizeVariants({
      baseMoveDollars: moveDollars,
      maxAvailableDollars: totalVti,
      multipliers: [0.7, 1, 1.3],
    });

    return moveSizeVariants.map((moveSize, index) => {
      const instructions = buildTradeInstructionsFromPositions({
        positions,
        toSymbol: CASH_SYMBOL,
        moveDollarsTotal: moveSize,
      });
      const profileLabel = index === 0 ? 'Conservative' : index === 1 ? 'Balanced' : 'Assertive';
      return {
        id: `pre-retirement-vti-runway-${index + 1}`,
        phaseId: 'pre_retirement',
        title: `${profileLabel} pre-retirement runway reserve`,
        priority: cashGap > 0 ? 'now' : 'soon',
        objective:
          'Create a predictable cash runway before salary ends so required spending is less sequence-sensitive.',
        whyNow: `Salary is modeled to end in ${input.retirementYear}, so runway funding is most useful before that transition.`,
        tradeInstructions: instructions,
        fullGoalDollars: roundMoney(fullGoalDollars),
        inferredAssumptions: positionsResult.inferredAssumptions,
        intermediateCalculations: {
          essentialWithFixedMonthly: roundMoney(essentialWithFixedMonthly),
          targetCashRunway18Months: roundMoney(targetCashRunway),
          directCashBalance: roundMoney(directCashBalance),
          investmentCashSleeves: roundMoney(investmentCashSleeves),
          currentRunwayLiquidity: roundMoney(currentRunwayLiquidity),
          cashGapToTarget: roundMoney(cashGap),
          totalVtiAcrossPreTaxRothHsa: roundMoney(totalVti),
          plannedVtiToCashMove: roundMoney(
            instructions.reduce((sum, item) => sum + item.dollarAmount, 0),
          ),
        },
      } satisfies ActionDraft;
    });
  })();

  const payrollRunwayDrafts = (() => {
    if (!(cashGap > 0)) {
      return [] as ActionDraft[];
    }

    const normalizedSettings = normalizeContributionSettings(input.data);
    if (!(normalizedSettings.employee401kPreTaxAnnualAmount > 0)) {
      return [] as ActionDraft[];
    }

    const salaryNow = salaryIncomeForYear(input.data, input.nowYear);
    if (!(salaryNow.salaryIncome > 0)) {
      return [] as ActionDraft[];
    }

    let salaryIncomeUntilRetirement = 0;
    const salaryInferredAssumptions: string[] = [...salaryNow.inferredAssumptions];
    for (let year = input.nowYear; year <= input.retirementYear; year += 1) {
      const yearSalary = salaryIncomeForYear(input.data, year);
      salaryIncomeUntilRetirement += yearSalary.salaryIncome;
      salaryInferredAssumptions.push(...yearSalary.inferredAssumptions);
    }
    if (!(salaryIncomeUntilRetirement > 0)) {
      return [] as ActionDraft[];
    }

    const equivalentFullSalaryYears =
      salaryIncomeUntilRetirement / Math.max(1, input.data.income.salaryAnnual);
    const payrollTakeHomeFactor = resolvePayrollTakeHomeFactor(input.data);
    const annualReductionNeed = clamp(
      roundMoney(
        cashGap /
          Math.max(
            0.1,
            equivalentFullSalaryYears * payrollTakeHomeFactor,
          ),
      ),
      0,
      roundMoney(normalizedSettings.employee401kPreTaxAnnualAmount),
    );
    if (!(annualReductionNeed > 0)) {
      return [] as ActionDraft[];
    }

    const reductionVariants = buildMoveSizeVariants({
      baseMoveDollars: annualReductionNeed,
      maxAvailableDollars: normalizedSettings.employee401kPreTaxAnnualAmount,
      multipliers: [0.7, 1, 1.3],
    });

    return reductionVariants.map((annualReduction, index) => {
      const profileLabel = index === 0 ? 'Conservative' : index === 1 ? 'Balanced' : 'Assertive';
      const targetPreTaxAnnual = roundMoney(
        Math.max(0, normalizedSettings.employee401kPreTaxAnnualAmount - annualReduction),
      );
      return {
        id: `pre-retirement-payroll-runway-${index + 1}`,
        phaseId: 'pre_retirement',
        title: `${profileLabel} payroll runway cash builder`,
        priority: cashGap > 0 ? 'now' : 'soon',
        objective:
          'Temporarily lower pre-tax payroll deferrals to build spendable runway cash before salary ends, then re-ramp deferrals ahead of ACA bridge years.',
        whyNow: `Runway cash is modeled below the ${RUNWAY_TARGET_MONTHS}-month target before the ${input.retirementYear} transition.`,
        tradeInstructions: [],
        contributionSettingsPatch: {
          employee401kPreTaxAnnualAmount: targetPreTaxAnnual,
        },
        fullGoalDollars: roundMoney(cashGap),
        inferredAssumptions: Array.from(
          new Set([
            ...salaryInferredAssumptions,
            ...(input.data.rules.payrollModel?.takeHomeFactor === undefined
              ? [
                `Estimated take-home conversion for reduced pre-tax deferrals assumed ${Math.round(
                  payrollTakeHomeFactor * 100,
                )}% after taxes and withholdings.`,
              ]
              : []),
          ]),
        ),
        intermediateCalculations: {
          essentialWithFixedMonthly: roundMoney(essentialWithFixedMonthly),
          targetCashRunway18Months: roundMoney(targetCashRunway),
          directCashBalance: roundMoney(directCashBalance),
          investmentCashSleeves: roundMoney(investmentCashSleeves),
          currentRunwayLiquidity: roundMoney(currentRunwayLiquidity),
          cashGapToTarget: roundMoney(cashGap),
          salaryIncomeCurrentYear: roundMoney(salaryNow.salaryIncome),
          salaryIncomeUntilRetirement: roundMoney(salaryIncomeUntilRetirement),
          equivalentFullSalaryYears: roundMoney(equivalentFullSalaryYears),
          estimatedTakeHomeFactor: payrollTakeHomeFactor,
          currentEmployee401kPreTaxAnnualAmount: roundMoney(
            normalizedSettings.employee401kPreTaxAnnualAmount,
          ),
          annualPreTaxReduction: roundMoney(annualReduction),
          estimatedAnnualTakeHomeFreed: roundMoney(
            annualReduction * payrollTakeHomeFactor,
          ),
          targetEmployee401kPreTaxAnnualAmount: targetPreTaxAnnual,
        },
      } satisfies ActionDraft;
    });
  })();

  const finalYear401kDrafts = (() => {
    const salaryResult = salaryIncomeForYear(input.data, input.retirementYear);
    if (!(salaryResult.salaryIncome > 0)) {
      return [] as ActionDraft[];
    }
    const normalizedSettings = normalizeContributionSettings(input.data);
    const contributionResult = calculatePreRetirementContributions({
      age: ageForYear(input.data, input.retirementYear),
      salaryAnnual: input.data.income.salaryAnnual,
      salaryThisYear: salaryResult.salaryIncome,
      retirementDate: input.data.income.salaryEndDate,
      projectionYear: input.retirementYear,
      filingStatus: input.data.household.filingStatus,
      settings: input.data.income.preRetirementContributions,
      limitSettings: input.data.rules.contributionLimits,
      accountBalances: {
        pretax: input.data.accounts.pretax.balance,
        roth: input.data.accounts.roth.balance,
        hsa: input.data.accounts.hsa?.balance,
      },
    });
    const remainingRoom = roundMoney(contributionResult.employee401kRemainingRoom);
    if (!(remainingRoom >= 1_000)) {
      return [] as ActionDraft[];
    }
    const targetPreTaxAnnual = roundMoney(contributionResult.employee401kAnnualLimit);
    const estimatedFederalTaxSavings = roundMoney(remainingRoom * 0.22);
    const finalYearDeferralRateNeeded =
      salaryResult.salaryIncome > 0
        ? roundPercent((targetPreTaxAnnual / salaryResult.salaryIncome) * 100)
        : 0;
    const sourceAssumption = input.data.rules.contributionLimits?.assumptionSource;
    const inferredAssumptions = Array.from(
      new Set([
        ...salaryResult.inferredAssumptions,
        ...(sourceAssumption
          ? [
            `Contribution limits use explicit rules.contributionLimits source "${sourceAssumption}".`,
          ]
          : []),
        'Estimated federal tax savings use a 22% marginal federal rate placeholder.',
      ]),
    );

    return [
      {
        id: 'pre-retirement-final-year-401k-max-1',
        phaseId: 'pre_retirement',
        title: 'Final paycheck 401(k) room capture',
        priority: 'now',
        objective:
          'Use remaining employee 401(k) deferral room in the final salary year to lower MAGI and add pre-tax Roth-conversion fuel.',
        whyNow: `${input.retirementYear} has ${formatMoneyLabel(
          remainingRoom,
        )} of modeled employee 401(k) room still unused, and those final paychecks are the last payroll window to capture it.`,
        tradeInstructions: [],
        contributionSettingsPatch: {
          employee401kPreTaxAnnualAmount: targetPreTaxAnnual,
          ...(normalizedSettings.employee401kRothAnnualAmount > 0
            ? { employee401kRothAnnualAmount: 0 }
            : {}),
        },
        fullGoalDollars: remainingRoom,
        inferredAssumptions,
        intermediateCalculations: {
          finalPayrollYear: input.retirementYear,
          salaryModeledForFinalPayrollYear: roundMoney(salaryResult.salaryIncome),
          currentEmployee401kPreTaxAnnualAmount: roundMoney(
            normalizedSettings.employee401kPreTaxAnnualAmount,
          ),
          currentEmployee401kRothAnnualAmount: roundMoney(
            normalizedSettings.employee401kRothAnnualAmount,
          ),
          currentEmployee401kContributionFinalYear:
            contributionResult.employee401kContribution,
          currentEmployee401kPreTaxContributionFinalYear:
            contributionResult.employee401kPreTaxContribution,
          employee401kAnnualLimit: contributionResult.employee401kAnnualLimit,
          employee401kRemainingRoom: remainingRoom,
          targetEmployee401kPreTaxAnnualAmount: targetPreTaxAnnual,
          finalYearDeferralRateNeededPercent: finalYearDeferralRateNeeded,
          estimatedMagiReduction: remainingRoom,
          estimatedAcaCushionAdded: remainingRoom,
          estimatedFederalTaxSavings,
        },
      } satisfies ActionDraft,
    ];
  })();

  return [...finalYear401kDrafts, ...payrollRunwayDrafts, ...tradeDrafts];
}

function buildRothConcentrationDraft(input: { data: SeedData }): ActionDraft[] {
  const rothBalance = input.data.accounts.roth.balance;
  if (!(rothBalance > 0)) {
    return [];
  }

  const positionsResult = collectPositionsForSymbol({
    data: input.data,
    symbol: ROTH_CONCENTRATION_SYMBOL,
    buckets: ['roth'],
  });
  const positions = positionsResult.positions;
  const concentratedValue = positions.reduce((sum, item) => sum + item.value, 0);
  if (!(concentratedValue > 0)) {
    return [];
  }

  const concentrationShare = concentratedValue / rothBalance;
  if (concentrationShare <= ROTH_CONCENTRATION_WATCH_SHARE) {
    return [];
  }

  const targetShares = [0.65, ROTH_CONCENTRATION_WATCH_SHARE, 0.35].filter(
    (targetShare) => targetShare < concentrationShare,
  );
  return targetShares.map((targetShare, index) => {
    const moveDollars = roundMoney(
      Math.min(concentratedValue, concentratedValue - rothBalance * targetShare),
    );
    const instructions = buildSplitTradeInstructionsFromPositions({
      positions,
      splitTargets: [
        { toSymbol: 'VTI', weight: ROTH_CONCENTRATION_SPLIT_TO_VTI },
        { toSymbol: 'VXUS', weight: ROTH_CONCENTRATION_SPLIT_TO_VXUS },
      ],
      moveDollarsTotal: moveDollars,
    });
    const profileLabel = index === 0 ? 'Conservative' : index === 1 ? 'Balanced' : 'Assertive';
    return {
      id: `roth-fcntx-concentration-${index + 1}`,
      phaseId: 'pre_retirement',
      title: `${profileLabel} Roth FCNTX concentration reducer`,
      priority: concentrationShare >= ROTH_CONCENTRATION_NOW_SHARE ? 'now' : 'soon',
      objective:
        'Reduce single-fund Roth concentration while keeping the move inside tax-free Roth accounts.',
      whyNow: `${ROTH_CONCENTRATION_SYMBOL} is modeled at ${roundPercent(
        concentrationShare * 100,
      )}% of Roth assets; trimming inside Roth avoids taxable gains while reducing manager/style concentration.`,
      tradeInstructions: instructions,
      contributionSettingsPatch: null,
      fullGoalDollars: roundMoney(
        Math.max(0, concentratedValue - rothBalance * ROTH_CONCENTRATION_WATCH_SHARE),
      ),
      inferredAssumptions: positionsResult.inferredAssumptions,
      intermediateCalculations: {
        rothBalance: roundMoney(rothBalance),
        concentrationSymbol: ROTH_CONCENTRATION_SYMBOL,
        concentrationValue: roundMoney(concentratedValue),
        concentrationSharePercent: roundPercent(concentrationShare * 100),
        watchSharePercent: roundPercent(ROTH_CONCENTRATION_WATCH_SHARE * 100),
        targetSharePercent: roundPercent(targetShare * 100),
        plannedConcentrationReduction: roundMoney(moveDollars),
        plannedMoveToVti: roundMoney(moveDollars * ROTH_CONCENTRATION_SPLIT_TO_VTI),
        plannedMoveToVxus: roundMoney(moveDollars * ROTH_CONCENTRATION_SPLIT_TO_VXUS),
      },
    } satisfies ActionDraft;
  });
}

function buildAcaBridgeDraft(input: {
  data: SeedData;
  autopilotYears: Array<{
    year: number;
    regime: string;
    estimatedMAGI: number;
    acaFriendlyMagiCeiling: number | null;
    robAge: number;
    debbieAge: number;
  }>;
}): ActionDraft[] {
  const bridgeYear = input.autopilotYears.find((year) => year.regime === 'aca_bridge');
  const ceiling = bridgeYear?.acaFriendlyMagiCeiling ?? null;
  const overage =
    bridgeYear && ceiling !== null ? Math.max(0, bridgeYear.estimatedMAGI - ceiling) : 0;
  const targetMagiCeilingWithBuffer =
    ceiling === null ? null : Math.max(0, ceiling - ACA_GUARDRAIL_BUFFER_DOLLARS);
  const reductionNeededWithBuffer =
    bridgeYear && targetMagiCeilingWithBuffer !== null
      ? Math.max(0, bridgeYear.estimatedMAGI - targetMagiCeilingWithBuffer)
      : 0;
  const estimatedAcaPremiumAtRisk =
    bridgeYear && reductionNeededWithBuffer > 0
      ? estimateAcaPremiumAtRisk({ data: input.data, bridgeYear: bridgeYear.year })
      : 0;
  const payrollDrafts = (() => {
    if (!bridgeYear || !(reductionNeededWithBuffer > 0)) {
      return [] as ActionDraft[];
    }
    const salaryResult = salaryIncomeForYear(input.data, bridgeYear.year);
    if (!(salaryResult.salaryIncome > 0)) {
      return [] as ActionDraft[];
    }
    const normalizedSettings = normalizeContributionSettings(input.data);
    const contributionResult = calculatePreRetirementContributions({
      age: bridgeYear.robAge > 0 ? bridgeYear.robAge : ageForYear(input.data, bridgeYear.year),
      salaryAnnual: input.data.income.salaryAnnual,
      salaryThisYear: salaryResult.salaryIncome,
      retirementDate: input.data.income.salaryEndDate,
      projectionYear: bridgeYear.year,
      filingStatus: input.data.household.filingStatus,
      settings: input.data.income.preRetirementContributions,
      limitSettings: input.data.rules.contributionLimits,
      accountBalances: {
        pretax: input.data.accounts.pretax.balance,
        roth: input.data.accounts.roth.balance,
        hsa: input.data.accounts.hsa?.balance,
      },
    });
    const additionalPretaxRoom = contributionResult.employee401kRemainingRoom;
    const shiftableRothContribution = contributionResult.employee401kRothContribution;
    const additionalHsaRoom = contributionResult.hsaRemainingRoom;
    const maxMagiReduction = roundMoney(
      additionalPretaxRoom + shiftableRothContribution + additionalHsaRoom,
    );
    if (!(maxMagiReduction > 0)) {
      return [] as ActionDraft[];
    }

    const targetMagiReduction = Math.min(reductionNeededWithBuffer, maxMagiReduction);
    let remainingReduction = targetMagiReduction;
    const rothToPretaxShift = Math.min(shiftableRothContribution, remainingReduction);
    remainingReduction = Math.max(0, remainingReduction - rothToPretaxShift);
    const addedPretaxContribution = Math.min(additionalPretaxRoom, remainingReduction);
    remainingReduction = Math.max(0, remainingReduction - addedPretaxContribution);
    const addedHsaContribution = Math.min(additionalHsaRoom, remainingReduction);
    const salaryFraction =
      contributionResult.salaryFraction > 0
        ? contributionResult.salaryFraction
        : input.data.income.salaryAnnual > 0
          ? clamp(salaryResult.salaryIncome / input.data.income.salaryAnnual, 0, 1)
          : 0;
    if (!(salaryFraction > 0)) {
      return [] as ActionDraft[];
    }

    const annualize = (yearDollarDelta: number) => roundMoney(yearDollarDelta / salaryFraction);
    const preTaxAnnualIncrease = annualize(rothToPretaxShift + addedPretaxContribution);
    const rothAnnualReduction = annualize(rothToPretaxShift);
    const hsaAnnualIncrease = annualize(addedHsaContribution);
    const contributionSettingsPatch: FlightPathContributionSettingsPatch = {
      employee401kPreTaxAnnualAmount: roundMoney(
        Math.min(
          contributionResult.employee401kAnnualLimit,
          normalizedSettings.employee401kPreTaxAnnualAmount + preTaxAnnualIncrease,
        ),
      ),
      employee401kRothAnnualAmount: roundMoney(
        Math.max(0, normalizedSettings.employee401kRothAnnualAmount - rothAnnualReduction),
      ),
      hsaAnnualAmount: roundMoney(
        Math.min(
          contributionResult.hsaAnnualLimit,
          normalizedSettings.hsaAnnualAmount + hsaAnnualIncrease,
        ),
      ),
    };
    const payrollMagiReductionCovered = roundMoney(
      rothToPretaxShift + addedPretaxContribution + addedHsaContribution,
    );
    const remainingMagiReductionAfterPayroll = roundMoney(
      Math.max(0, reductionNeededWithBuffer - payrollMagiReductionCovered),
    );

    return [
      {
        id: 'aca-bridge-payroll-magi-reducer-1',
        phaseId: 'aca_bridge',
        title: 'ACA bridge payroll MAGI reducer',
        priority: 'now',
        objective:
          'Use paycheck deferrals first (pre-tax 401(k) and HSA) to keep bridge-year MAGI below the ACA cliff with a guardrail buffer.',
        whyNow:
          overage > 0
            ? `Bridge-year MAGI in ${bridgeYear.year} is modeled above the ACA-friendly ceiling by ${formatMoneyLabel(overage)}; the premium at risk is estimated near ${formatMoneyLabel(estimatedAcaPremiumAtRisk)}.`
            : `Bridge-year MAGI in ${bridgeYear.year} is within ${formatMoneyLabel(ACA_GUARDRAIL_BUFFER_DOLLARS)} of the ACA-friendly ceiling, so the buffer is not intact.`,
        tradeInstructions: [],
        contributionSettingsPatch,
        fullGoalDollars: roundMoney(reductionNeededWithBuffer),
        inferredAssumptions: [...salaryResult.inferredAssumptions],
        intermediateCalculations: {
          bridgeYear: bridgeYear.year,
          projectedBridgeYearMagi: roundMoney(bridgeYear.estimatedMAGI),
          acaFriendlyMagiCeiling: roundMoney(ceiling ?? 0),
          targetMagiCeilingWithBuffer: roundMoney(targetMagiCeilingWithBuffer ?? 0),
          acaBridgeMagiOverage: roundMoney(overage),
          acaBridgeMagiReductionNeededWithBuffer: roundMoney(reductionNeededWithBuffer),
          guardrailBufferDollars: ACA_GUARDRAIL_BUFFER_DOLLARS,
          estimatedAcaPremiumAtRisk,
          salaryModeledForBridgeYear: roundMoney(salaryResult.salaryIncome),
          salaryFraction,
          currentEmployee401kPreTaxAnnualAmount: roundMoney(
            normalizedSettings.employee401kPreTaxAnnualAmount,
          ),
          currentEmployee401kRothAnnualAmount: roundMoney(
            normalizedSettings.employee401kRothAnnualAmount,
          ),
          currentHsaAnnualAmount: roundMoney(normalizedSettings.hsaAnnualAmount),
          employee401kAnnualLimit: contributionResult.employee401kAnnualLimit,
          employee401kPreTaxCurrent: contributionResult.employee401kPreTaxContribution,
          employee401kRothCurrent: contributionResult.employee401kRothContribution,
          employee401kRemainingRoom: additionalPretaxRoom,
          shiftableRothContribution,
          hsaAnnualLimit: contributionResult.hsaAnnualLimit,
          hsaCurrentContribution: contributionResult.hsaContribution,
          hsaRemainingRoom: additionalHsaRoom,
          maxPayrollMagiReduction: maxMagiReduction,
          targetMagiReduction,
          rothToPretaxShift,
          addedPretaxContribution,
          addedHsaContribution,
          payrollMagiReductionCovered,
          remainingMagiReductionAfterPayroll,
          mitigationAttributedToRothConversionCapping:
            remainingMagiReductionAfterPayroll > 0
              ? remainingMagiReductionAfterPayroll
              : 0,
          targetEmployee401kPreTaxAnnualAmount:
            contributionSettingsPatch.employee401kPreTaxAnnualAmount ?? 'unchanged',
          targetEmployee401kRothAnnualAmount:
            contributionSettingsPatch.employee401kRothAnnualAmount ?? 'unchanged',
          targetHsaAnnualAmount: contributionSettingsPatch.hsaAnnualAmount ?? 'unchanged',
        },
      } satisfies ActionDraft,
    ];
  })();

  const taxableSymbolResult = collectPositionsForLargestTaxableRiskSymbol(input.data);
  if (!taxableSymbolResult.symbol || !taxableSymbolResult.positions.length) {
    return payrollDrafts;
  }
  const totalSymbolValue = taxableSymbolResult.positions.reduce(
    (sum, item) => sum + item.value,
    0,
  );
  const moveDollars = overage > 0
    ? Math.min(totalSymbolValue * 0.2, Math.max(totalSymbolValue * 0.05, overage))
    : totalSymbolValue * 0.08;
  const fullGoalDollars = overage > 0 ? Math.min(totalSymbolValue, overage) : moveDollars;
  const moveSizeVariants = buildMoveSizeVariants({
    baseMoveDollars: moveDollars,
    maxAvailableDollars: totalSymbolValue,
    multipliers: [0.7, 1, 1.35],
  });

  const cashStagingDrafts = moveSizeVariants.map((moveSize, index) => {
    const instructions = buildTradeInstructionsFromPositions({
      positions: taxableSymbolResult.positions,
      toSymbol: CASH_SYMBOL,
      moveDollarsTotal: moveSize,
    });
    const profileLabel = index === 0 ? 'Conservative' : index === 1 ? 'Balanced' : 'Assertive';
    return {
      id: `aca-bridge-cash-staging-${index + 1}`,
      phaseId: 'aca_bridge',
      title: `${profileLabel} ACA bridge cash staging`,
      priority: overage > 0 ? 'now' : 'watch',
      objective:
        'Pre-fund bridge-year spending from taxable liquidity so MAGI management has more room.',
      whyNow: bridgeYear
        ? `Bridge-year MAGI in ${bridgeYear.year} is modeled ${overage > 0 ? 'above' : 'near'} the ACA-friendly ceiling.`
        : 'Bridge years are upcoming; staging liquidity early avoids forced high-MAGI moves later.',
      tradeInstructions: instructions,
      contributionSettingsPatch: null,
      fullGoalDollars: roundMoney(fullGoalDollars),
      inferredAssumptions: taxableSymbolResult.inferredAssumptions,
      intermediateCalculations: {
        bridgeYear: bridgeYear?.year ?? 'not_modeled',
        acaFriendlyMagiCeiling: roundMoney(ceiling ?? 0),
        targetMagiCeilingWithBuffer: roundMoney(targetMagiCeilingWithBuffer ?? 0),
        projectedBridgeYearMagi: roundMoney(bridgeYear?.estimatedMAGI ?? 0),
        acaBridgeMagiOverage: roundMoney(overage),
        acaBridgeMagiReductionNeededWithBuffer: roundMoney(reductionNeededWithBuffer),
        guardrailBufferDollars: ACA_GUARDRAIL_BUFFER_DOLLARS,
        estimatedAcaPremiumAtRisk,
        taxableSourceSymbol: taxableSymbolResult.symbol,
        taxableSourceSymbolValue: roundMoney(totalSymbolValue),
        plannedTaxableToCashMove: roundMoney(
          instructions.reduce((sum, item) => sum + item.dollarAmount, 0),
        ),
      },
    } satisfies ActionDraft;
  });
  return [...payrollDrafts, ...cashStagingDrafts];
}

function buildMedicareIrmaaDraft(input: {
  data: SeedData;
  autopilotYears: Array<{
    year: number;
    robAge: number;
    debbieAge: number;
    irmaaStatus: string;
    irmaaHeadroom: number | null;
  }>;
}): ActionDraft[] {
  const pressureYear = input.autopilotYears.find((year) => {
    const hasMedicareHouseholdMember = year.robAge >= 65 || year.debbieAge >= 65;
    if (!hasMedicareHouseholdMember) {
      return false;
    }
    return (
      year.irmaaStatus.toLowerCase().includes('surcharge') ||
      (typeof year.irmaaHeadroom === 'number' && year.irmaaHeadroom < 8_000)
    );
  });

  const pretaxSchdResult = collectPositionsForSymbol({
    data: input.data,
    symbol: 'SCHD',
    buckets: ['pretax'],
  });
  const fallbackPretaxVtiResult = collectPositionsForSymbol({
    data: input.data,
    symbol: 'VTI',
    buckets: ['pretax'],
  });
  const sourcePositions = pretaxSchdResult.positions.length
    ? pretaxSchdResult.positions
    : fallbackPretaxVtiResult.positions;
  if (!sourcePositions.length) {
    return [];
  }

  const sourceSymbol = sourcePositions[0].symbol;
  const totalSourceValue = sourcePositions.reduce((sum, item) => sum + item.value, 0);
  const headroom = pressureYear?.irmaaHeadroom ?? 10_000;
  const reductionNeed = headroom < 0 ? Math.abs(headroom) : Math.max(0, 8_000 - headroom);
  const moveDollars = reductionNeed > 0
    ? Math.min(totalSourceValue * 0.15, Math.max(totalSourceValue * 0.05, reductionNeed))
    : totalSourceValue * 0.08;
  const fullGoalDollars = reductionNeed > 0 ? Math.min(totalSourceValue, reductionNeed) : moveDollars;
  const moveSizeVariants = buildMoveSizeVariants({
    baseMoveDollars: moveDollars,
    maxAvailableDollars: totalSourceValue,
    multipliers: [0.7, 1, 1.3],
  });

  return moveSizeVariants.map((moveSize, index) => {
    const instructions = buildTradeInstructionsFromPositions({
      positions: sourcePositions,
      toSymbol: CASH_SYMBOL,
      moveDollarsTotal: moveSize,
    });
    const profileLabel = index === 0 ? 'Conservative' : index === 1 ? 'Balanced' : 'Assertive';
    return {
      id: `medicare-irmaa-lookback-buffer-${index + 1}`,
      phaseId: 'medicare_irmaa',
      title: `${profileLabel} IRMAA lookback flexibility buffer`,
      priority: reductionNeed > 0 ? 'now' : 'soon',
      objective:
        'Build flexibility before IRMAA lookback years so withdrawals can stay under surcharge cliffs when needed.',
      whyNow: pressureYear
        ? `Modeled IRMAA pressure begins in ${pressureYear.year}, which maps to tax year ${pressureYear.year - 2} lookback.`
        : 'Medicare years are approaching; adding liquidity now widens IRMAA response options.',
      tradeInstructions: instructions,
      fullGoalDollars: roundMoney(fullGoalDollars),
      inferredAssumptions: [
        ...pretaxSchdResult.inferredAssumptions,
        ...fallbackPretaxVtiResult.inferredAssumptions,
      ],
      intermediateCalculations: {
        firstIrmaaPressureYear: pressureYear?.year ?? 'not_modeled',
        irmaaLookbackTaxYear: pressureYear ? pressureYear.year - 2 : 'not_modeled',
        irmaaHeadroom: roundMoney(headroom),
        irmaaHeadroomReductionNeed: roundMoney(reductionNeed),
        pretaxSourceSymbol: sourceSymbol,
        pretaxSourceSymbolValue: roundMoney(totalSourceValue),
        plannedPretaxToCashMove: roundMoney(
          instructions.reduce((sum, item) => sum + item.dollarAmount, 0),
        ),
      },
    } satisfies ActionDraft;
  });
}

function buildPreRmdDraft(input: {
  data: SeedData;
  nowYear: number;
  firstRmdYear: number;
}): ActionDraft[] {
  const pretaxSource = collectPositionsForSymbol({
    data: input.data,
    symbol: 'SCHD',
    buckets: ['pretax'],
  });
  const fallbackPretaxSource = collectPositionsForSymbol({
    data: input.data,
    symbol: 'VTI',
    buckets: ['pretax'],
  });
  const positions = pretaxSource.positions.length
    ? pretaxSource.positions
    : fallbackPretaxSource.positions;
  if (!positions.length) {
    return [];
  }

  const totalValue = positions.reduce((sum, item) => sum + item.value, 0);
  const moveDollars = totalValue * 0.08;
  const fullGoalDollars = moveDollars;
  const moveSizeVariants = buildMoveSizeVariants({
    baseMoveDollars: moveDollars,
    maxAvailableDollars: totalValue,
    multipliers: [0.75, 1, 1.25],
  });

  return moveSizeVariants.map((moveSize, index) => {
    const instructions = buildTradeInstructionsFromPositions({
      positions,
      toSymbol: 'BND',
      moveDollarsTotal: moveSize,
    });
    const profileLabel = index === 0 ? 'Conservative' : index === 1 ? 'Balanced' : 'Assertive';
    return {
      id: `pre-rmd-volatility-stepdown-${index + 1}`,
      phaseId: 'pre_rmd',
      title: `${profileLabel} pre-RMD volatility stepdown`,
      priority: 'soon',
      objective: 'Lower pre-RMD volatility in tax-deferred assets so forced withdrawals are less market-timing dependent.',
      whyNow: `Estimated first RMD year is ${input.firstRmdYear}, leaving ${Math.max(
        0,
        input.firstRmdYear - input.nowYear,
      )} years to shape risk before mandatory distributions.`,
      tradeInstructions: instructions,
      fullGoalDollars: roundMoney(fullGoalDollars),
      inferredAssumptions: [
        ...pretaxSource.inferredAssumptions,
        ...fallbackPretaxSource.inferredAssumptions,
      ],
      intermediateCalculations: {
        firstRmdYear: input.firstRmdYear,
        yearsUntilFirstRmd: Math.max(0, input.firstRmdYear - input.nowYear),
        pretaxRiskSourceValue: roundMoney(totalValue),
        plannedPretaxRiskToBondMove: roundMoney(
          instructions.reduce((sum, item) => sum + item.dollarAmount, 0),
        ),
      },
    } satisfies ActionDraft;
  });
}

function buildRmdPhaseDraft(input: {
  data: SeedData;
  autopilotYears: Array<{ year: number; rmdAmount: number }>;
  firstRmdYear: number;
}): ActionDraft[] {
  const firstRmd = input.autopilotYears.find((year) => year.rmdAmount > 1);
  const pretaxSource = collectPositionsForSymbol({
    data: input.data,
    symbol: 'SCHD',
    buckets: ['pretax'],
  });
  const fallbackSource = collectPositionsForSymbol({
    data: input.data,
    symbol: 'VTI',
    buckets: ['pretax'],
  });
  const positions = pretaxSource.positions.length
    ? pretaxSource.positions
    : fallbackSource.positions;
  if (!positions.length) {
    return [];
  }

  const totalValue = positions.reduce((sum, item) => sum + item.value, 0);
  const moveDollars = totalValue * 0.06;
  const fullGoalDollars = moveDollars;
  const moveSizeVariants = buildMoveSizeVariants({
    baseMoveDollars: moveDollars,
    maxAvailableDollars: totalValue,
    multipliers: [0.8, 1, 1.2],
  });

  return moveSizeVariants.map((moveSize, index) => {
    const instructions = buildTradeInstructionsFromPositions({
      positions,
      toSymbol: CASH_SYMBOL,
      moveDollarsTotal: moveSize,
    });
    const profileLabel = index === 0 ? 'Conservative' : index === 1 ? 'Balanced' : 'Assertive';
    return {
      id: `rmd-phase-liquidity-staging-${index + 1}`,
      phaseId: 'rmd_phase',
      title: `${profileLabel} RMD liquidity staging`,
      priority: firstRmd ? 'now' : 'soon',
      objective: 'Maintain a ready cash sleeve in pretax accounts to execute RMDs without forced selling.',
      whyNow: firstRmd
        ? `RMDs are already modeled starting ${firstRmd.year}.`
        : `RMD phase is estimated to start in ${input.firstRmdYear}.`,
      tradeInstructions: instructions,
      fullGoalDollars: roundMoney(fullGoalDollars),
      inferredAssumptions: [
        ...pretaxSource.inferredAssumptions,
        ...fallbackSource.inferredAssumptions,
      ],
      intermediateCalculations: {
        firstRmdYear: firstRmd?.year ?? input.firstRmdYear,
        firstModeledRmdAmount: roundMoney(firstRmd?.rmdAmount ?? 0),
        pretaxSourceValue: roundMoney(totalValue),
        plannedPretaxToCashMove: roundMoney(
          instructions.reduce((sum, item) => sum + item.dollarAmount, 0),
        ),
      },
    } satisfies ActionDraft;
  });
}

function buildDrafts(input: {
  data: SeedData;
  nowYear: number;
  retirementYear: number;
  firstRmdYear: number;
  autopilotYears: Array<{
    year: number;
    regime: string;
    estimatedMAGI: number;
    acaFriendlyMagiCeiling: number | null;
    robAge: number;
    debbieAge: number;
    irmaaStatus: string;
    irmaaHeadroom: number | null;
    rmdAmount: number;
  }>;
}) {
  return [
    buildPreRetirementDraft({
      data: input.data,
      nowYear: input.nowYear,
      retirementYear: input.retirementYear,
    }),
    buildRothConcentrationDraft({
      data: input.data,
    }),
    buildAcaBridgeDraft({
      data: input.data,
      autopilotYears: input.autopilotYears.map((year) => ({
        year: year.year,
        regime: year.regime,
        estimatedMAGI: year.estimatedMAGI,
        acaFriendlyMagiCeiling: year.acaFriendlyMagiCeiling,
        robAge: year.robAge,
        debbieAge: year.debbieAge,
      })),
    }),
    buildMedicareIrmaaDraft({
      data: input.data,
      autopilotYears: input.autopilotYears.map((year) => ({
        year: year.year,
        robAge: year.robAge,
        debbieAge: year.debbieAge,
        irmaaStatus: year.irmaaStatus,
        irmaaHeadroom: year.irmaaHeadroom,
      })),
    }),
    buildPreRmdDraft({
      data: input.data,
      nowYear: input.nowYear,
      firstRmdYear: input.firstRmdYear,
    }),
    buildRmdPhaseDraft({
      data: input.data,
      autopilotYears: input.autopilotYears.map((year) => ({
        year: year.year,
        rmdAmount: year.rmdAmount,
      })),
      firstRmdYear: input.firstRmdYear,
    }),
  ].flat();
}

export function buildFlightPathPhasePlaybook(
  input: FlightPathPhasePlaybookInput,
): FlightPathPhasePlaybook {
  const nowYear = input.nowYear ?? CURRENT_YEAR;
  const autopilotYears = input.evaluation?.raw.run.autopilot.years ?? [];
  const phaseBoundary = resolvePhaseWindows({
    data: input.data,
    nowYear,
    autopilotYears: autopilotYears.map((year) => ({
      year: year.year,
      rmdAmount: year.rmdAmount,
    })),
  });
  const phaseDefinitions = phaseBoundary.phases;
  const acaBridgeYearSummaries = autopilotYears.map((year) => ({
    year: year.year,
    regime: year.regime,
    estimatedMAGI: year.estimatedMAGI,
    acaFriendlyMagiCeiling: year.acaFriendlyMagiCeiling,
  })) satisfies AcaBridgeYearSummary[];
  const retirementFlowSourceYears = autopilotYears.map((year) => ({
    year: year.year,
    regime: year.regime,
    withdrawalCash: year.withdrawalCash,
    withdrawalTaxable: year.withdrawalTaxable,
    withdrawalIra401k: year.withdrawalIra401k,
    withdrawalRoth: year.withdrawalRoth,
    estimatedMAGI: year.estimatedMAGI,
    rmdAmount: year.rmdAmount,
    acaFriendlyMagiCeiling: year.acaFriendlyMagiCeiling,
    irmaaStatus: year.irmaaStatus,
    irmaaHeadroom: year.irmaaHeadroom,
    robAge: year.robAge,
    debbieAge: year.debbieAge,
  })) satisfies RetirementFlowSourceYear[];
  const drafts = buildDrafts({
    data: input.data,
    nowYear,
    retirementYear: phaseBoundary.retirementYear,
    firstRmdYear: phaseBoundary.firstRmdYear,
    autopilotYears: autopilotYears.map((year) => ({
      year: year.year,
      regime: year.regime,
      estimatedMAGI: year.estimatedMAGI,
      acaFriendlyMagiCeiling: year.acaFriendlyMagiCeiling,
      robAge: year.robAge,
      debbieAge: year.debbieAge,
      irmaaStatus: year.irmaaStatus,
      irmaaHeadroom: year.irmaaHeadroom,
      rmdAmount: year.rmdAmount,
    })),
  });
  const acaBridgeMetrics = buildAcaBridgeMetrics({
    data: input.data,
    nowYear,
    firstMedicareYear: phaseBoundary.firstMedicareYear,
    autopilotYears: acaBridgeYearSummaries,
    executedPathYears: pathAcaYearSummaries(input.executedSimulationOutcome),
    unmitigatedPathYears: pathAcaYearSummaries(input.unmitigatedSimulationOutcome),
  });
  const acaGuardrailAdjustment = buildAcaGuardrailAdjustment({
    metrics: acaBridgeMetrics,
    data: input.data,
    nowYear,
  });
  const retirementFlowYears = buildRetirementFlowYears({
    data: input.data,
    autopilotYears: retirementFlowSourceYears,
  });

  const mappingAssumptions = deriveAssetClassMappingAssumptionsFromAccounts(
    input.data.accounts,
    input.data.rules.assetClassMappingAssumptions,
  );
  const mappingMetadata = getAssetClassMappingMetadata([
    input.data.accounts.pretax.targetAllocation,
    input.data.accounts.roth.targetAllocation,
    input.data.accounts.taxable.targetAllocation,
    input.data.accounts.cash.targetAllocation,
    input.data.accounts.hsa?.targetAllocation ?? {},
  ], mappingAssumptions);
  const allocationAssumptionNotes = [
    ...mappingMetadata.ambiguousAssumptionsUsed.map(
      (item) => `Ambiguous holding ${item.symbol}: ${item.description}`,
    ),
    ...mappingMetadata.unknownSymbols.map(
      (symbol) => `Unknown symbol ${symbol} defaulted to US equity exposure.`,
    ),
  ];

  const assumptionVariants = resolvePlaybookAssumptionVariants(input.assumptions);
  const baselineByScenario = new Map<FlightPathActionSensitivityScenario['name'], PathResult>();
  assumptionVariants.forEach((variant) => {
    baselineByScenario.set(
      variant.name,
      runSeededPath({
        data: input.data,
        assumptions: variant.assumptions,
        selectedStressors: input.selectedStressors,
        selectedResponses: input.selectedResponses,
      }),
    );
  });

  const baseModelCompleteness = input.evaluation?.raw.run.plan.modelCompleteness ?? 'reconstructed';
  const planInferredAssumptions = input.evaluation?.raw.run.plan.inferredAssumptions ?? [
    'Plan evaluation context unavailable; model completeness defaulted to reconstructed.',
  ];
  const globalAssumptionBaseline = Array.from(
    new Set([
      ...planInferredAssumptions,
      ...phaseBoundary.inferredAssumptions,
      ...allocationAssumptionNotes,
    ]),
  );

  const unrankedActions: FlightPathPhaseAction[] = drafts
    .map((draft): FlightPathPhaseAction | null => {
      const impact = evaluateDraftImpact({
        draft,
        baseData: input.data,
        assumptions: input.assumptions,
        selectedStressors: input.selectedStressors,
        selectedResponses: input.selectedResponses,
        baselineByScenario,
      });

      const actionSpecificInferredAssumptions = Array.from(
        new Set([
          ...draft.inferredAssumptions,
          ...(draft.contributionSettingsPatch
            ? [
                'Contribution settings patch uses annualized payroll targets; in-year effect is prorated by salary timing.',
              ]
            : []),
          ...draft.tradeInstructions
            .filter((instruction) => instruction.estimatedFromTargetAllocation)
            .map(
              (instruction) =>
                `Trade instruction for ${instruction.fromSymbol} in ${instruction.accountBucket} used estimated holdings from target allocation.`,
            ),
        ]),
      );

      const modelCompleteness: PlaybookModelCompleteness =
        baseModelCompleteness === 'faithful' &&
        globalAssumptionBaseline.length === 0 &&
        actionSpecificInferredAssumptions.length === 0
          ? 'faithful'
          : 'reconstructed';

      const isRunwayAction = draft.id.includes('runway');
      if (isRunwayAction && !hasRunwayDownsideBenefit(impact.impact)) {
        return null;
      }

      const rankScore = scoreAction({
        phaseId: draft.phaseId,
        priority: draft.priority,
        impact: impact.impact,
        sensitivity: impact.sensitivity,
        acaGuardrailMode: acaGuardrailAdjustment.mode,
        acaBridgeScoreBoost: acaGuardrailAdjustment.acaBridgeScoreBoost,
        isContributionSettingsAction: Boolean(draft.contributionSettingsPatch),
      });

      const action: FlightPathPhaseAction = {
        id: draft.id,
        phaseId: draft.phaseId,
        title: draft.title,
        priority: draft.priority,
        rankWithinPhase: 0,
        rankScore,
        isTopRecommendation: false,
        objective: draft.objective,
        whyNow: draft.whyNow,
        tradeInstructions: draft.tradeInstructions,
        contributionSettingsPatch: draft.contributionSettingsPatch ?? null,
        fullGoalDollars: roundMoney(Math.max(0, draft.fullGoalDollars)),
        estimatedImpact: impact.impact,
        sensitivity: impact.sensitivity,
        laymanExpansion: buildLaymanExpansion({
          draft,
          impact: impact.impact,
          sensitivity: impact.sensitivity,
        }),
        modelCompleteness,
        inferredAssumptions: actionSpecificInferredAssumptions,
        intermediateCalculations: draft.intermediateCalculations,
      };
      return action;
    })
    .filter((action): action is FlightPathPhaseAction => action !== null);

  const rankedActions: FlightPathPhaseAction[] = phaseDefinitions.flatMap((phase) => {
    const phaseActions = unrankedActions
      .filter((action) => action.phaseId === phase.id)
      .sort((left, right) => {
        const scoreDiff = right.rankScore - left.rankScore;
        if (scoreDiff !== 0) {
          return scoreDiff;
        }
        return left.id.localeCompare(right.id);
      });

    return phaseActions.map((action, index): FlightPathPhaseAction => ({
      ...action,
      rankWithinPhase: index + 1,
      isTopRecommendation: index === 0,
    }));
  });

  const prioritizedOrderLookup = new Map<PlaybookPhaseId, number>();
  acaGuardrailAdjustment.prioritizedPhaseIds.forEach((phaseId, index) => {
    prioritizedOrderLookup.set(phaseId, index);
  });

  const phases: FlightPathPhasePlaybookSection[] = [...phaseDefinitions]
    .sort((left, right) => {
      const leftOrder = prioritizedOrderLookup.get(left.id) ?? Number.POSITIVE_INFINITY;
      const rightOrder = prioritizedOrderLookup.get(right.id) ?? Number.POSITIVE_INFINITY;
      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }
      return left.windowStartYear - right.windowStartYear;
    })
    .map((phase) => ({
      ...phase,
      acaMetrics: phase.id === 'aca_bridge' ? acaBridgeMetrics : undefined,
      actions: rankedActions.filter((action) => action.phaseId === phase.id),
    }));

  const globalInferredAssumptions = Array.from(
    new Set([
      ...globalAssumptionBaseline,
      ...acaBridgeMetrics.inferredAssumptions,
      ...rankedActions.flatMap((action) => action.inferredAssumptions),
    ]),
  );

  return {
    phases,
    retirementFlowYears,
    diagnostics: {
      scenarioRuns: assumptionVariants[0]?.assumptions.simulationRuns ?? DEFAULT_PLAYBOOK_SIMULATION_RUNS,
      simulationSeed: input.assumptions.simulationSeed ?? 20260416,
      acaGuardrailAdjustment,
      inferredAssumptions: globalInferredAssumptions,
    },
  };
}
