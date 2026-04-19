import type {
  AccountBucketType,
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
  SimulationStrategyMode,
  SimulationTimingConventions,
  SocialSecurityEntry,
  Stressor,
} from './types';
import { calculateFederalTax } from './tax-engine';
import type { YearTaxInputs, YearTaxOutputs } from './tax-engine';
import {
  boundedNormal,
  executeDeterministicMonteCarlo,
  median,
  percentile,
  type RandomSource,
  SIMULATION_CANCELLED_ERROR,
} from './monte-carlo-engine';
import {
  calculateIrmaaTier,
  calculateRequiredMinimumDistribution,
  DEFAULT_IRMAA_CONFIG,
} from './retirement-rules';
import { calculatePreRetirementContributions } from './contribution-engine';
import { calculateHealthcarePremiums } from './healthcare-premium-engine';
import { getHoldingExposure } from './asset-class-mapper';

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
  accounts: Record<AccountBucketType, SimBucketConfig>;
  preserveRoth: boolean;
  irmaaAware: boolean;
  guardrails: {
    floorYears: number;
    ceilingYears: number;
    cutPercent: number;
  };
  healthcarePremiums: {
    baselineAcaPremiumAnnual: number;
    baselineMedicarePremiumAnnual: number;
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
  failureReason: string;
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
  yearlySeries: PathYearResult[];
}

