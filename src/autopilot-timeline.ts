import { calculatePreRetirementContributions } from './contribution-engine';
import { calculateHealthcarePremiums } from './healthcare-premium-engine';
import {
  calculateIrmaaTier,
  calculateRequiredMinimumDistribution,
  DEFAULT_IRMAA_CONFIG,
} from './retirement-rules';
import {
  solveSpendByReverseTimeline,
  type SpendSolverResult,
  type SpendSolverSuccessRange,
} from './spend-solver';
import { calculateFederalTax, DEFAULT_TAX_ENGINE_CONFIG, type FilingStatus } from './tax-engine';
import type {
  MarketAssumptions,
  ResponseOption,
  SeedData,
  SocialSecurityEntry,
  Stressor,
  WindfallTaxTreatment,
} from './types';
import { calculateCurrentAges, getRetirementHorizonYears } from './utils';

const CURRENT_DATE = new Date('2026-04-16T12:00:00Z');
const CURRENT_YEAR = CURRENT_DATE.getUTCFullYear();
const TAXABLE_WITHDRAWAL_LTCG_RATIO = 0.25;
const DEFAULT_BASELINE_ACA_PREMIUM_ANNUAL = 14_400;
const DEFAULT_BASELINE_MEDICARE_PREMIUM_ANNUAL = 2_220;
const DEFAULT_MEDICAL_INFLATION_ANNUAL = 0.055;
const DEFAULT_HSA_HIGH_MAGI_THRESHOLD = 200_000;
const DEFAULT_LTC_INFLATION_ANNUAL = 0.055;

type Bucket = 'cash' | 'taxable' | 'pretax' | 'roth';
type AutopilotRegime = 'standard' | 'aca_bridge';
export type ConstraintCategory =
  | 'success_rate_floor'
  | 'legacy_target'
  | 'aca_headroom'
  | 'irmaa_headroom'
  | 'tax_burden'
  | 'liquidity_floor'
  | 'do_not_sell_primary_residence'
  | 'rmd_forced_income';
export type TradeoffTag =
  | 'spend_reduced_for_success'
  | 'spend_reduced_for_legacy'
  | 'conversion_reduced_for_aca'
  | 'conversion_reduced_for_irmaa'
  | 'taxable_used_to_protect_aca'
  | 'roth_used_to_preserve_liquidity'
  | 'ira_used_due_to_taxable_depletion'
  | 'home_sale_disabled_by_stressor'
  | 'rmd_forced_higher_magi';
export type TradeoffSeverity = 'low' | 'medium' | 'high';
export type DiagnosticPrimaryFundingSource = 'cash' | 'taxable' | 'ira_401k' | 'roth' | 'none';
export type YearDiagnosticWarningFlag =
  | 'avoidable_aca_breach'
  | 'irmaa_surcharge'
  | 'early_taxable_depletion'
  | 'liquidity_floor_pressure';
export type PlanDiagnosticWarningFlag =
  | 'avoidable_aca_breach_detected'
  | 'irmaa_surcharge_detected'
  | 'early_taxable_depletion_detected'
  | 'liquidity_floor_pressure_detected'
  | 'legacy_target_appears_binding'
  | 'success_floor_pressure_detected';
export type AcaExplanationFlag =
  | 'preserved_aca_subsidy'
  | 'used_taxable_to_protect_aca'
  | 'reduced_conversion_for_aca'
  | 'avoidable_aca_breach'
  | 'unavoidable_aca_breach';

export interface ConstraintTradeoff {
  category: ConstraintCategory;
  severity: TradeoffSeverity;
  summary: string;
  impact: string;
  possibleFutureLevers: string[];
  tags: TradeoffTag[];
}

export interface AutopilotYearDiagnostics {
  primaryFundingSource: DiagnosticPrimaryFundingSource;
  regime: AutopilotRegime;
  warningFlags: YearDiagnosticWarningFlag[];
  bindingConstraint: ConstraintCategory;
  explanationTags: Array<AcaExplanationFlag | TradeoffTag>;
}

export interface PlanDiagnosticsSummary {
  totalAcaBridgeYears: number;
  acaSafeYears: number;
  acaBreachYears: number;
  avoidableAcaBreachYears: number;
  irmaaSurchargeYears: number;
  yearsWithRothConversions: number;
  yearsWithRmds: number;
  yearsFundedPrimarilyByCash: number;
  yearsFundedPrimarilyByTaxable: number;
  yearsFundedPrimarilyByIra401k: number;
  yearsFundedPrimarilyByRoth: number;
  warningFlags: PlanDiagnosticWarningFlag[];
}

export interface AutopilotPlanInputs {
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
  doNotSellPrimaryResidence?: boolean;
  precomputedSpendSolver?: SpendSolverResult;
  solverRuntimeBudget?: {
    searchSimulationRuns?: number;
    finalSimulationRuns?: number;
    maxIterations?: number;
    diagnosticsMode?: 'core' | 'full';
    enableSuccessRelaxationProbe?: boolean;
  };
}

export interface AutopilotYearPlan {
  year: number;
  robAge: number;
  debbieAge: number;
  totalWealth: number;
  regime: AutopilotRegime;
  primaryBindingConstraint: ConstraintCategory;
  secondaryBindingConstraints: ConstraintCategory[];
  bindingConstraintExplanation: string;
  tradeoffChosen: string;
  tradeoffs: ConstraintTradeoff[];
  plannedAnnualSpend: number;
  withdrawalCash: number;
  withdrawalTaxable: number;
  withdrawalIra401k: number;
  withdrawalRoth: number;
  suggestedRothConversion: number;
  estimatedMAGI: number;
  estimatedFederalTax: number;
  irmaaStatus: string;
  irmaaHeadroom: number | null;
  acaStatus: string;
  acaHeadroom: number | null;
  acaFriendlyMagiCeiling: number | null;
  rmdAmount: number;
  explanationFlags: AcaExplanationFlag[];
  diagnostics: AutopilotYearDiagnostics;
  explanation: string;
}

export interface AutopilotPlanSummary {
  successRate: number;
  projectedLegacyOutcomeTodayDollars: number;
  primaryBindingConstraint: ConstraintCategory;
  supportingConstraints: ConstraintCategory[];
  bindingConstraintDescription: string;
  whatThisMeans: string;
  tradeoffs: ConstraintTradeoff[];
  bindingConstraint: string;
  routeSummary: string;
  tradeoffSummary: string;
}

export interface AutopilotPlanResult {
  summary: AutopilotPlanSummary;
  years: AutopilotYearPlan[];
  diagnostics: PlanDiagnosticsSummary;
  spendSolver: SpendSolverResult;
}

interface WorkingRouteContext {
  salaryAnnual: number;
  salaryEndDate: string;
  retirementYear: number;
  socialSecurity: SocialSecurityEntry[];
  windfalls: Array<{
    name: string;
    year: number;
    amount: number;
    taxTreatment?: WindfallTaxTreatment;
    liquidityAmount?: number;
    costBasis?: number;
    exclusionAmount?: number;
    distributionYears?: number;
  }>;
  filingStatus: FilingStatus;
  activeStressors: Stressor[];
  activeResponses: ResponseOption[];
  doNotSellPrimaryResidence: boolean;
}

interface WithdrawalState {
  cash: number;
  taxable: number;
  pretax: number;
  roth: number;
}

interface TaxState {
  ira401kWithdrawals: number;
  rothWithdrawals: number;
  realizedLTCG: number;
}

interface AcaBridgeYearPlan {
  year: number;
  regime: 'aca_bridge';
  nonPortfolioIncomeEstimate: number;
  acaFriendlyMagiCeiling: number;
  headroom: number;
  reservedConversionBudget: number;
}

interface YearConstraintAnalysis {
  primaryBindingConstraint: ConstraintCategory;
  secondaryBindingConstraints: ConstraintCategory[];
  bindingConstraintExplanation: string;
  tradeoffChosen: string;
  tradeoffs: ConstraintTradeoff[];
}

const roundMoney = (value: number) => Number(value.toFixed(2));
const CATEGORY_PRIORITY: Record<ConstraintCategory, number> = {
  success_rate_floor: 1,
  legacy_target: 2,
  aca_headroom: 3,
  irmaa_headroom: 4,
  tax_burden: 5,
  liquidity_floor: 6,
  do_not_sell_primary_residence: 7,
  rmd_forced_income: 8,
};
const SEVERITY_SCORE: Record<TradeoffSeverity, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

function dedupeConstraintCategories(items: ConstraintCategory[]) {
  return Array.from(new Set(items));
}

function mapSpendSolverBindingConstraintToCategory(bindingConstraint: string): ConstraintCategory {
  const normalized = bindingConstraint.toLowerCase();
  if (normalized.includes('legacy')) {
    return 'legacy_target';
  }
  if (normalized.includes('success')) {
    return 'success_rate_floor';
  }
  return 'success_rate_floor';
}

function selectTopConstraint(tradeoffs: ConstraintTradeoff[], fallback: ConstraintCategory) {
  if (!tradeoffs.length) {
    return fallback;
  }

  const sorted = [...tradeoffs].sort((a, b) => {
    const severityDiff = SEVERITY_SCORE[b.severity] - SEVERITY_SCORE[a.severity];
    if (severityDiff !== 0) {
      return severityDiff;
    }
    return CATEGORY_PRIORITY[a.category] - CATEGORY_PRIORITY[b.category];
  });

  return sorted[0].category;
}

function buildConstraintTexts(category: ConstraintCategory): {
  description: string;
  whatThisMeans: string;
} {
  if (category === 'legacy_target') {
    return {
      description: 'Legacy target is currently the primary limiter on spending flexibility.',
      whatThisMeans:
        'Spending growth, conversion pace, and withdrawal order are leaning conservative to protect ending wealth.',
    };
  }
  if (category === 'success_rate_floor') {
    return {
      description: 'Success-rate floor is currently the primary limiter on spending flexibility.',
      whatThisMeans:
        'The route favors durability over near-term lifestyle expansion to keep failure risk above guardrails.',
    };
  }
  if (category === 'aca_headroom') {
    return {
      description: 'ACA headroom is currently the primary limiter on income timing in bridge years.',
      whatThisMeans:
        'The route uses lower-MAGI sources first and trims conversions to preserve subsidy eligibility.',
    };
  }
  if (category === 'irmaa_headroom') {
    return {
      description: 'IRMAA headroom is currently the primary limiter on post-65 income timing.',
      whatThisMeans:
        'The route constrains income spikes and conversion activity to reduce Medicare surcharge exposure.',
    };
  }
  if (category === 'liquidity_floor') {
    return {
      description: 'Liquidity floor is currently the primary limiter on withdrawals.',
      whatThisMeans:
        'The route protects near-term liquid reserves, which can force tradeoffs in source selection and spend.',
    };
  }
  if (category === 'do_not_sell_primary_residence') {
    return {
      description: 'House-retention stressor is currently a primary flexibility constraint.',
      whatThisMeans:
        'Keeping home equity off-limits reduces available funding levers and narrows downside options.',
    };
  }
  if (category === 'rmd_forced_income') {
    return {
      description: 'RMD forced income is currently driving tax and threshold pressure.',
      whatThisMeans:
        'Required withdrawals can raise MAGI and limit flexibility even when discretionary spending is stable.',
    };
  }
  return {
    description: 'Tax burden is currently limiting route flexibility.',
    whatThisMeans:
      'The route is balancing withdrawals and conversion timing to manage annual tax drag.',
  };
}

function normalizeFilingStatus(value: string): FilingStatus {
  if (value === 'married_filing_jointly') {
    return value;
  }
  if (value === 'married_filing_separately') {
    return value;
  }
  if (value === 'head_of_household') {
    return value;
  }
  return 'single';
}

function shiftDateYears(value: string, years: number) {
  const next = new Date(value);
  next.setUTCFullYear(next.getUTCFullYear() + years);
  return next.toISOString();
}