interface SimulationExecutionOptions {
  onProgress?: (progress: number) => void;
  isCancelled?: () => boolean;
  annualSpendTarget?: number;
  annualSpendScheduleByYear?: Record<number, number>;
  pathMode?: 'all' | 'selected_only';
  strategyMode?: SimulationStrategyMode;
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
    healthcarePremiums: {
      baselineAcaPremiumAnnual:
        data.rules.healthcarePremiums?.baselineAcaPremiumAnnual ??
        DEFAULT_BASELINE_ACA_PREMIUM_ANNUAL,
      baselineMedicarePremiumAnnual:
        data.rules.healthcarePremiums?.baselineMedicarePremiumAnnual ??
        DEFAULT_BASELINE_MEDICARE_PREMIUM_ANNUAL,
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

function applyStressors(plan: SimPlan, stressors: Stressor[]) {
  const nextPlan = {
    ...plan,
    socialSecurity: plan.socialSecurity.map((entry) => ({ ...entry })),
    windfalls: plan.windfalls.map((entry) => ({ ...entry })),
    activeStressors: stressors.map((item) => item.id),
  };

  stressors.forEach((stressor) => {
    if (stressor.id === 'layoff') {
      nextPlan.salaryEndDate = new Date(CURRENT_YEAR, 0, 1).toISOString();
      nextPlan.retirementYear = CURRENT_YEAR;
    }

    if (stressor.id === 'delayed_inheritance') {
      nextPlan.windfalls = nextPlan.windfalls.map((item) =>
        item.name === 'inheritance' ? { ...item, year: item.year + 5 } : item,
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

function applyResponses(plan: SimPlan, responses: ResponseOption[]) {
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
      const cut = response.optionalReductionPercent ?? 20;
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

function getAssetExposure(symbol: string) {
  return getHoldingExposure(symbol);
}

function getBucketReturn(
  allocation: Record<string, number>,
  assetReturns: Record<AssetClass, number>,
) {
  return Object.entries(allocation).reduce((total, [symbol, weight]) => {
    const exposure = getAssetExposure(symbol);
    const symbolReturn = Object.entries(exposure).reduce(
      (innerTotal, [assetClass, assetWeight]) =>
        innerTotal + (assetReturns[assetClass as AssetClass] ?? 0) * assetWeight,
      0,
    );

    return total + symbolReturn * weight;
  }, 0);
}

function getDefenseScore(allocation: Record<string, number>) {
  return Object.entries(allocation).reduce((total, [symbol, weight]) => {
    const exposure = getAssetExposure(symbol);
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

function createBaseYearTaxInputs(
  filingStatus: string,
  wages: number,
  socialSecurityBenefits: number,
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

function getStressAdjustedReturns(
  plan: SimPlan,
  assumptions: MarketAssumptions,
  yearOffset: number,
  random: RandomSource,
) {
  let inflation = boundedNormal(
    assumptions.inflation,
    assumptions.inflationVolatility,
    -0.02,
    0.12,
    random,
  );

  const assetReturns: Record<AssetClass, number> = {
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
  const path: MarketPathPoint[] = [];
  for (let yearOffset = 0; yearOffset < horizonYears; yearOffset += 1) {
    path.push(getStressAdjustedReturns(plan, assumptions, yearOffset, random));
  }
  return path;
}

function sumBalances(balances: Record<AccountBucketType, number>) {
  return SIM_BUCKETS.reduce((total, bucket) => total + balances[bucket], 0);
}

const DEFAULT_TAXABLE_WITHDRAWAL_LTCG_RATIO = 0.25;
const DEFAULT_BASELINE_ACA_PREMIUM_ANNUAL = 14_400;
const DEFAULT_BASELINE_MEDICARE_PREMIUM_ANNUAL = 2_220;
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
    acaAwareWithdrawalOptimization: false,
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

    const rightScore = getDefenseScore(plan.accounts[right].targetAllocation);
    const leftScore = getDefenseScore(plan.accounts[left].targetAllocation);
    return rightScore - leftScore;
  });

  const ordered: AccountBucketType[] = ['cash', ...base];
  if (balances.roth > 0) {
    ordered.push('roth');
  }
  return ordered;
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

    if (bucket === 'pretax' && strategy.irmaaAwareWithdrawalBuffer && balances.roth > 0) {
      const room = Math.max(assumptions.irmaaThreshold - taxResult.MAGI, 0);
      const bufferedTake = Math.min(balances.pretax, room, remaining);
      if (bufferedTake > 0) {
        balances.pretax -= bufferedTake;
        withdrawals.pretax += bufferedTake;
        taxInputs.ira401kWithdrawals += bufferedTake;
        recalculateTax();
        remaining -= bufferedTake;
      }

      if (remaining > 0 && strategy.preserveRothPreference) {
        const rothTake = Math.min(balances.roth, remaining);
        balances.roth -= rothTake;
        withdrawals.roth += rothTake;
        taxInputs.rothWithdrawals += rothTake;
        recalculateTax();
        remaining -= rothTake;
      }
    }

    if (remaining <= 0) {
      return;
    }

    const available = balances[bucket];
    if (available <= 0) {
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

  return { remaining, withdrawals, taxInputs, taxResult, rmdWithdrawn };
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
  stressors,
  responses,
  strategy,
}: {
  assumptions: MarketAssumptions;
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
    },
    rothConversionPolicy: {
      proactiveConversionsEnabled: false,
      description:
        'Simulation engine v1 does not run proactive Roth conversions; conversions are modeled in autopilot planning mode.',
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
}: {
  yearlySeries: PathYearResult[];
  failureYearDistribution: Array<{ year: number; count: number; rate: number }>;
}): SimulationModeDiagnostics {
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
    taxesPaidPath: yearlySeries.map((point) => ({
      year: point.year,
      value: point.medianFederalTax,
    })),
    magiPath: yearlySeries.map((point) => ({
      year: point.year,
      value: point.medianMagi,
    })),
    conversionPath: yearlySeries.map((point) => ({
      year: point.year,
      value: point.medianRothConversion,
    })),
    failureYearDistribution,
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
  const stressedPlan = applyStressors(basePlan, stressors);
  const effectivePlan = applyResponses(stressedPlan, responses);
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
      let inflationIndex = 1;
      let homeSaleDependent = false;
      let inheritanceDependent = false;
      let irmaaTriggered = false;
      let rothDepletedEarly = false;
      let rothWasPositive = balances.roth > 0;
      const yearly: RunTrace[] = [];
      const magiHistory = new Map<number, number>();
      const marketPath = buildYearlyMarketPath(
        effectivePlan,
        assumptions,
        planningHorizonYears,
        random,
      );

      for (let year = effectivePlan.startYear; year <= effectivePlan.planningEndYear; year += 1) {
        throwIfSimulationCancelled(options?.isCancelled);

        const yearOffset = year - effectivePlan.startYear;
        const robAge = ages.rob + yearOffset;
        const debbieAge = ages.debbie + yearOffset;
        const isRetired = year >= effectivePlan.retirementYear;
        const marketPoint =
          marketPath[yearOffset] ??
          getStressAdjustedReturns(effectivePlan, assumptions, yearOffset, random);
        const { inflation, assetReturns, marketState } = marketPoint;
        const pretaxBalanceForRmd = balances.pretax;

        const totalAssetsAtStart = sumBalances(balances);
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
            hsa: data.accounts.hsa?.balance,
          },
        });
        balances.pretax = contributionResult.updatedAccountBalances.pretax;
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
            },
            {
              birthDate: data.household.debbieBirthDate,
              age: debbieAge,
              accountShare: 0.5,
            },
          ],
        });

        const windfalls = effectivePlan.windfalls.filter((item) => item.year === year);
        const windfallIncome = windfalls.reduce((total, item) => total + item.amount, 0);
        windfalls.forEach((item) => {
          const yearsFundedBeforeEvent = totalAssetsAtStart / Math.max(spendingBeforeHealthcare, 1);
          if (item.name === 'home_sale' && yearsFundedBeforeEvent < 5) {
            homeSaleDependent = true;
          }
          if (item.name === 'inheritance' && yearsFundedBeforeEvent < 5) {
            inheritanceDependent = true;
          }
        });

        SIM_BUCKETS.forEach((bucket) => {
          balances[bucket] *=
            1 + getBucketReturn(effectivePlan.accounts[bucket].targetAllocation, assetReturns);
        });

        balances.cash += windfallIncome;
        const baseIncome = adjustedWages + socialSecurityIncome + windfallIncome;
        const shortfallBeforeHealthcare = Math.max(spendingBeforeHealthcare - baseIncome, 0);
        const baseTaxInputs = createBaseYearTaxInputs(
          data.household.filingStatus,
          adjustedWages,
          socialSecurityIncome,
        );
        const balancesBeforeWithdrawal = { ...balances };
        const medicareEligibilityByPerson = [robAge >= 65, debbieAge >= 65];
        const medicareEligibleCount = medicareEligibilityByPerson.filter(Boolean).length;

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
          );
          return {
            endingBalances: attemptBalances,
            result: attemptResult,
          };
        };

        const baseHealthcareInputs = {
          agesByYear: [robAge, debbieAge],
          filingStatus: data.household.filingStatus,
          retirementStatus: isRetired,
          medicareEligibilityByPerson,
          baselineAcaPremiumAnnual:
            effectivePlan.healthcarePremiums.baselineAcaPremiumAnnual * inflationIndex,
          baselineMedicarePremiumAnnual:
            effectivePlan.healthcarePremiums.baselineMedicarePremiumAnnual * inflationIndex,
        };

        const firstAttempt = runWithdrawalAttempt(shortfallBeforeHealthcare);
        const firstAttemptMagi = firstAttempt.result.taxResult.MAGI;
        const firstAttemptIrmaaReference =
          magiHistory.get(year - DEFAULT_IRMAA_CONFIG.lookbackYears) ?? firstAttemptMagi;
        const firstAttemptIrmaaTier = calculateIrmaaTier(
          firstAttemptIrmaaReference,
          data.household.filingStatus,
        );
        const firstAttemptHealthcare = calculateHealthcarePremiums({
          ...baseHealthcareInputs,
          MAGI: firstAttemptMagi,
          irmaaSurchargeAnnualPerEligible: firstAttemptIrmaaTier.surchargeAnnual,
        });

        const secondAttemptNeeded =
          shortfallBeforeHealthcare + firstAttemptHealthcare.totalHealthcarePremiumCost;
        const secondAttempt = runWithdrawalAttempt(secondAttemptNeeded);
        const secondAttemptMagi = secondAttempt.result.taxResult.MAGI;
        const secondAttemptIrmaaReference =
          magiHistory.get(year - DEFAULT_IRMAA_CONFIG.lookbackYears) ?? secondAttemptMagi;
        const secondAttemptIrmaaTier = calculateIrmaaTier(
          secondAttemptIrmaaReference,
          data.household.filingStatus,
        );
        const secondAttemptHealthcare = calculateHealthcarePremiums({
          ...baseHealthcareInputs,
          MAGI: secondAttemptMagi,
          irmaaSurchargeAnnualPerEligible: secondAttemptIrmaaTier.surchargeAnnual,
        });

        const needsThirdAttempt =
          Math.abs(
            secondAttemptHealthcare.totalHealthcarePremiumCost -
              firstAttemptHealthcare.totalHealthcarePremiumCost,
          ) >= 1;

        const finalAttempt = needsThirdAttempt
          ? runWithdrawalAttempt(
              shortfallBeforeHealthcare + secondAttemptHealthcare.totalHealthcarePremiumCost,
            )
          : secondAttempt;
        const magiForYear = finalAttempt.result.taxResult.MAGI;
        const irmaaReferenceMagi =
          magiHistory.get(year - DEFAULT_IRMAA_CONFIG.lookbackYears) ?? magiForYear;
        const irmaaTier = calculateIrmaaTier(irmaaReferenceMagi, data.household.filingStatus);
        const healthcarePremiums = calculateHealthcarePremiums({
          ...baseHealthcareInputs,
          MAGI: magiForYear,
          irmaaSurchargeAnnualPerEligible: irmaaTier.surchargeAnnual,
        });

        balances.pretax = finalAttempt.endingBalances.pretax;
        balances.roth = finalAttempt.endingBalances.roth;
        balances.taxable = finalAttempt.endingBalances.taxable;
        balances.cash = finalAttempt.endingBalances.cash;

        const withdrawalResult = finalAttempt.result;
        const federalTaxForYear = withdrawalResult.taxResult.federalTax;
        magiHistory.set(year, magiForYear);
        const spending =
          spendingBeforeHealthcare + healthcarePremiums.totalHealthcarePremiumCost;
        const annualMedicareSurcharge = healthcarePremiums.irmaaSurcharge;
        const medicarePremiumEstimate = healthcarePremiums.medicarePremiumEstimate;
        const income = baseIncome + withdrawalResult.rmdWithdrawn;

        if (irmaaTier.tier > 1 && medicareEligibleCount > 0) {
          irmaaTriggered = true;
        }

        if (rothWasPositive && balances.roth <= 1 && robAge < 75) {
          rothDepletedEarly = true;
        }
        rothWasPositive = balances.roth > 1;

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
          rothConversion: 0,
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
        });