function normalizeRouteContext(input: AutopilotPlanInputs): WorkingRouteContext {
  const stressorMap = new Map(input.data.stressors.map((item) => [item.id, item]));
  const responseMap = new Map(input.data.responses.map((item) => [item.id, item]));
  const activeStressors = input.selectedStressors
    .map((id) => stressorMap.get(id))
    .filter((item): item is Stressor => Boolean(item));
  let activeResponses = input.selectedResponses
    .map((id) => responseMap.get(id))
    .filter((item): item is ResponseOption => Boolean(item));

  const doNotSellPrimaryResidence = Boolean(input.doNotSellPrimaryResidence);
  if (doNotSellPrimaryResidence) {
    activeResponses = activeResponses.filter((item) => item.id !== 'sell_home_early');
  }

  let salaryEndDate = input.data.income.salaryEndDate;
  let retirementYear = new Date(salaryEndDate).getUTCFullYear();
  let socialSecurity = input.data.income.socialSecurity.map((entry) => ({ ...entry }));
  let windfalls = input.data.income.windfalls.map((entry) => ({ ...entry }));

  activeStressors.forEach((stressor) => {
    if (stressor.id === 'layoff') {
      salaryEndDate = new Date(Date.UTC(CURRENT_YEAR, 0, 1)).toISOString();
      retirementYear = CURRENT_YEAR;
    }
    if (stressor.id === 'delayed_inheritance') {
      windfalls = windfalls.map((item) =>
        item.name === 'inheritance' ? { ...item, year: item.year + 5 } : item,
      );
    }
  });

  activeResponses.forEach((response) => {
    if (response.id === 'delay_retirement') {
      const years = response.delayYears ?? 1;
      salaryEndDate = shiftDateYears(salaryEndDate, years);
      retirementYear += years;
    }
    if (response.id === 'early_ss' && response.claimAge) {
      socialSecurity = socialSecurity.map((entry) => ({
        ...entry,
        claimAge: Math.min(entry.claimAge, response.claimAge!),
      }));
    }
    if (response.id === 'sell_home_early') {
      windfalls = windfalls.map((item) =>
        item.name === 'home_sale'
          ? { ...item, year: CURRENT_YEAR + (response.triggerYear ?? 3) }
          : item,
      );
    }
  });

  if (doNotSellPrimaryResidence) {
    windfalls = windfalls.map((item) =>
      item.name === 'home_sale'
        ? {
            ...item,
            amount: 0,
          }
        : item,
    );
  }

  return {
    salaryAnnual: input.data.income.salaryAnnual,
    salaryEndDate,
    retirementYear,
    socialSecurity,
    windfalls,
    filingStatus: normalizeFilingStatus(input.data.household.filingStatus),
    activeStressors,
    activeResponses,
    doNotSellPrimaryResidence,
  };
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

function getSalaryForYear(route: WorkingRouteContext, year: number) {
  const endDate = new Date(route.salaryEndDate);
  const endYear = endDate.getUTCFullYear();
  if (year < endYear) {
    return route.salaryAnnual;
  }
  if (year > endYear) {
    return 0;
  }
  const monthFraction = endDate.getUTCMonth() / 12;
  return route.salaryAnnual * monthFraction;
}

function getSocialSecurityIncome(
  route: WorkingRouteContext,
  yearOffset: number,
  inflationIndex: number,
  ages: { rob: number; debbie: number },
) {
  return route.socialSecurity.reduce((total, entry) => {
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

function inferWindfallTaxTreatment(
  windfall: WorkingRouteContext['windfalls'][number],
): WindfallTaxTreatment {
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

function getDefaultPrimaryHomeSaleExclusion(filingStatus: FilingStatus) {
  return filingStatus === 'married_filing_jointly' ? 500_000 : 250_000;
}

function buildWindfallRealizationForYear(
  windfall: WorkingRouteContext['windfalls'][number],
  year: number,
  filingStatus: FilingStatus,
): WindfallRealization {
  const treatment = inferWindfallTaxTreatment(windfall);
  const amount = Math.max(0, windfall.amount);
  const liquidityAmount = Math.max(0, windfall.liquidityAmount ?? amount);
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

function calculateLtcCostForYear(input: {
  rules: SeedData['rules'];
  ages: { rob: number; debbie: number };
}) {
  const ltc = input.rules.ltcAssumptions;
  if (!ltc?.enabled || ltc.annualCostToday <= 0) {
    return 0;
  }
  const householdAge = Math.max(input.ages.rob, input.ages.debbie);
  if (householdAge < ltc.startAge) {
    return 0;
  }
  const yearsIntoLtc = householdAge - ltc.startAge;
  if (yearsIntoLtc >= Math.max(1, Math.round(ltc.durationYears))) {
    return 0;
  }
  const inflationAnnual = ltc.inflationAnnual ?? DEFAULT_LTC_INFLATION_ANNUAL;
  const eventProbability = Math.max(0, Math.min(1, ltc.eventProbability ?? 0.45));
  return ltc.annualCostToday * Math.pow(1 + inflationAnnual, yearsIntoLtc) * eventProbability;
}

function calculateHsaOffsetForYear(input: {
  rules: SeedData['rules'];
  hsaBalance: number;
  magi: number;
  healthcareAndLtcCost: number;
}) {
  const strategy = input.rules.hsaStrategy;
  if (!strategy?.enabled || input.hsaBalance <= 0 || input.healthcareAndLtcCost <= 0) {
    return 0;
  }
  const threshold = strategy.highMagiThreshold ?? DEFAULT_HSA_HIGH_MAGI_THRESHOLD;
  if (strategy.prioritizeHighMagiYears && input.magi < threshold) {
    return 0;
  }
  const cap = Math.max(
    0,
    strategy.annualQualifiedExpenseWithdrawalCap ?? Number.POSITIVE_INFINITY,
  );
  const cappedNeed = Number.isFinite(cap)
    ? Math.min(input.healthcareAndLtcCost, cap)
    : input.healthcareAndLtcCost;
  return Math.min(input.hsaBalance, cappedNeed);
}

function getYearInflationRate(
  assumptions: MarketAssumptions,
  yearOffset: number,
  activeStressors: Stressor[],
) {
  const hasInflationStress = activeStressors.some((item) => item.id === 'inflation');
  if (hasInflationStress && yearOffset < 10) {
    return Math.max(assumptions.inflation, 0.05);
  }
  return assumptions.inflation;
}

function getBucketReturn(
  bucket: Bucket,
  assumptions: MarketAssumptions,
  yearOffset: number,
  activeStressors: Stressor[],
) {
  let equity = assumptions.equityMean;
  let international = assumptions.internationalEquityMean;
  let bonds = assumptions.bondMean;
  const cash = assumptions.cashMean;

  const hasMarketDown = activeStressors.some((item) => item.id === 'market_down');
  const hasMarketUp = activeStressors.some((item) => item.id === 'market_up');

  if (hasMarketDown && yearOffset < 3) {
    const overrides = [-0.18, -0.12, -0.08];
    equity = overrides[yearOffset];
    international = overrides[yearOffset] - 0.02;
    bonds = Math.max(-0.05, assumptions.bondMean - 0.02);
  } else if (hasMarketDown && yearOffset < 8) {
    equity += 0.04;
    international += 0.03;
  }

  if (hasMarketUp && yearOffset < 3) {
    const overrides = [0.12, 0.1, 0.08];
    equity = overrides[yearOffset];
    international = overrides[yearOffset] - 0.01;
    bonds += 0.005;
  }

  if (bucket === 'cash') {
    return cash;
  }
  if (bucket === 'taxable') {
    return equity * 0.5 + international * 0.2 + bonds * 0.25 + cash * 0.05;
  }
  if (bucket === 'pretax') {
    return equity * 0.55 + international * 0.25 + bonds * 0.18 + cash * 0.02;
  }
  return equity * 0.7 + international * 0.2 + bonds * 0.09 + cash * 0.01;
}

function applyDeterministicGrowth(
  balances: Record<Bucket, number>,
  assumptions: MarketAssumptions,
  yearOffset: number,
  activeStressors: Stressor[],
) {
  (['cash', 'taxable', 'pretax', 'roth'] as Bucket[]).forEach((bucket) => {
    const growth = getBucketReturn(bucket, assumptions, yearOffset, activeStressors);
    balances[bucket] *= 1 + growth;
    if (!Number.isFinite(balances[bucket]) || balances[bucket] < 0) {
      balances[bucket] = 0;
    }
  });
}

function getAcaCliffIncome(filingStatus: FilingStatus) {
  const fplByHouseholdSize = {
    1: 15_650,
    2: 21_150,
  };
  const householdSize = filingStatus === 'married_filing_jointly' ? 2 : 1;
  return (fplByHouseholdSize[householdSize] ?? fplByHouseholdSize[1]) * 4;
}

function getIrmaaHeadroom(referenceMagi: number, filingStatus: FilingStatus) {
  const brackets = DEFAULT_IRMAA_CONFIG.brackets[filingStatus];
  const index = brackets.findIndex((bracket) => referenceMagi <= bracket.maxMagi);
  if (index < 0) {
    return null;
  }
  const nextBracket = brackets[index + 1];
  if (!nextBracket || !Number.isFinite(nextBracket.maxMagi)) {
    return null;
  }
  return Math.max(0, nextBracket.maxMagi - referenceMagi);
}

function getCashReserveFloor(plannedAnnualSpend: number) {
  return Math.max(10_000, plannedAnnualSpend * 0.35);
}

interface WithdrawOptions {
  cashReserveFloor: number;
  maxPretaxWithdrawalsTotal?: number;
  taxableLtcgRatio: number;
}

function withdrawForNeed(
  amountNeeded: number,
  order: Bucket[],
  balances: Record<Bucket, number>,
  withdrawals: WithdrawalState,
  taxState: TaxState,
  options: WithdrawOptions,
) {
  let remaining = Math.max(0, amountNeeded);

  order.forEach((bucket) => {
    if (remaining <= 0) {
      return;
    }

    let available = balances[bucket];
    if (bucket === 'cash') {
      available = Math.max(0, balances.cash - options.cashReserveFloor);
    }

    if (bucket === 'pretax' && typeof options.maxPretaxWithdrawalsTotal === 'number') {
      const pretaxRoom = Math.max(0, options.maxPretaxWithdrawalsTotal - withdrawals.pretax);
      available = Math.min(available, pretaxRoom);
    }

    if (available <= 0) {
      return;
    }

    const take = Math.min(available, remaining);
    if (take <= 0) {
      return;
    }

    balances[bucket] -= take;
    remaining -= take;

    if (bucket === 'cash') {
      withdrawals.cash += take;
      return;
    }
    if (bucket === 'taxable') {
      withdrawals.taxable += take;
      taxState.realizedLTCG += take * options.taxableLtcgRatio;
      return;
    }
    if (bucket === 'pretax') {
      withdrawals.pretax += take;
      taxState.ira401kWithdrawals += take;
      return;
    }
    withdrawals.roth += take;
    taxState.rothWithdrawals += take;
  });

  return remaining;
}

function buildAcaBridgePlan(
  input: AutopilotPlanInputs,
  route: WorkingRouteContext,
  ages: { rob: number; debbie: number },
  endYear: number,
) {
  const yearlySnapshots: Array<{
    year: number;
    robAge: number;
    debbieAge: number;
    isRetired: boolean;
    isLowEarnedIncome: boolean;
    hasNonMedicareMembers: boolean;
    inflationIndex: number;
    nonPortfolioIncomeEstimate: number;
    acaFriendlyMagiCeiling: number;
    headroom: number;
  }> = [];
  let inflationIndex = 1;

  for (let year = CURRENT_YEAR; year <= endYear; year += 1) {
    const yearOffset = year - CURRENT_YEAR;
    const robAge = ages.rob + yearOffset;
    const debbieAge = ages.debbie + yearOffset;
    const salary = getSalaryForYear(route, year);
    const isRetired = year >= route.retirementYear;
    const isLowEarnedIncome = salary <= route.salaryAnnual * 0.35;
    const hasNonMedicareMembers = robAge < 65 || debbieAge < 65;
    const socialSecurityIncome = getSocialSecurityIncome(
      route,
      yearOffset,
      inflationIndex,
      { rob: robAge, debbie: debbieAge },
    );
    const windfallRealizations = route.windfalls.map((item) =>
      buildWindfallRealizationForYear(item, year, route.filingStatus),
    );
    const windfallTaxableIncome = windfallRealizations.reduce(
      (sum, item) => sum + item.ordinaryIncome + item.ltcgIncome,
      0,
    );
    const nonPortfolioIncomeEstimate = salary + socialSecurityIncome + windfallTaxableIncome;
    const acaFriendlyMagiCeiling = Math.max(
      0,
      getAcaCliffIncome(route.filingStatus) * inflationIndex - 2_000,
    );
    const headroom = Math.max(0, acaFriendlyMagiCeiling - nonPortfolioIncomeEstimate);

    yearlySnapshots.push({
      year,
      robAge,
      debbieAge,
      isRetired,
      isLowEarnedIncome,
      hasNonMedicareMembers,
      inflationIndex,
      nonPortfolioIncomeEstimate,
      acaFriendlyMagiCeiling,
      headroom,
    });

    const inflationRate = getYearInflationRate(
      input.assumptions,
      yearOffset,
      route.activeStressors,
    );
    inflationIndex *= 1 + inflationRate;
  }

  const bridgeStart = yearlySnapshots.find(
    (year) =>
      year.hasNonMedicareMembers &&
      (year.isRetired || year.isLowEarnedIncome),
  )?.year;

  if (!bridgeStart) {
    return new Map<number, AcaBridgeYearPlan>();
  }

  const bridgeYears = yearlySnapshots.filter(
    (year) => year.year >= bridgeStart && year.hasNonMedicareMembers,
  );
  const totalHeadroom = bridgeYears.reduce((sum, year) => sum + year.headroom, 0);
  const planByYear = new Map<number, AcaBridgeYearPlan>();
  let remainingHeadroom = totalHeadroom;

  bridgeYears.forEach((year, index) => {
    const remainingYears = bridgeYears.length - index;
    const targetPerRemainingYear =
      remainingYears > 0 ? remainingHeadroom / remainingYears : 0;
    const reservedConversionBudget = Math.max(
      0,
      Math.min(year.headroom, targetPerRemainingYear),
    );
    remainingHeadroom = Math.max(0, remainingHeadroom - reservedConversionBudget);

    planByYear.set(year.year, {
      year: year.year,
      regime: 'aca_bridge',
      nonPortfolioIncomeEstimate: roundMoney(year.nonPortfolioIncomeEstimate),
      acaFriendlyMagiCeiling: roundMoney(year.acaFriendlyMagiCeiling),
      headroom: roundMoney(year.headroom),
      reservedConversionBudget: roundMoney(reservedConversionBudget),
    });
  });

  return planByYear;
}

function determineRothConversion({
  taxEstimateWithoutWithdrawals,
  filingStatus,
  isRetired,
  hasPretaxBalance,
  hasNonMedicareMembers,
  hasMedicareMembers,
  iraaReferenceMagi,
}: {
  taxEstimateWithoutWithdrawals: ReturnType<typeof calculateFederalTax>;
  filingStatus: FilingStatus;
  isRetired: boolean;
  hasPretaxBalance: boolean;
  hasNonMedicareMembers: boolean;
  hasMedicareMembers: boolean;
  iraaReferenceMagi: number;
}) {
  if (!isRetired || !hasPretaxBalance) {
    return 0;
  }

  const ordinaryBrackets = DEFAULT_TAX_ENGINE_CONFIG.profiles[filingStatus].ordinaryBrackets;
  const targetOrdinaryTop = ordinaryBrackets[Math.min(1, ordinaryBrackets.length - 1)]?.upTo ?? 0;
  const ordinaryRoom = Math.max(0, targetOrdinaryTop - taxEstimateWithoutWithdrawals.ordinaryTaxableIncome);

  let thresholdRoom = Number.POSITIVE_INFINITY;
  if (hasNonMedicareMembers) {
    const acaCap = getAcaCliffIncome(filingStatus) - 2_000;
    thresholdRoom = Math.min(thresholdRoom, Math.max(0, acaCap - taxEstimateWithoutWithdrawals.MAGI));
  }
  if (hasMedicareMembers) {
    const irmaaTier1Cap =
      DEFAULT_IRMAA_CONFIG.brackets[filingStatus][0]?.maxMagi ?? Number.POSITIVE_INFINITY;
    thresholdRoom = Math.min(thresholdRoom, Math.max(0, irmaaTier1Cap - 3_000 - iraaReferenceMagi));
  }

  const raw = Math.min(ordinaryRoom, thresholdRoom, 40_000);
  return roundMoney(Math.max(0, raw));
}

export function classifyAcaBridgeBreach({
  estimatedMagi,
  acaFriendlyMagiCeiling,
  baselineMagi,
  rmdAmount,
  lowMagiFundingCapacityAtStart,
}: {
  estimatedMagi: number;
  acaFriendlyMagiCeiling: number;
  baselineMagi: number;
  rmdAmount: number;
  lowMagiFundingCapacityAtStart: number;
}): 'preserved_aca_subsidy' | 'avoidable_aca_breach' | 'unavoidable_aca_breach' {
  const excessMagi = estimatedMagi - acaFriendlyMagiCeiling;
  if (excessMagi <= 1) {
    return 'preserved_aca_subsidy';
  }

  const mandatoryMagiFloor = baselineMagi + rmdAmount;
  const hasDiscretionaryMagiRoom = mandatoryMagiFloor <= acaFriendlyMagiCeiling + 1;
  if (hasDiscretionaryMagiRoom && lowMagiFundingCapacityAtStart > 1_000) {
    return 'avoidable_aca_breach';
  }
  return 'unavoidable_aca_breach';
}

function buildExplanation({
  regime,
  doNotSellPrimaryResidence,
  explanationFlags,
  taxableWithdrawal,
  pretaxWithdrawal,
  rmdAmount,
  rothConversion,
  acaFriendlyMagiCeiling,
  estimatedMagi,
}: {
  regime: AutopilotRegime;
  doNotSellPrimaryResidence: boolean;
  explanationFlags: AcaExplanationFlag[];
  taxableWithdrawal: number;
  pretaxWithdrawal: number;
  rmdAmount: number;
  rothConversion: number;
  acaFriendlyMagiCeiling: number | null;
  estimatedMagi: number;
}) {
  const reasons: string[] = [];

  if (doNotSellPrimaryResidence) {
    reasons.push('House retained per active stressor');
  }

  if (regime === 'aca_bridge') {
    if (explanationFlags.includes('preserved_aca_subsidy')) {
      reasons.push(
        'ACA subsidy eligibility was preserved across the bridge using income-budgeted withdrawals',
      );
    }
    if (explanationFlags.includes('used_taxable_to_protect_aca')) {
      reasons.push('Using taxable assets to protect ACA subsidy eligibility');
    }
    if (explanationFlags.includes('reduced_conversion_for_aca')) {
      reasons.push('Reduced Roth conversion to stay within ACA-friendly MAGI budget');
    }
    if (explanationFlags.includes('avoidable_aca_breach')) {
      reasons.push(
        'ACA threshold was breached and this breach is flagged as avoidable under available liquidity',
      );
    }
    if (explanationFlags.includes('unavoidable_aca_breach')) {
      reasons.push(
        'ACA threshold was breached and is flagged as unavoidable given required income sources',
      );
    }
    if (
      acaFriendlyMagiCeiling !== null &&
      estimatedMagi > acaFriendlyMagiCeiling &&
      !explanationFlags.includes('avoidable_aca_breach') &&
      !explanationFlags.includes('unavoidable_aca_breach')
    ) {
      reasons.push('ACA threshold was breached intentionally to support required spending');
    }
  }

  if (rmdAmount > 0) {
    reasons.push('RMD required this year');
  }
  if (rothConversion > 0 && !explanationFlags.includes('reduced_conversion_for_aca')) {
    reasons.push('Applying measured Roth conversion to reduce future RMD pressure');
  }
  if (pretaxWithdrawal > taxableWithdrawal && rmdAmount <= 1) {
    reasons.push('Beginning IRA withdrawals due to reduced non-IRA funding room');
  }

  if (!reasons.length) {
    reasons.push('Route balances spending, taxes, healthcare thresholds, and liquidity');
  }

  return reasons.join('. ');
}

function buildCategoryLevers(category: ConstraintCategory): string[] {
  if (category === 'aca_headroom') {
    return ['reduce_spend', 'increase_taxable_bridge', 'change_conversion_pattern'];
  }
  if (category === 'irmaa_headroom') {
    return ['smooth_income', 'delay_conversions', 'shift_withdrawal_mix'];
  }
  if (category === 'legacy_target') {
    return ['reduce_spend', 'delay_retirement', 'increase_equity_glidepath'];
  }
  if (category === 'success_rate_floor') {
    return ['reduce_spend', 'increase_cash_buffer', 'delay_retirement'];
  }
  if (category === 'tax_burden') {
    return ['shift_withdrawal_mix', 'smooth_conversions', 'reduce_spend'];
  }
  if (category === 'liquidity_floor') {
    return ['increase_cash_buffer', 'reduce_spend', 'increase_taxable_bridge'];
  }
  if (category === 'do_not_sell_primary_residence') {
    return ['allow_home_sale', 'reduce_spend', 'delay_retirement'];
  }
  return ['roth_conversions_before_rmd', 'reduce_spend', 'smooth_income'];
}

function determinePrimaryFundingSource(withdrawals: WithdrawalState): DiagnosticPrimaryFundingSource {
  const funding: Array<{ source: DiagnosticPrimaryFundingSource; amount: number }> = [
    { source: 'cash', amount: withdrawals.cash },
    { source: 'taxable', amount: withdrawals.taxable },
    { source: 'ira_401k', amount: withdrawals.pretax },
    { source: 'roth', amount: withdrawals.roth },
  ];
  const top = funding.reduce((best, current) =>
    current.amount > best.amount ? current : best,
  );
  return top.amount > 1 ? top.source : 'none';
}

function buildYearDiagnostics({
  regime,
  yearOffset,
  explanationFlags,
  primaryBindingConstraint,
  tradeoffs,
  withdrawals,
  irmaaStatus,
  taxableBalanceEnd,
  plannedAnnualSpend,
}: {
  regime: AutopilotRegime;
  yearOffset: number;
  explanationFlags: AcaExplanationFlag[];
  primaryBindingConstraint: ConstraintCategory;
  tradeoffs: ConstraintTradeoff[];
  withdrawals: WithdrawalState;
  irmaaStatus: string;
  taxableBalanceEnd: number;
  plannedAnnualSpend: number;
}): AutopilotYearDiagnostics {
  const warningFlags: YearDiagnosticWarningFlag[] = [];
  if (explanationFlags.includes('avoidable_aca_breach')) {
    warningFlags.push('avoidable_aca_breach');
  }
  if (irmaaStatus.includes('surcharge')) {
    warningFlags.push('irmaa_surcharge');
  }
  if (
    yearOffset <= 10 &&
    taxableBalanceEnd < plannedAnnualSpend * 0.15 &&
    withdrawals.pretax > withdrawals.taxable + 1
  ) {
    warningFlags.push('early_taxable_depletion');
  }
  if (tradeoffs.some((item) => item.category === 'liquidity_floor')) {
    warningFlags.push('liquidity_floor_pressure');
  }

  const explanationTags = Array.from(
    new Set([
      ...explanationFlags,
      ...tradeoffs.flatMap((item) => item.tags),
    ]),
  );

  return {
    primaryFundingSource: determinePrimaryFundingSource(withdrawals),
    regime,
    warningFlags,
    bindingConstraint: primaryBindingConstraint,
    explanationTags,
  };
}

function buildPlanDiagnostics({
  years,
  planSummary,
}: {
  years: AutopilotYearPlan[];
  planSummary: AutopilotPlanSummary;
}): PlanDiagnosticsSummary {
  const totalAcaBridgeYears = years.filter((year) => year.regime === 'aca_bridge').length;
  const acaSafeYears = years.filter(
    (year) => year.regime === 'aca_bridge' && year.acaStatus === 'Bridge preserved',
  ).length;
  const acaBreachYears = years.filter(
    (year) => year.regime === 'aca_bridge' && year.acaStatus === 'Bridge breached',
  ).length;
  const avoidableAcaBreachYears = years.filter((year) =>
    year.diagnostics.warningFlags.includes('avoidable_aca_breach'),
  ).length;
  const irmaaSurchargeYears = years.filter((year) =>
    year.diagnostics.warningFlags.includes('irmaa_surcharge'),
  ).length;
  const yearsWithRothConversions = years.filter((year) => year.suggestedRothConversion > 1).length;
  const yearsWithRmds = years.filter((year) => year.rmdAmount > 1).length;
  const yearsFundedPrimarilyByCash = years.filter(
    (year) => year.diagnostics.primaryFundingSource === 'cash',
  ).length;
  const yearsFundedPrimarilyByTaxable = years.filter(
    (year) => year.diagnostics.primaryFundingSource === 'taxable',
  ).length;
  const yearsFundedPrimarilyByIra401k = years.filter(
    (year) => year.diagnostics.primaryFundingSource === 'ira_401k',
  ).length;
  const yearsFundedPrimarilyByRoth = years.filter(
    (year) => year.diagnostics.primaryFundingSource === 'roth',
  ).length;

  const warningFlags: PlanDiagnosticWarningFlag[] = [];
  if (avoidableAcaBreachYears > 0) {
    warningFlags.push('avoidable_aca_breach_detected');
  }
  if (irmaaSurchargeYears > 0) {
    warningFlags.push('irmaa_surcharge_detected');
  }
  if (years.some((year) => year.diagnostics.warningFlags.includes('early_taxable_depletion'))) {
    warningFlags.push('early_taxable_depletion_detected');
  }
  if (years.some((year) => year.diagnostics.warningFlags.includes('liquidity_floor_pressure'))) {
    warningFlags.push('liquidity_floor_pressure_detected');
  }
  if (
    planSummary.primaryBindingConstraint === 'legacy_target' ||
    planSummary.supportingConstraints.includes('legacy_target')
  ) {
    warningFlags.push('legacy_target_appears_binding');
  }
  if (
    planSummary.primaryBindingConstraint === 'success_rate_floor' ||
    planSummary.supportingConstraints.includes('success_rate_floor')
  ) {
    warningFlags.push('success_floor_pressure_detected');
  }

  return {
    totalAcaBridgeYears,
    acaSafeYears,
    acaBreachYears,
    avoidableAcaBreachYears,
    irmaaSurchargeYears,
    yearsWithRothConversions,
    yearsWithRmds,
    yearsFundedPrimarilyByCash,
    yearsFundedPrimarilyByTaxable,
    yearsFundedPrimarilyByIra401k,
    yearsFundedPrimarilyByRoth,
    warningFlags,
  };
}

function analyzeYearBindingConstraints({
  spendSolverBindingCategory,
  doNotSellPrimaryResidence,
  regime,
  explanationFlags,
  plannedAnnualSpend,
  estimatedFederalTax,
  estimatedMagi,
  acaHeadroom,
  irmaaHeadroom,
  irmaaStatus,
  rmdAmount,
  withdrawals,
  balances,
  hasMedicareMembers,
  hasPretaxBalance,
  suggestedRothConversion,
}: {
  spendSolverBindingCategory: ConstraintCategory;
  doNotSellPrimaryResidence: boolean;
  regime: AutopilotRegime;
  explanationFlags: AcaExplanationFlag[];
  plannedAnnualSpend: number;
  estimatedFederalTax: number;
  estimatedMagi: number;
  acaHeadroom: number | null;
  irmaaHeadroom: number | null;
  irmaaStatus: string;
  rmdAmount: number;
  withdrawals: WithdrawalState;
  balances: Record<Bucket, number>;
  hasMedicareMembers: boolean;
  hasPretaxBalance: boolean;
  suggestedRothConversion: number;
}): YearConstraintAnalysis {
  const tradeoffs: ConstraintTradeoff[] = [];
  const addTradeoff = (
    category: ConstraintCategory,
    severity: TradeoffSeverity,
    summary: string,
    impact: string,
    tags: TradeoffTag[],
    possibleFutureLevers?: string[],
  ) => {
    tradeoffs.push({
      category,
      severity,
      summary,
      impact,
      possibleFutureLevers: possibleFutureLevers ?? buildCategoryLevers(category),
      tags,
    });
  };

  if (spendSolverBindingCategory === 'legacy_target') {
    addTradeoff(
      'legacy_target',
      'medium',
      'Legacy target constrained spend flexibility this year.',
      'Spending growth stayed tighter to protect projected ending wealth.',
      ['spend_reduced_for_legacy'],
    );
  } else {
    addTradeoff(
      'success_rate_floor',
      'medium',
      'Success-rate floor constrained spend flexibility this year.',
      'Withdrawals and conversion pacing were kept conservative to protect plan durability.',
      ['spend_reduced_for_success'],
    );
  }

  if (
    regime === 'aca_bridge' &&
    (explanationFlags.some((flag) =>
      [
        'used_taxable_to_protect_aca',
        'reduced_conversion_for_aca',
        'avoidable_aca_breach',
        'unavoidable_aca_breach',
      ].includes(flag),
    ) ||
      (acaHeadroom !== null && acaHeadroom < 8_000))
  ) {
    const severity: TradeoffSeverity =
      explanationFlags.includes('avoidable_aca_breach') ||
      explanationFlags.includes('unavoidable_aca_breach') ||
      (acaHeadroom !== null && acaHeadroom < 0)
        ? 'high'
        : explanationFlags.includes('reduced_conversion_for_aca') ||
            (acaHeadroom !== null && acaHeadroom < 3_500)
          ? 'medium'
          : 'low';
    const tags: TradeoffTag[] = [];
    if (explanationFlags.includes('used_taxable_to_protect_aca')) {
      tags.push('taxable_used_to_protect_aca');
    }
    if (explanationFlags.includes('reduced_conversion_for_aca')) {
      tags.push('conversion_reduced_for_aca');
    }
    addTradeoff(
      'aca_headroom',
      severity,
      'ACA headroom was binding and constrained MAGI in the bridge window.',
      'Planner favored lower-MAGI sources and/or reduced conversion room to preserve subsidies.',
      tags,
    );
  }

  if (hasMedicareMembers && (irmaaStatus.includes('surcharge') || (irmaaHeadroom ?? 99_999) < 6_000)) {
    const tags: TradeoffTag[] = [];
    if (
      hasPretaxBalance &&
      suggestedRothConversion <= 1 &&
      (irmaaHeadroom ?? 99_999) < 6_000
    ) {
      tags.push('conversion_reduced_for_irmaa');
    }
    addTradeoff(
      'irmaa_headroom',
      irmaaStatus.includes('surcharge') ? 'high' : 'medium',
      'IRMAA threshold pressure constrained income timing.',
      'Income and conversion choices were shaped to avoid higher Medicare surcharge tiers.',
      tags,
    );
  }

  const taxBurdenRatio = estimatedFederalTax / Math.max(1, plannedAnnualSpend);
  if (taxBurdenRatio > 0.18) {
    addTradeoff(
      'tax_burden',
      taxBurdenRatio > 0.28 ? 'high' : 'medium',
      'Tax burden was a material planning constraint this year.',
      'Withdrawal mix was managed to limit additional taxable income and marginal-rate creep.',
      [],
    );
  }

  const cashReserveFloor = getCashReserveFloor(plannedAnnualSpend);
  const liquidBalance = balances.cash + balances.taxable;
  if (liquidBalance < plannedAnnualSpend * 0.45 || balances.cash < cashReserveFloor * 0.4) {
    const tags: TradeoffTag[] = [];
    if (withdrawals.roth > 0) {
      tags.push('roth_used_to_preserve_liquidity');
    }
    if (withdrawals.pretax > withdrawals.taxable && balances.taxable < plannedAnnualSpend * 0.2) {
      tags.push('ira_used_due_to_taxable_depletion');
    }
    addTradeoff(
      'liquidity_floor',
      liquidBalance < plannedAnnualSpend * 0.2 ? 'high' : 'medium',
      'Liquidity floor constrained funding flexibility.',
      'Planner preserved liquid reserves and shifted sourcing to maintain near-term stability.',
      tags,
    );
  }

  if (doNotSellPrimaryResidence) {
    addTradeoff(
      'do_not_sell_primary_residence',
      'medium',
      'Primary-residence sale was disabled by stressor.',
      'Home equity was excluded as a funding lever, reducing plan flexibility.',
      ['home_sale_disabled_by_stressor'],
    );
  }

  if (rmdAmount > 0) {
    addTradeoff(
      'rmd_forced_income',
      rmdAmount > plannedAnnualSpend * 0.3 ? 'high' : 'medium',
      'RMD forced income constrained tax-threshold control.',
      'Required IRA distributions increased taxable income and reduced discretionary timing control.',
      estimatedMagi > 0 ? ['rmd_forced_higher_magi'] : [],
    );
  }

  const primaryBindingConstraint = selectTopConstraint(tradeoffs, spendSolverBindingCategory);
  const secondaryBindingConstraints = dedupeConstraintCategories(
    tradeoffs
      .filter((item) => item.category !== primaryBindingConstraint)
      .sort((a, b) => {
        const severityDiff = SEVERITY_SCORE[b.severity] - SEVERITY_SCORE[a.severity];
        if (severityDiff !== 0) {
          return severityDiff;
        }
        return CATEGORY_PRIORITY[a.category] - CATEGORY_PRIORITY[b.category];
      })
      .map((item) => item.category)
      .slice(0, 2),
  );
  const primaryTradeoff = tradeoffs.find((item) => item.category === primaryBindingConstraint) ?? tradeoffs[0];

  return {
    primaryBindingConstraint,
    secondaryBindingConstraints,
    bindingConstraintExplanation: primaryTradeoff?.summary ??
      'Planner balanced multiple constraints this year.',
    tradeoffChosen: primaryTradeoff?.impact ??
      'Planner prioritized sustainability and threshold control.',
    tradeoffs,
  };
}

function analyzePlanBindingConstraints({
  years,
  spendSolverBindingCategory,
  doNotSellPrimaryResidence,
}: {
  years: AutopilotYearPlan[];
  spendSolverBindingCategory: ConstraintCategory;
  doNotSellPrimaryResidence: boolean;
}) {
  const scoreByCategory = new Map<ConstraintCategory, number>();
  const countByCategory = new Map<ConstraintCategory, number>();

  years.forEach((year) => {
    year.tradeoffs.forEach((tradeoff) => {
      scoreByCategory.set(
        tradeoff.category,
        (scoreByCategory.get(tradeoff.category) ?? 0) + SEVERITY_SCORE[tradeoff.severity],
      );
      countByCategory.set(
        tradeoff.category,
        (countByCategory.get(tradeoff.category) ?? 0) + 1,
      );
    });
  });

  scoreByCategory.set(
    spendSolverBindingCategory,
    (scoreByCategory.get(spendSolverBindingCategory) ?? 0) + 12,
  );
  if (doNotSellPrimaryResidence) {
    scoreByCategory.set(
      'do_not_sell_primary_residence',
      (scoreByCategory.get('do_not_sell_primary_residence') ?? 0) + 3,
    );
  }

  const ranked = Array.from(scoreByCategory.entries())
    .sort((a, b) => {
      const scoreDiff = b[1] - a[1];
      if (scoreDiff !== 0) {
        return scoreDiff;
      }
      return CATEGORY_PRIORITY[a[0]] - CATEGORY_PRIORITY[b[0]];
    })
    .map((item) => item[0]);

  const primaryBindingConstraint = ranked[0] ?? spendSolverBindingCategory;
  const supportingConstraints = ranked.filter((item) => item !== primaryBindingConstraint).slice(0, 3);
  const texts = buildConstraintTexts(primaryBindingConstraint);

  const tradeoffs = [primaryBindingConstraint, ...supportingConstraints].map((category) => {
    const categoryTradeoffs = years.flatMap((year) =>
      year.tradeoffs.filter((tradeoff) => tradeoff.category === category),
    );
    const weightedSeverity = categoryTradeoffs.reduce(
      (sum, item) => sum + SEVERITY_SCORE[item.severity],
      0,
    ) / Math.max(1, categoryTradeoffs.length);
    const severity: TradeoffSeverity =
      weightedSeverity >= 2.5 ? 'high' : weightedSeverity >= 1.5 ? 'medium' : 'low';
    const tags = Array.from(new Set(categoryTradeoffs.flatMap((item) => item.tags)));
    const yearCount = countByCategory.get(category) ?? 0;

    return {
      category,
      severity,
      summary: `${category.replaceAll('_', ' ')} influenced ${yearCount} modeled year${
        yearCount === 1 ? '' : 's'
      }.`,
      impact:
        categoryTradeoffs[0]?.impact ??
        'This constraint influenced withdrawal and conversion timing decisions.',
      possibleFutureLevers:
        categoryTradeoffs[0]?.possibleFutureLevers ?? buildCategoryLevers(category),
      tags,
    } satisfies ConstraintTradeoff;
  });

  return {
    primaryBindingConstraint,
    supportingConstraints,
    bindingConstraintDescription: texts.description,
    whatThisMeans: texts.whatThisMeans,
    tradeoffs,
  };
}

export function generateAutopilotPlan(input: AutopilotPlanInputs): AutopilotPlanResult {
  const route = normalizeRouteContext(input);
  const spendSolver =
    input.precomputedSpendSolver ??
    solveSpendByReverseTimeline({
      data: input.data,
      assumptions: input.assumptions,
      selectedStressors: input.selectedStressors,
      selectedResponses: input.selectedResponses,
      targetLegacyTodayDollars: input.targetLegacyTodayDollars,
      minSuccessRate: input.minSuccessRate,
      successRateRange: input.successRateRange,
      spendingFloorAnnual: input.spendingFloorAnnual,
      spendingCeilingAnnual: input.spendingCeilingAnnual,
      toleranceAnnual: input.toleranceAnnual,
      housingFundingPolicy: route.doNotSellPrimaryResidence
        ? 'do_not_sell_primary_residence'
        : 'allow_primary_residence_sale',
      runtimeBudget: input.solverRuntimeBudget,
    });
  const spendSolverBindingCategory = mapSpendSolverBindingConstraintToCategory(
    spendSolver.bindingConstraint,
  );

  const currentAges = calculateCurrentAges(input.data);
  const horizonYears = getRetirementHorizonYears(input.data, input.assumptions);
  const endYear = CURRENT_YEAR + horizonYears;
  const acaBridgePlanByYear = buildAcaBridgePlan(input, route, currentAges, endYear);
  const years: AutopilotYearPlan[] = [];
  let hsaBalance = input.data.accounts.hsa?.balance ?? 0;
  const balances: Record<Bucket, number> = {
    cash: input.data.accounts.cash.balance,
    taxable: input.data.accounts.taxable.balance,
    pretax: input.data.accounts.pretax.balance + (input.data.accounts.hsa?.balance ?? 0),
    roth: input.data.accounts.roth.balance,
  };

  let inflationIndex = 1;
  let medicalInflationIndex = 1;
  const magiHistory = new Map<number, number>();

  for (let year = CURRENT_YEAR; year <= endYear; year += 1) {
    const yearOffset = year - CURRENT_YEAR;
    const bridgePlan = acaBridgePlanByYear.get(year);
    const regime: AutopilotRegime = bridgePlan?.regime ?? 'standard';
    const isAcaBridgeYear = regime === 'aca_bridge';
    const robAge = currentAges.rob + yearOffset;
    const debbieAge = currentAges.debbie + yearOffset;
    const isRetired = year >= route.retirementYear;
    const inflationRate = getYearInflationRate(
      input.assumptions,
      yearOffset,
      route.activeStressors,
    );

    applyDeterministicGrowth(
      balances,
      input.assumptions,
      yearOffset,
      route.activeStressors,
    );

    const windfallRealizations = route.windfalls
      .map((item) => buildWindfallRealizationForYear(item, year, route.filingStatus))
      .filter(
        (item) => item.cashInflow > 0 || item.ordinaryIncome > 0 || item.ltcgIncome > 0,
      );
    const windfallCashInflow = windfallRealizations.reduce(
      (sum, item) => sum + item.cashInflow,
      0,
    );
    const windfallOrdinaryIncome = windfallRealizations.reduce(
      (sum, item) => sum + item.ordinaryIncome,
      0,
    );
    const windfallLtcgIncome = windfallRealizations.reduce(
      (sum, item) => sum + item.ltcgIncome,
      0,
    );
    balances.cash += windfallCashInflow;

    const salary = getSalaryForYear(route, year);
    const contributionResult = calculatePreRetirementContributions({
      age: robAge,
      salaryAnnual: route.salaryAnnual,
      salaryThisYear: salary,
      retirementDate: route.salaryEndDate,
      projectionYear: year,
      filingStatus: route.filingStatus,
      settings: input.data.income.preRetirementContributions,
      accountBalances: {
        pretax: balances.pretax,
        roth: balances.roth,
        hsa: hsaBalance,
      },
    });
    balances.pretax = contributionResult.updatedAccountBalances.pretax;
    balances.roth = contributionResult.updatedAccountBalances.roth ?? balances.roth;
    hsaBalance = contributionResult.updatedAccountBalances.hsa ?? hsaBalance;
    const adjustedWages = contributionResult.adjustedWages;

    const socialSecurityIncome = getSocialSecurityIncome(
      route,
      yearOffset,
      inflationIndex,
      { rob: robAge, debbie: debbieAge },
    );
    const baseIncome = adjustedWages + socialSecurityIncome + windfallCashInflow;

    const rmd = calculateRequiredMinimumDistribution({
      pretaxBalance: balances.pretax,
      members: [
        { birthDate: input.data.household.robBirthDate, age: robAge, accountShare: 0.5 },
        { birthDate: input.data.household.debbieBirthDate, age: debbieAge, accountShare: 0.5 },
      ],
    }).amount;

    const medicareEligibilityByPerson = [robAge >= 65, debbieAge >= 65];
    const hasMedicareMembers = medicareEligibilityByPerson.some(Boolean);
    const hasNonMedicareMembers = medicareEligibilityByPerson.some((value) => !value);
    const plannedAnnualSpend = spendSolver.recommendedAnnualSpend * inflationIndex;
    const cashReserveFloor = getCashReserveFloor(plannedAnnualSpend);
    const bridgeCashReserveFloor = isAcaBridgeYear ? plannedAnnualSpend * 0.1 : cashReserveFloor;
    const lowMagiFundingCapacityAtStart =
      Math.max(0, balances.cash - bridgeCashReserveFloor) + Math.max(0, balances.roth);
    const irmaaReferenceMagi = magiHistory.get(year - DEFAULT_IRMAA_CONFIG.lookbackYears) ?? 0;

    const baselineTax = calculateFederalTax({
      wages: adjustedWages,
      pension: 0,
      socialSecurityBenefits: socialSecurityIncome,
      ira401kWithdrawals: 0,
      rothWithdrawals: 0,
      taxableInterest: 0,
      qualifiedDividends: 0,
      ordinaryDividends: 0,
      realizedLTCG: windfallLtcgIncome,
      realizedSTCG: 0,
      otherOrdinaryIncome: windfallOrdinaryIncome,
      filingStatus: route.filingStatus,
    });

    const acaFriendlyMagiCeiling = bridgePlan?.acaFriendlyMagiCeiling ?? null;
    const suggestedRothConversion = isAcaBridgeYear && acaFriendlyMagiCeiling !== null
      ? Math.max(
          0,
          Math.min(
            balances.pretax,
            bridgePlan?.reservedConversionBudget ?? 0,
            acaFriendlyMagiCeiling - baselineTax.MAGI,
          ),
        )
      : determineRothConversion({
          taxEstimateWithoutWithdrawals: baselineTax,
          filingStatus: route.filingStatus,
          isRetired,
          hasPretaxBalance: balances.pretax > 0,
          hasNonMedicareMembers,
          hasMedicareMembers,
          iraaReferenceMagi: irmaaReferenceMagi,
        });

    const withdrawals: WithdrawalState = {
      cash: 0,
      taxable: 0,
      pretax: 0,
      roth: 0,
    };
    const taxState: TaxState = {
      ira401kWithdrawals: 0,
      rothWithdrawals: 0,
      realizedLTCG: 0,
    };

    let conversion = Math.min(balances.pretax, suggestedRothConversion);
    if (conversion > 0) {
      balances.pretax -= conversion;
      balances.roth += conversion;
      taxState.ira401kWithdrawals += conversion;
    }

    const rmdWithdrawal = Math.min(balances.pretax, Math.max(0, rmd));
    if (rmdWithdrawal > 0) {
      balances.pretax -= rmdWithdrawal;
      withdrawals.pretax += rmdWithdrawal;
      taxState.ira401kWithdrawals += rmdWithdrawal;
    }

    const spendingWithdrawalOrder: Bucket[] = isAcaBridgeYear
      ? ['cash', 'taxable', 'roth', 'pretax']
      : hasNonMedicareMembers && isRetired
        ? ['taxable', 'cash', 'pretax', 'roth']
        : ['cash', 'taxable', 'pretax', 'roth'];
    const taxableLtcgRatio = isAcaBridgeYear ? 0.1 : TAXABLE_WITHDRAWAL_LTCG_RATIO;
    const maxPretaxWithdrawalsTotal = isAcaBridgeYear && acaFriendlyMagiCeiling !== null
      ? withdrawals.pretax + Math.max(0, acaFriendlyMagiCeiling - baselineTax.MAGI - conversion)
      : undefined;

    const availableCashFromIncomeAndRmd = baseIncome + rmdWithdrawal;
    const initialNeed = Math.max(0, plannedAnnualSpend - availableCashFromIncomeAndRmd);
    withdrawForNeed(
      initialNeed,
      spendingWithdrawalOrder,
      balances,
      withdrawals,
      taxState,
      {
        cashReserveFloor: bridgeCashReserveFloor,
        maxPretaxWithdrawalsTotal,
        taxableLtcgRatio,
      },
    );

    const toTaxResult = () =>
      calculateFederalTax({
        wages: adjustedWages,
        pension: 0,
        socialSecurityBenefits: socialSecurityIncome,
        ira401kWithdrawals: taxState.ira401kWithdrawals,
        rothWithdrawals: taxState.rothWithdrawals,
        taxableInterest: 0,
        qualifiedDividends: 0,
        ordinaryDividends: 0,
        realizedLTCG: taxState.realizedLTCG + windfallLtcgIncome,
        realizedSTCG: 0,
        otherOrdinaryIncome: windfallOrdinaryIncome,
        filingStatus: route.filingStatus,
      });

    let taxResult = toTaxResult();
    let irmaaTier = calculateIrmaaTier(
      magiHistory.get(year - DEFAULT_IRMAA_CONFIG.lookbackYears) ?? taxResult.MAGI,
      route.filingStatus,
    );
    let healthcare = calculateHealthcarePremiums({
      agesByYear: [robAge, debbieAge],
      filingStatus: route.filingStatus,
      MAGI: taxResult.MAGI,
      retirementStatus: isRetired,
      medicareEligibilityByPerson,
      baselineAcaPremiumAnnual:
        (input.data.rules.healthcarePremiums?.baselineAcaPremiumAnnual ??
          DEFAULT_BASELINE_ACA_PREMIUM_ANNUAL) * medicalInflationIndex,
      baselineMedicarePremiumAnnual:
        (input.data.rules.healthcarePremiums?.baselineMedicarePremiumAnnual ??
          DEFAULT_BASELINE_MEDICARE_PREMIUM_ANNUAL) * medicalInflationIndex,
      irmaaSurchargeAnnualPerEligible: irmaaTier.surchargeAnnual,
    });
    let ltcCostForYear = calculateLtcCostForYear({
      rules: input.data.rules,
      ages: { rob: robAge, debbie: debbieAge },
    });
    let hsaOffsetUsed = calculateHsaOffsetForYear({
      rules: input.data.rules,
      hsaBalance,
      magi: taxResult.MAGI,
      healthcareAndLtcCost: healthcare.totalHealthcarePremiumCost + ltcCostForYear,
    });
    const recalculateTaxAndHealthcare = () => {
      taxResult = toTaxResult();
      irmaaTier = calculateIrmaaTier(
        magiHistory.get(year - DEFAULT_IRMAA_CONFIG.lookbackYears) ?? taxResult.MAGI,
        route.filingStatus,
      );
      healthcare = calculateHealthcarePremiums({
        agesByYear: [robAge, debbieAge],
        filingStatus: route.filingStatus,
        MAGI: taxResult.MAGI,
        retirementStatus: isRetired,
        medicareEligibilityByPerson,
        baselineAcaPremiumAnnual:
          (input.data.rules.healthcarePremiums?.baselineAcaPremiumAnnual ??
            DEFAULT_BASELINE_ACA_PREMIUM_ANNUAL) * medicalInflationIndex,
        baselineMedicarePremiumAnnual:
          (input.data.rules.healthcarePremiums?.baselineMedicarePremiumAnnual ??
            DEFAULT_BASELINE_MEDICARE_PREMIUM_ANNUAL) * medicalInflationIndex,
        irmaaSurchargeAnnualPerEligible: irmaaTier.surchargeAnnual,
      });
      ltcCostForYear = calculateLtcCostForYear({
        rules: input.data.rules,
        ages: { rob: robAge, debbie: debbieAge },
      });
      hsaOffsetUsed = calculateHsaOffsetForYear({
        rules: input.data.rules,
        hsaBalance,
        magi: taxResult.MAGI,
        healthcareAndLtcCost: healthcare.totalHealthcarePremiumCost + ltcCostForYear,
      });
    };

    const cashAvailableAfterSpend =
      availableCashFromIncomeAndRmd +
      withdrawals.cash +
      withdrawals.taxable +
      (withdrawals.pretax - rmdWithdrawal) +
      withdrawals.roth -
      plannedAnnualSpend;

    const additionalNeed = Math.max(
      0,
      taxResult.federalTax +
        healthcare.totalHealthcarePremiumCost +
        ltcCostForYear -
        hsaOffsetUsed -
        cashAvailableAfterSpend,
    );
    if (additionalNeed > 0) {
      withdrawForNeed(
        additionalNeed,
        spendingWithdrawalOrder,
        balances,
        withdrawals,
        taxState,
        {
          cashReserveFloor: 0,
          maxPretaxWithdrawalsTotal,
          taxableLtcgRatio,
        },
      );
      recalculateTaxAndHealthcare();
    }
    if (hsaOffsetUsed > 0) {
      const appliedHsaOffset = Math.min(hsaOffsetUsed, hsaBalance, balances.pretax);
      hsaBalance = Math.max(0, hsaBalance - appliedHsaOffset);
      balances.pretax = Math.max(0, balances.pretax - appliedHsaOffset);
    }

    const explanationFlags: AcaExplanationFlag[] = [];
    let reducedConversionForAca = false;

    if (isAcaBridgeYear && acaFriendlyMagiCeiling !== null && taxResult.MAGI > acaFriendlyMagiCeiling) {
      let excessMagi = taxResult.MAGI - acaFriendlyMagiCeiling;

      if (conversion > 0 && excessMagi > 0) {
        const conversionReduction = Math.min(conversion, excessMagi);
        if (conversionReduction > 0) {
          conversion -= conversionReduction;
          balances.pretax += conversionReduction;
          balances.roth = Math.max(0, balances.roth - conversionReduction);
          taxState.ira401kWithdrawals = Math.max(
            0,
            taxState.ira401kWithdrawals - conversionReduction,
          );
          reducedConversionForAca = true;
          recalculateTaxAndHealthcare();
          excessMagi = Math.max(0, taxResult.MAGI - acaFriendlyMagiCeiling);
        }
      }

      if (excessMagi > 0 && withdrawals.taxable > 0) {
        const taxableReductionNeeded = Math.min(
          withdrawals.taxable,
          excessMagi / Math.max(0.01, taxableLtcgRatio),
        );
        if (taxableReductionNeeded > 0) {
          withdrawals.taxable -= taxableReductionNeeded;
          balances.taxable += taxableReductionNeeded;
          taxState.realizedLTCG = Math.max(
            0,
            taxState.realizedLTCG - taxableReductionNeeded * taxableLtcgRatio,
          );
          const refillFromLowMagi = withdrawForNeed(
            taxableReductionNeeded,
            ['cash', 'roth'],
            balances,
            withdrawals,
            taxState,
            {
              cashReserveFloor: 0,
              taxableLtcgRatio,
            },
          );
          if (refillFromLowMagi > 0) {
            withdrawForNeed(
              refillFromLowMagi,
              ['taxable'],
              balances,
              withdrawals,
              taxState,
              {
                cashReserveFloor: 0,
                taxableLtcgRatio,
              },
            );
          }

          recalculateTaxAndHealthcare();
          excessMagi = Math.max(0, taxResult.MAGI - acaFriendlyMagiCeiling);
        }
      }

      if (excessMagi > 0 && withdrawals.pretax > rmdWithdrawal) {
        const pretaxReducible = Math.max(0, withdrawals.pretax - rmdWithdrawal);
        const pretaxReduction = Math.min(pretaxReducible, excessMagi);
        if (pretaxReduction > 0) {
          withdrawals.pretax -= pretaxReduction;
          balances.pretax += pretaxReduction;
          taxState.ira401kWithdrawals = Math.max(
            0,
            taxState.ira401kWithdrawals - pretaxReduction,
          );
          const refillWithoutPretax = withdrawForNeed(
            pretaxReduction,
            ['cash', 'taxable', 'roth'],
            balances,
            withdrawals,
            taxState,
            {
              cashReserveFloor: 0,
              taxableLtcgRatio,
            },
          );
          if (refillWithoutPretax > 0) {
            withdrawForNeed(
              refillWithoutPretax,
              ['pretax'],
              balances,
              withdrawals,
              taxState,
              {
                cashReserveFloor: 0,
                taxableLtcgRatio,
              },
            );
          }

          recalculateTaxAndHealthcare();
        }
      }
    }

    if (isAcaBridgeYear && withdrawals.taxable > 0 && withdrawals.pretax <= rmdWithdrawal + 1) {
      explanationFlags.push('used_taxable_to_protect_aca');
    }
    if (isAcaBridgeYear && reducedConversionForAca) {
      explanationFlags.push('reduced_conversion_for_aca');
    }
    if (isAcaBridgeYear && acaFriendlyMagiCeiling !== null) {
      explanationFlags.push(
        classifyAcaBridgeBreach({
          estimatedMagi: taxResult.MAGI,
          acaFriendlyMagiCeiling,
          baselineMagi: baselineTax.MAGI,
          rmdAmount: rmdWithdrawal,
          lowMagiFundingCapacityAtStart,
        }),
      );
    }

    magiHistory.set(year, taxResult.MAGI);

    const irmaaHeadroom = hasMedicareMembers
      ? getIrmaaHeadroom(
          magiHistory.get(year - DEFAULT_IRMAA_CONFIG.lookbackYears) ?? taxResult.MAGI,
          route.filingStatus,
        )
      : null;
    const irmaaStatus = hasMedicareMembers
      ? `${irmaaTier.tierLabel}${irmaaTier.tier > 1 ? ' (surcharge)' : ''}`
      : 'Not applicable';

    const acaCliffIncome = getAcaCliffIncome(route.filingStatus) * inflationIndex;
    const acaTargetCeiling =
      isAcaBridgeYear && acaFriendlyMagiCeiling !== null
        ? acaFriendlyMagiCeiling
        : acaCliffIncome;
    const acaHeadroom =
      isRetired && hasNonMedicareMembers ? acaTargetCeiling - taxResult.MAGI : null;
    const acaStatus = isRetired && hasNonMedicareMembers
      ? isAcaBridgeYear
        ? acaHeadroom !== null && acaHeadroom >= 0
          ? 'Bridge preserved'
          : 'Bridge breached'
        : acaHeadroom !== null && acaHeadroom >= 0
          ? 'Within subsidy range'
          : 'Above subsidy range'
      : 'Not applicable';

    const explanation = buildExplanation({
      regime,
      doNotSellPrimaryResidence: route.doNotSellPrimaryResidence,
      explanationFlags,
      taxableWithdrawal: withdrawals.taxable,
      pretaxWithdrawal: withdrawals.pretax,
      rmdAmount: rmdWithdrawal,
      rothConversion: conversion,
      acaFriendlyMagiCeiling,
      estimatedMagi: taxResult.MAGI,
    });
    const yearConstraintAnalysis = analyzeYearBindingConstraints({
      spendSolverBindingCategory,
      doNotSellPrimaryResidence: route.doNotSellPrimaryResidence,
      regime,
      explanationFlags,
      plannedAnnualSpend,
      estimatedFederalTax: taxResult.federalTax,
      estimatedMagi: taxResult.MAGI,
      acaHeadroom,
      irmaaHeadroom,
      irmaaStatus,
      rmdAmount: rmdWithdrawal,
      withdrawals,
      balances,
      hasMedicareMembers,
      hasPretaxBalance: balances.pretax > 0,
      suggestedRothConversion: conversion,
    });
    const yearDiagnostics = buildYearDiagnostics({
      regime,
      yearOffset,
      explanationFlags,
      primaryBindingConstraint: yearConstraintAnalysis.primaryBindingConstraint,
      tradeoffs: yearConstraintAnalysis.tradeoffs,
      withdrawals,
      irmaaStatus,
      taxableBalanceEnd: balances.taxable,
      plannedAnnualSpend,
    });
    const explanationWithBindings = `${explanation}. ${yearConstraintAnalysis.bindingConstraintExplanation} ${yearConstraintAnalysis.tradeoffChosen}`;

    years.push({
      year,
      robAge,
      debbieAge,
      totalWealth: roundMoney(balances.cash + balances.taxable + balances.pretax + balances.roth),
      regime,
      primaryBindingConstraint: yearConstraintAnalysis.primaryBindingConstraint,
      secondaryBindingConstraints: yearConstraintAnalysis.secondaryBindingConstraints,
      bindingConstraintExplanation: yearConstraintAnalysis.bindingConstraintExplanation,
      tradeoffChosen: yearConstraintAnalysis.tradeoffChosen,
      tradeoffs: yearConstraintAnalysis.tradeoffs,
      plannedAnnualSpend: roundMoney(plannedAnnualSpend),
      withdrawalCash: roundMoney(withdrawals.cash),
      withdrawalTaxable: roundMoney(withdrawals.taxable),
      withdrawalIra401k: roundMoney(withdrawals.pretax),
      withdrawalRoth: roundMoney(withdrawals.roth),
      suggestedRothConversion: roundMoney(conversion),
      estimatedMAGI: roundMoney(taxResult.MAGI),
      estimatedFederalTax: roundMoney(taxResult.federalTax),
      irmaaStatus,
      irmaaHeadroom: irmaaHeadroom === null ? null : roundMoney(irmaaHeadroom),
      acaStatus,
      acaHeadroom: acaHeadroom === null ? null : roundMoney(acaHeadroom),
      acaFriendlyMagiCeiling: acaFriendlyMagiCeiling === null ? null : roundMoney(acaFriendlyMagiCeiling),
      rmdAmount: roundMoney(rmdWithdrawal),
      explanationFlags,
      diagnostics: yearDiagnostics,
      explanation: explanationWithBindings,
    });

    inflationIndex *= 1 + inflationRate;
    medicalInflationIndex *=
      1 +
      (input.data.rules.healthcarePremiums?.medicalInflationAnnual ??
        DEFAULT_MEDICAL_INFLATION_ANNUAL);
  }

  const averageTax =
    years.reduce((sum, item) => sum + item.estimatedFederalTax, 0) / Math.max(1, years.length);
  const irmaaExposedYears = years.filter((item) => item.irmaaStatus.includes('surcharge')).length;
  const acaAboveRangeYears = years.filter(
    (item) => item.acaStatus === 'Above subsidy range' || item.acaStatus === 'Bridge breached',
  ).length;
  const liquidityYears = years.filter((item) => item.withdrawalCash > 0).length;
  const planConstraintSummary = analyzePlanBindingConstraints({
    years,
    spendSolverBindingCategory,
    doNotSellPrimaryResidence: route.doNotSellPrimaryResidence,
  });

  const summary: AutopilotPlanSummary = {
    successRate: spendSolver.modeledSuccessRate,
    projectedLegacyOutcomeTodayDollars: spendSolver.projectedLegacyOutcomeTodayDollars,
    primaryBindingConstraint: planConstraintSummary.primaryBindingConstraint,
    supportingConstraints: planConstraintSummary.supportingConstraints,
    bindingConstraintDescription: planConstraintSummary.bindingConstraintDescription,
    whatThisMeans: planConstraintSummary.whatThisMeans,
    tradeoffs: planConstraintSummary.tradeoffs,
    bindingConstraint: spendSolver.bindingConstraint,
    routeSummary: `Plan maintains ${(spendSolver.modeledSuccessRate * 100).toFixed(
      1,
    )}% success while targeting ${Math.round(
      spendSolver.targetLegacyTodayDollars,
    ).toLocaleString()} legacy in today's dollars.${
      route.doNotSellPrimaryResidence ? ' House is retained throughout the modeled plan.' : ''
    }`,
    tradeoffSummary: `${planConstraintSummary.bindingConstraintDescription} ${planConstraintSummary.whatThisMeans} Average annual federal tax is ${Math.round(
      averageTax,
    ).toLocaleString()}, IRMAA surcharge years: ${irmaaExposedYears}, ACA-above-range years: ${acaAboveRangeYears}, cash-funded years: ${liquidityYears}.`,
  };
  const diagnostics = buildPlanDiagnostics({
    years,
    planSummary: summary,
  });

  return {
    summary,
    years,
    diagnostics,
    spendSolver,
  };
}