        if (!yearlyBuckets.has(year)) {
          yearlyBuckets.set(year, []);
        }
        yearlyBuckets.get(year)?.push(yearly[yearly.length - 1]);

        if (withdrawalResult.remaining > 0 || endingAssets <= 0) {
          failureYear = year;
          failureReason =
            spending <=
            effectivePlan.essentialAnnual * inflationIndex +
              effectivePlan.taxesInsuranceAnnual * inflationIndex +
              healthcarePremiums.totalHealthcarePremiumCost
              ? 'essential spending can no longer be covered from the remaining assets'
              : marketState === 'down'
                ? 'sequence risk forces withdrawals after a weak early market'
                : salary <= 0 && year <= effectivePlan.retirementYear + 1
                  ? 'income ends before the portfolio is ready to fully carry spending'
                  : 'assets run short before the end of the planning horizon';
          break;
        }

        inflationIndex *= 1 + inflation;
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
        failureReason,
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
    stressors,
    responses,
    strategy: strategyBehavior,
  });
  const simulationDiagnostics = buildSimulationModeDiagnostics({
    yearlySeries,
    failureYearDistribution: monteCarlo.failureYearDistribution,
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
      strategyMode: options?.strategyMode,
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
  options?: Pick<SimulationExecutionOptions, 'isCancelled'> & {
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
