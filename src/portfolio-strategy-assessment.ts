import {
  deriveAssetClassMappingAssumptionsFromAccounts,
  rollupHoldingsToAssetClasses,
  type AssetClassExposure,
} from './asset-class-mapper';
import { getRmdStartAgeForBirthYear } from './retirement-rules';
import type {
  AccountBucket,
  AccountBucketType,
  MarketAssumptions,
  PathResult,
  PathYearResult,
  SeedData,
  WithdrawalRule,
} from './types';

export type PortfolioStrategyAssessmentStatus = 'pass' | 'watch' | 'fail';
export type PortfolioStrategyModelCompleteness = 'faithful' | 'reconstructed';
export type PortfolioAssessmentBucket = AccountBucketType | 'hsa';

export interface AllocationBand {
  min: number;
  target: number;
  max: number;
}

export interface PortfolioStrategyStandards {
  version: 'portfolio_strategy_standards_v1';
  source: 'explicit_internal_defaults_v1' | 'caller_override';
  ageBand: 'pre_retirement' | 'early_retirement' | 'mid_retirement' | 'late_retirement';
  targetTotalEquityShare: AllocationBand;
  targetBondShare: AllocationBand;
  targetCashShare: AllocationBand;
  cashRunwayYears: AllocationBand;
  maxSingleHoldingPortfolioShare: number;
  maxSingleHoldingAccountShare: number;
  maxManagedSleevePortfolioShare: number;
  minimumEarlyToLateRealSpendRatio: number;
  legacyTargetBand: {
    lowerMultiple: number;
    upperMultiple: number;
  };
  withdrawalOrderingPrinciples: string[];
}

export interface PortfolioStrategyCheck {
  id: string;
  title: string;
  status: PortfolioStrategyAssessmentStatus;
  detail: string;
  recommendation: string;
  intermediateCalculations: Record<string, number | string | boolean | null>;
}

export interface PortfolioHoldingConcentration {
  symbol: string;
  name: string | null;
  value: number;
  portfolioShare: number;
  largestAccountShare: number;
  largestAccountName: string | null;
  buckets: PortfolioAssessmentBucket[];
  managed: boolean;
}

export interface WithdrawalOrderingStage {
  id:
    | 'income_and_required_distributions'
    | 'aca_bridge'
    | 'low_income_conversion_window'
    | 'medicare_pre_rmd'
    | 'rmd_years'
    | 'roth_reserve';
  label: string;
  yearRange: { startYear: number | null; endYear: number | null };
  preferredOrder: string[];
  guardrails: string[];
}

export interface WithdrawalPathSummary {
  activeRule: WithdrawalRule;
  activeRuleAlignment: PortfolioStrategyAssessmentStatus;
  activeRuleDetail: string;
  dominantWithdrawalSourceByYear: Array<{
    year: number;
    source: AccountBucketType | 'none';
    amount: number;
  }>;
  totalsBySource: Record<AccountBucketType, number>;
  firstPretaxWithdrawalYear: number | null;
  firstRothWithdrawalYear: number | null;
  firstAcaFullCostYear: number | null;
  conversionAnnualCapBindingYears: number[];
  recommendedStages: WithdrawalOrderingStage[];
}

export interface SpendingPhaseMetrics {
  averageRealSpend60s: number;
  averageRealSpend70s: number;
  averageRealSpend80Plus: number;
  earlyToLateRealSpendRatio: number | null;
}

export interface PortfolioStrategyAssessment {
  version: 'portfolio_strategy_assessment_v1';
  generatedAtIso: string;
  status: PortfolioStrategyAssessmentStatus;
  modelCompleteness: PortfolioStrategyModelCompleteness;
  inferredAssumptions: string[];
  householdContext: {
    assessmentYear: number;
    robAge: number;
    debbieAge: number;
    youngestAge: number;
    oldestAge: number;
    planningEndAge: number;
    withdrawalRule: WithdrawalRule;
    legacyTargetTodayDollars: number;
  };
  standards: PortfolioStrategyStandards;
  metrics: {
    totalPortfolioValue: number;
    currentAnnualSpending: number;
    supportedAnnualSpendTodayDollars: number | null;
    supportedSpendGapAnnual: number | null;
    allocation: Required<AssetClassExposure> & {
      totalEquity: number;
    };
    bucketShares: Record<PortfolioAssessmentBucket, number>;
    currentCashRunwayYears: number;
    maxProjectedCashRunwayYears: number | null;
    medianEndingWealthNominal: number | null;
    medianEndingWealthTodayDollars: number | null;
    medianLegacyToTargetRatio: number | null;
    spendingPhase: SpendingPhaseMetrics | null;
    concentration: {
      largestHolding: PortfolioHoldingConcentration | null;
      holdingsOverPortfolioLimit: PortfolioHoldingConcentration[];
      holdingsOverAccountLimit: PortfolioHoldingConcentration[];
      managedSleeveShare: number;
    };
  };
  checks: PortfolioStrategyCheck[];
  withdrawalOrdering: WithdrawalPathSummary;
  actionItems: Array<{
    id: string;
    priority: 'high' | 'medium' | 'low';
    action: string;
    checkIds: string[];
  }>;
}

export interface BuildPortfolioStrategyAssessmentInput {
  data: SeedData;
  assumptions: MarketAssumptions;
  path?: PathResult | null;
  generatedAtIso?: string;
  legacyTargetTodayDollars?: number | null;
  supportedAnnualSpendTodayDollars?: number | null;
  standards?: Partial<PortfolioStrategyStandards>;
}

const PORTFOLIO_BUCKETS: PortfolioAssessmentBucket[] = [
  'pretax',
  'roth',
  'taxable',
  'cash',
  'hsa',
];

const DEFAULT_LEGACY_TARGET_TODAY_DOLLARS = 1_000_000;

function roundMoney(value: number) {
  return Math.round(value);
}

function roundRate(value: number) {
  return Number(value.toFixed(4));
}

function roundYears(value: number) {
  return Number(value.toFixed(2));
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function ageOnDate(birthDate: string, asOf: Date) {
  const birth = new Date(birthDate);
  if (Number.isNaN(birth.getTime())) {
    return 0;
  }
  let age = asOf.getFullYear() - birth.getFullYear();
  const birthdayThisYear = new Date(
    asOf.getFullYear(),
    birth.getMonth(),
    birth.getDate(),
  );
  if (asOf < birthdayThisYear) {
    age -= 1;
  }
  return Math.max(0, age);
}

function ageInYear(birthDate: string, year: number) {
  const birthYear = new Date(birthDate).getFullYear();
  if (!Number.isFinite(birthYear)) {
    return 0;
  }
  return Math.max(0, year - birthYear);
}

function bucketFor(data: SeedData, bucket: PortfolioAssessmentBucket): AccountBucket | undefined {
  return data.accounts[bucket];
}

function annualSpending(data: SeedData) {
  return Math.max(
    0,
    (data.spending.essentialMonthly + data.spending.optionalMonthly) * 12 +
      data.spending.annualTaxesInsurance +
      data.spending.travelEarlyRetirementAnnual,
  );
}

function totalPortfolioValue(data: SeedData) {
  return PORTFOLIO_BUCKETS.reduce(
    (total, bucket) => total + Math.max(0, bucketFor(data, bucket)?.balance ?? 0),
    0,
  );
}

function presentValue(amount: number, years: number, inflation: number) {
  const discount = Math.pow(1 + Math.max(-0.95, inflation), Math.max(0, years));
  return discount > 0 ? amount / discount : amount;
}

function average(values: number[]) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function buildDefaultStandards(input: {
  youngestAge: number;
  yearsToPlanningEnd: number;
}): PortfolioStrategyStandards {
  const { youngestAge, yearsToPlanningEnd } = input;
  const ageBand: PortfolioStrategyStandards['ageBand'] =
    youngestAge < 60
      ? 'pre_retirement'
      : youngestAge < 70 || yearsToPlanningEnd >= 25
        ? 'early_retirement'
        : youngestAge < 80
          ? 'mid_retirement'
          : 'late_retirement';

  const bands: Record<
    PortfolioStrategyStandards['ageBand'],
    Pick<
      PortfolioStrategyStandards,
      'targetTotalEquityShare' | 'targetBondShare' | 'targetCashShare' | 'cashRunwayYears'
    >
  > = {
    pre_retirement: {
      targetTotalEquityShare: { min: 0.6, target: 0.72, max: 0.85 },
      targetBondShare: { min: 0.1, target: 0.22, max: 0.35 },
      targetCashShare: { min: 0.02, target: 0.05, max: 0.12 },
      cashRunwayYears: { min: 0.25, target: 0.75, max: 2 },
    },
    early_retirement: {
      targetTotalEquityShare: { min: 0.5, target: 0.62, max: 0.75 },
      targetBondShare: { min: 0.18, target: 0.3, max: 0.45 },
      targetCashShare: { min: 0.03, target: 0.08, max: 0.15 },
      cashRunwayYears: { min: 0.75, target: 1.5, max: 3 },
    },
    mid_retirement: {
      targetTotalEquityShare: { min: 0.42, target: 0.55, max: 0.7 },
      targetBondShare: { min: 0.24, target: 0.36, max: 0.5 },
      targetCashShare: { min: 0.04, target: 0.09, max: 0.16 },
      cashRunwayYears: { min: 0.75, target: 1.5, max: 3 },
    },
    late_retirement: {
      targetTotalEquityShare: { min: 0.32, target: 0.48, max: 0.62 },
      targetBondShare: { min: 0.28, target: 0.42, max: 0.58 },
      targetCashShare: { min: 0.05, target: 0.1, max: 0.18 },
      cashRunwayYears: { min: 0.75, target: 1.25, max: 3 },
    },
  };

  return {
    version: 'portfolio_strategy_standards_v1',
    source: 'explicit_internal_defaults_v1',
    ageBand,
    ...bands[ageBand],
    maxSingleHoldingPortfolioShare: 0.15,
    maxSingleHoldingAccountShare: 0.5,
    maxManagedSleevePortfolioShare: 0.1,
    minimumEarlyToLateRealSpendRatio: 1.1,
    legacyTargetBand: {
      lowerMultiple: 0.8,
      upperMultiple: 1.5,
    },
    withdrawalOrderingPrinciples: [
      'Use wages, pensions, Social Security, RMDs, and other required income before voluntary withdrawals.',
      'Keep an explicit cash buffer, but sweep persistent excess cash into the target allocation.',
      'Use taxable assets before pretax and Roth when MAGI cliffs are not binding.',
      'Fill low brackets with pretax withdrawals or Roth conversions when ACA and IRMAA ceilings allow.',
      'Preserve Roth as the last-resort bucket unless MAGI control or estate strategy explicitly calls for it.',
    ],
  };
}

function mergeStandards(
  defaults: PortfolioStrategyStandards,
  override: Partial<PortfolioStrategyStandards> | undefined,
): PortfolioStrategyStandards {
  if (!override) {
    return defaults;
  }
  return {
    ...defaults,
    ...override,
    source: 'caller_override',
    targetTotalEquityShare:
      override.targetTotalEquityShare ?? defaults.targetTotalEquityShare,
    targetBondShare: override.targetBondShare ?? defaults.targetBondShare,
    targetCashShare: override.targetCashShare ?? defaults.targetCashShare,
    cashRunwayYears: override.cashRunwayYears ?? defaults.cashRunwayYears,
    legacyTargetBand: override.legacyTargetBand ?? defaults.legacyTargetBand,
    withdrawalOrderingPrinciples:
      override.withdrawalOrderingPrinciples ?? defaults.withdrawalOrderingPrinciples,
  };
}

function compareToBand(value: number, band: AllocationBand) {
  if (value < band.min) return 'below' as const;
  if (value > band.max) return 'above' as const;
  return 'inside' as const;
}

function allocationStatus(value: number, band: AllocationBand): PortfolioStrategyAssessmentStatus {
  const comparison = compareToBand(value, band);
  if (comparison === 'inside') return 'pass';
  const miss = comparison === 'below' ? band.min - value : value - band.max;
  return miss >= 0.08 ? 'fail' : 'watch';
}

function buildPortfolioAllocation(data: SeedData) {
  const assumptions = deriveAssetClassMappingAssumptionsFromAccounts(
    data.accounts,
    data.rules.assetClassMappingAssumptions,
  );
  const totals: Required<AssetClassExposure> = {
    US_EQUITY: 0,
    INTL_EQUITY: 0,
    BONDS: 0,
    CASH: 0,
  };
  const total = totalPortfolioValue(data);

  PORTFOLIO_BUCKETS.forEach((bucket) => {
    const accountBucket = bucketFor(data, bucket);
    if (!accountBucket || accountBucket.balance <= 0) {
      return;
    }
    const exposure = rollupHoldingsToAssetClasses(
      accountBucket.targetAllocation,
      assumptions,
    );
    totals.US_EQUITY += exposure.US_EQUITY * accountBucket.balance;
    totals.INTL_EQUITY += exposure.INTL_EQUITY * accountBucket.balance;
    totals.BONDS += exposure.BONDS * accountBucket.balance;
    totals.CASH += exposure.CASH * accountBucket.balance;
  });

  if (total <= 0) {
    return { US_EQUITY: 0, INTL_EQUITY: 0, BONDS: 0, CASH: 0, totalEquity: 0 };
  }

  const allocation = {
    US_EQUITY: clamp01(totals.US_EQUITY / total),
    INTL_EQUITY: clamp01(totals.INTL_EQUITY / total),
    BONDS: clamp01(totals.BONDS / total),
    CASH: clamp01(totals.CASH / total),
  };
  return {
    ...allocation,
    totalEquity: clamp01(allocation.US_EQUITY + allocation.INTL_EQUITY),
  };
}

function bucketShares(data: SeedData, total: number): Record<PortfolioAssessmentBucket, number> {
  return PORTFOLIO_BUCKETS.reduce(
    (shares, bucket) => {
      shares[bucket] = total > 0 ? roundRate((bucketFor(data, bucket)?.balance ?? 0) / total) : 0;
      return shares;
    },
    {
      pretax: 0,
      roth: 0,
      taxable: 0,
      cash: 0,
      hsa: 0,
    } as Record<PortfolioAssessmentBucket, number>,
  );
}

function collectHoldings(input: {
  data: SeedData;
  totalPortfolio: number;
  inferredAssumptions: string[];
}): PortfolioHoldingConcentration[] {
  const bySymbol = new Map<
    string,
    {
      symbol: string;
      name: string | null;
      value: number;
      buckets: Set<PortfolioAssessmentBucket>;
      managed: boolean;
      accountShares: Array<{ accountName: string; share: number }>;
    }
  >();

  const add = (entry: {
    bucket: PortfolioAssessmentBucket;
    accountName: string;
    accountBalance: number;
    symbol: string;
    name?: string;
    value: number;
    managed: boolean;
  }) => {
    if (entry.value <= 0) {
      return;
    }
    const symbol = entry.symbol.toUpperCase();
    const existing =
      bySymbol.get(symbol) ??
      {
        symbol,
        name: entry.name ?? null,
        value: 0,
        buckets: new Set<PortfolioAssessmentBucket>(),
        managed: false,
        accountShares: [],
      };
    existing.value += entry.value;
    existing.buckets.add(entry.bucket);
    existing.managed = existing.managed || entry.managed;
    existing.accountShares.push({
      accountName: entry.accountName,
      share: entry.accountBalance > 0 ? entry.value / entry.accountBalance : 0,
    });
    bySymbol.set(symbol, existing);
  };

  PORTFOLIO_BUCKETS.forEach((bucket) => {
    const accountBucket = bucketFor(input.data, bucket);
    if (!accountBucket || accountBucket.balance <= 0) {
      return;
    }
    const sourceAccounts = accountBucket.sourceAccounts ?? [];
    if (sourceAccounts.length > 0) {
      sourceAccounts.forEach((account) => {
        (account.holdings ?? []).forEach((holding) => {
          add({
            bucket,
            accountName: account.name,
            accountBalance: account.balance,
            symbol: holding.symbol,
            name: holding.name,
            value: holding.value,
            managed: Boolean(account.managed),
          });
        });
      });
      return;
    }

    input.inferredAssumptions.push(
      `Used target allocation weights as synthetic holdings for ${bucket}; source-account holdings were unavailable.`,
    );
    Object.entries(accountBucket.targetAllocation).forEach(([symbol, weight]) => {
      add({
        bucket,
        accountName: `${bucket} bucket`,
        accountBalance: accountBucket.balance,
        symbol,
        value: Math.max(0, weight) * accountBucket.balance,
        managed: false,
      });
    });
  });

  return [...bySymbol.values()]
    .map((entry) => {
      const largestAccount = entry.accountShares.reduce<{
        accountName: string | null;
        share: number;
      }>(
        (best, item) => (item.share > best.share ? item : best),
        { accountName: null, share: 0 },
      );
      return {
        symbol: entry.symbol,
        name: entry.name,
        value: roundMoney(entry.value),
        portfolioShare:
          input.totalPortfolio > 0 ? roundRate(entry.value / input.totalPortfolio) : 0,
        largestAccountShare: roundRate(largestAccount.share),
        largestAccountName: largestAccount.accountName,
        buckets: [...entry.buckets].sort(),
        managed: entry.managed,
      };
    })
    .sort((left, right) => right.value - left.value);
}

function buildSpendingPhaseMetrics(input: {
  data: SeedData;
  path: PathResult;
  assessmentYear: number;
  inflation: number;
}): SpendingPhaseMetrics | null {
  const groups = {
    sixties: [] as number[],
    seventies: [] as number[],
    eightiesPlus: [] as number[],
  };

  input.path.yearlySeries.forEach((year) => {
    const robAge = ageInYear(input.data.household.robBirthDate, year.year);
    const realSpend = presentValue(
      year.medianSpending,
      year.year - input.assessmentYear,
      input.inflation,
    );
    if (robAge >= 60 && robAge < 70) {
      groups.sixties.push(realSpend);
    } else if (robAge >= 70 && robAge < 80) {
      groups.seventies.push(realSpend);
    } else if (robAge >= 80) {
      groups.eightiesPlus.push(realSpend);
    }
  });

  const averageRealSpend60s = roundMoney(average(groups.sixties));
  const averageRealSpend70s = roundMoney(average(groups.seventies));
  const averageRealSpend80Plus = roundMoney(average(groups.eightiesPlus));
  const denominator = averageRealSpend80Plus || averageRealSpend70s;
  const earlyToLateRealSpendRatio =
    denominator > 0 ? roundRate(averageRealSpend60s / denominator) : null;

  if (!averageRealSpend60s && !averageRealSpend70s && !averageRealSpend80Plus) {
    return null;
  }

  return {
    averageRealSpend60s,
    averageRealSpend70s,
    averageRealSpend80Plus,
    earlyToLateRealSpendRatio,
  };
}

function maxProjectedCashRunway(path: PathResult | null | undefined) {
  if (!path?.yearlySeries.length) {
    return null;
  }
  return roundYears(
    path.yearlySeries.reduce((max, year) => {
      const denominator = Math.max(1, year.medianSpending);
      return Math.max(max, year.medianCashBalance / denominator);
    }, 0),
  );
}

function dominantWithdrawalSource(year: PathYearResult): {
  source: AccountBucketType | 'none';
  amount: number;
} {
  const values: Array<{ source: AccountBucketType; amount: number }> = [
    { source: 'cash', amount: year.medianWithdrawalCash },
    { source: 'taxable', amount: year.medianWithdrawalTaxable },
    { source: 'pretax', amount: year.medianWithdrawalIra401k },
    { source: 'roth', amount: year.medianWithdrawalRoth },
  ];
  const best = values.reduce((winner, item) =>
    item.amount > winner.amount ? item : winner,
  );
  return best.amount > 0 ? best : { source: 'none', amount: 0 };
}

function buildRecommendedWithdrawalStages(input: {
  data: SeedData;
  assessmentYear: number;
}): WithdrawalOrderingStage[] {
  const robBirthYear = new Date(input.data.household.robBirthDate).getFullYear();
  const debbieBirthYear = new Date(input.data.household.debbieBirthDate).getFullYear();
  const earliestMedicareYear = Math.min(robBirthYear + 65, debbieBirthYear + 65);
  const retirementYear = new Date(input.data.income.salaryEndDate).getFullYear();
  const socialSecurityYears = input.data.income.socialSecurity.map((entry) => {
    const birthYear =
      entry.person.toLowerCase().includes('debbie') ? debbieBirthYear : robBirthYear;
    return birthYear + Math.round(entry.claimAge ?? 67);
  });
  const firstSocialSecurityYear = socialSecurityYears.length
    ? Math.min(...socialSecurityYears)
    : retirementYear;
  const ownerRmdYears = buildPretaxOwnerRmdYears(input.data);
  const firstRmdYear =
    ownerRmdYears.length > 0
      ? Math.min(...ownerRmdYears.map((entry) => entry.startYear))
      : Math.min(
          robBirthYear + getRmdStartAgeForBirthYear(robBirthYear),
          debbieBirthYear + getRmdStartAgeForBirthYear(debbieBirthYear),
        );

  return [
    {
      id: 'income_and_required_distributions',
      label: 'Income and required distributions first',
      yearRange: { startYear: input.assessmentYear, endYear: null },
      preferredOrder: ['wages', 'Social Security', 'RMDs', 'scheduled windfalls'],
      guardrails: [
        'Do not add voluntary pretax income until ACA, tax-bracket, and IRMAA targets are checked.',
      ],
    },
    {
      id: 'aca_bridge',
      label: 'ACA bridge MAGI control',
      yearRange: {
        startYear: Math.max(input.assessmentYear, retirementYear),
        endYear: Math.max(retirementYear, earliestMedicareYear - 1),
      },
      preferredOrder: ['cash buffer', 'taxable basis', 'Roth principal if needed', 'pretax only to target MAGI'],
      guardrails: [
        'Avoid stacking wages and Roth conversions in the same ACA eligibility year unless the subsidy loss is intentional.',
      ],
    },
    {
      id: 'low_income_conversion_window',
      label: 'Low-income conversion window',
      yearRange: {
        startYear: Math.max(input.assessmentYear, retirementYear + 1),
        endYear: Math.max(
          retirementYear,
          Math.min(firstSocialSecurityYear, earliestMedicareYear, firstRmdYear) - 1,
        ),
      },
      preferredOrder: ['taxable/cash for spending', 'pretax Roth conversions to explicit MAGI target', 'Roth reserve'],
      guardrails: [
        'Use explicit annual conversion caps and target-MAGI ceilings; report unused safe room by reason.',
      ],
    },
    {
      id: 'medicare_pre_rmd',
      label: 'Medicare before RMDs',
      yearRange: {
        startYear: earliestMedicareYear,
        endYear: Math.max(earliestMedicareYear, firstRmdYear - 1),
      },
      preferredOrder: ['cash', 'taxable', 'pretax to IRMAA headroom', 'Roth reserve'],
      guardrails: [
        'Smooth MAGI around IRMAA tiers instead of creating avoidable one-year spikes.',
      ],
    },
    {
      id: 'rmd_years',
      label: 'RMD years',
      yearRange: { startYear: firstRmdYear, endYear: null },
      preferredOrder: ['RMDs', 'cash', 'taxable', 'pretax above RMD only if brackets allow', 'Roth reserve'],
      guardrails: [
        'Model owner-specific RMD starts when pretax accounts belong to different spouses.',
      ],
    },
    {
      id: 'roth_reserve',
      label: 'Roth reserve',
      yearRange: { startYear: input.assessmentYear, endYear: null },
      preferredOrder: ['spend Roth last', 'use Roth earlier only for MAGI cliffs or deliberate estate policy'],
      guardrails: [
        'Surface every Roth-withdrawal exception so tax-free optionality is not consumed invisibly.',
      ],
    },
  ];
}

function buildPretaxOwnerRmdYears(
  data: SeedData,
  options: { useOverride?: boolean } = {},
) {
  const birthYearsByOwner = new Map([
    ['rob', new Date(data.household.robBirthDate).getFullYear()],
    ['debbie', new Date(data.household.debbieBirthDate).getFullYear()],
  ]);
  const accounts = data.accounts.pretax.sourceAccounts ?? [];
  return accounts
    .filter((account) => account.balance > 0 && account.owner)
    .map((account) => {
      const owner = account.owner!.trim().toLowerCase();
      const birthYear = birthYearsByOwner.get(owner);
      const legalStartAge = birthYear ? getRmdStartAgeForBirthYear(birthYear) : 75;
      const startAge =
        options.useOverride === false
          ? legalStartAge
          : data.rules.rmdPolicy?.startAgeOverride ?? legalStartAge;
      return {
        owner,
        birthYear: birthYear ?? null,
        legalStartAge,
        startAge,
        startYear: birthYear ? birthYear + startAge : Number.POSITIVE_INFINITY,
      };
    })
    .filter((entry) => Number.isFinite(entry.startYear));
}

function buildWithdrawalPathSummary(input: {
  data: SeedData;
  path: PathResult | null | undefined;
  activeRule: WithdrawalRule;
  assessmentYear: number;
}): WithdrawalPathSummary {
  const totalsBySource: Record<AccountBucketType, number> = {
    cash: 0,
    taxable: 0,
    pretax: 0,
    roth: 0,
  };
  const dominantWithdrawalSourceByYear: WithdrawalPathSummary['dominantWithdrawalSourceByYear'] = [];
  let firstPretaxWithdrawalYear: number | null = null;
  let firstRothWithdrawalYear: number | null = null;
  let firstAcaFullCostYear: number | null = null;

  input.path?.yearlySeries.forEach((year) => {
    totalsBySource.cash += year.medianWithdrawalCash;
    totalsBySource.taxable += year.medianWithdrawalTaxable;
    totalsBySource.pretax += year.medianWithdrawalIra401k;
    totalsBySource.roth += year.medianWithdrawalRoth;
    const dominant = dominantWithdrawalSource(year);
    dominantWithdrawalSourceByYear.push({
      year: year.year,
      source: dominant.source,
      amount: roundMoney(dominant.amount),
    });
    if (firstPretaxWithdrawalYear === null && year.medianWithdrawalIra401k > 0) {
      firstPretaxWithdrawalYear = year.year;
    }
    if (firstRothWithdrawalYear === null && year.medianWithdrawalRoth > 0) {
      firstRothWithdrawalYear = year.year;
    }
    if (
      firstAcaFullCostYear === null &&
      year.medianAcaPremiumEstimate > 0 &&
      year.medianNetAcaCost / Math.max(1, year.medianAcaPremiumEstimate) >= 0.8
    ) {
      firstAcaFullCostYear = year.year;
    }
  });

  const conversionAnnualCapBindingYears =
    input.path?.simulationDiagnostics.rothConversionEligibilityPath
      .filter(
        (entry) =>
          entry.annualPolicyMaxBinding || entry.safeRoomUnusedDueToAnnualPolicyMax > 500,
      )
      .map((entry) => entry.year) ?? [];

  const activeRuleAlignment: PortfolioStrategyAssessmentStatus =
    input.activeRule === 'tax_bracket_waterfall' || input.activeRule === 'guyton_klinger'
      ? 'pass'
      : input.activeRule === 'proportional'
        ? 'watch'
        : 'watch';
  const activeRuleDetail =
    input.activeRule === 'tax_bracket_waterfall'
      ? 'Tax-bracket waterfall is aligned with the default tax-aware ordering standard.'
      : input.activeRule === 'guyton_klinger'
        ? 'Guyton-Klinger keeps the default tax-aware order and adds spending guardrails.'
        : input.activeRule === 'proportional'
          ? 'Proportional withdrawals are transparent, but they can consume Roth and create avoidable MAGI before checking cliffs.'
          : 'Reverse waterfall is a tax-rate-hedge posture; it spends Roth early and should be explicit if that is the desired tradeoff.';

  return {
    activeRule: input.activeRule,
    activeRuleAlignment,
    activeRuleDetail,
    dominantWithdrawalSourceByYear,
    totalsBySource: {
      cash: roundMoney(totalsBySource.cash),
      taxable: roundMoney(totalsBySource.taxable),
      pretax: roundMoney(totalsBySource.pretax),
      roth: roundMoney(totalsBySource.roth),
    },
    firstPretaxWithdrawalYear,
    firstRothWithdrawalYear,
    firstAcaFullCostYear,
    conversionAnnualCapBindingYears,
    recommendedStages: buildRecommendedWithdrawalStages({
      data: input.data,
      assessmentYear: input.assessmentYear,
    }),
  };
}

function check(
  id: string,
  title: string,
  status: PortfolioStrategyAssessmentStatus,
  detail: string,
  recommendation: string,
  intermediateCalculations: Record<string, number | string | boolean | null>,
): PortfolioStrategyCheck {
  return {
    id,
    title,
    status,
    detail,
    recommendation,
    intermediateCalculations,
  };
}

function worstStatus(checks: PortfolioStrategyCheck[]): PortfolioStrategyAssessmentStatus {
  if (checks.some((item) => item.status === 'fail')) return 'fail';
  if (checks.some((item) => item.status === 'watch')) return 'watch';
  return 'pass';
}

function buildActionItems(checks: PortfolioStrategyCheck[]) {
  const has = (id: string) => checks.some((checkItem) => checkItem.id === id && checkItem.status !== 'pass');
  const items: PortfolioStrategyAssessment['actionItems'] = [];
  if (has('legacy_target_alignment') || has('spending_phase_shape')) {
    items.push({
      id: 'front_load_to_legacy_target',
      priority: 'high',
      action:
        'Solve an explicit front-loaded spend curve until median legacy is near the target band instead of merely maximizing solvency.',
      checkIds: ['legacy_target_alignment', 'spending_phase_shape'],
    });
  }
  if (has('aca_bridge_integrity')) {
    items.push({
      id: 'repair_aca_bridge',
      priority: 'high',
      action:
        'Suppress or resize pretax income and Roth conversions in ACA years that are paying near-full premium cost.',
      checkIds: ['aca_bridge_integrity'],
    });
  }
  if (has('roth_conversion_headroom')) {
    items.push({
      id: 'use_low_income_conversion_room',
      priority: 'medium',
      action:
        'Raise or phase the annual conversion cap only where the explicit MAGI target leaves safe room.',
      checkIds: ['roth_conversion_headroom'],
    });
  }
  if (has('cash_runway')) {
    items.push({
      id: 'sweep_excess_cash',
      priority: 'medium',
      action:
        'Keep the explicit runway buffer, then reinvest persistent excess cash according to the target allocation.',
      checkIds: ['cash_runway'],
    });
  }
  if (has('holding_concentration')) {
    items.push({
      id: 'review_concentration',
      priority: 'medium',
      action:
        'Review concentrated holdings and managed sleeves against fees, manager risk, and desired asset-class exposure.',
      checkIds: ['holding_concentration'],
    });
  }
  if (has('withdrawal_rule_alignment')) {
    items.push({
      id: 'make_withdrawal_rule_explicit',
      priority: 'medium',
      action:
        'Document why the active withdrawal rule beats the default tax-aware waterfall for this household.',
      checkIds: ['withdrawal_rule_alignment'],
    });
  }
  return items;
}

function buildRmdCheck(input: {
  data: SeedData;
}): PortfolioStrategyCheck {
  const pretaxAccounts = input.data.accounts.pretax.sourceAccounts ?? [];
  const positivePretaxAccounts = pretaxAccounts.filter((account) => account.balance > 0);
  const missingOwners = positivePretaxAccounts.filter(
    (account) => !account.owner || !account.owner.trim(),
  );
  const rmdYears = buildPretaxOwnerRmdYears(input.data);
  const legalRmdYears = buildPretaxOwnerRmdYears(input.data, { useOverride: false });
  const override = input.data.rules.rmdPolicy?.startAgeOverride ?? null;
  const expectedStartAges = [...new Set(legalRmdYears.map((entry) => entry.startAge))];
  const ownerSummary = rmdYears
    .map((entry) =>
      entry.startAge === entry.legalStartAge
        ? `${entry.owner}:${entry.startAge}`
        : `${entry.owner}:${entry.startAge} (legal ${entry.legalStartAge})`,
    )
    .join(', ');
  const overrideMismatchesLegalAge =
    override !== null && legalRmdYears.some((entry) => entry.startAge !== override);

  if (missingOwners.length > 0) {
    return check(
      'rmd_ownership_timing',
      'RMD ownership and timing',
      'watch',
      'One or more pretax source accounts are missing owner metadata, so owner-specific RMD timing is not fully auditable.',
      'Add owner metadata to every pretax source account before relying on RMD-year ordering.',
      {
        missingOwnerAccountCount: missingOwners.length,
        explicitOverrideAge: override,
      },
    );
  }

  if (override !== null && (expectedStartAges.length > 1 || overrideMismatchesLegalAge)) {
    return check(
      'rmd_ownership_timing',
      'RMD ownership and timing',
      'watch',
      overrideMismatchesLegalAge
        ? 'RMD override differs from the birth-year start age implied by pretax account ownership.'
        : 'A single RMD override is present while pretax ownership implies multiple owner-specific start ages.',
      'Model RMD timing by source-account owner and keep overrides aligned with current-law birth-year rules.',
      {
        explicitOverrideAge: override,
        ownerStartAges: ownerSummary,
      },
    );
  }

  return check(
    'rmd_ownership_timing',
    'RMD ownership and timing',
    'pass',
    'Pretax source accounts have owner metadata and the RMD start timing is auditable.',
    'Keep owner metadata attached to future account imports.',
    {
      explicitOverrideAge: override,
      ownerStartAges: ownerSummary || 'none',
    },
  );
}

function modelCompletenessFrom(inferredAssumptions: string[]): PortfolioStrategyModelCompleteness {
  return inferredAssumptions.length > 0 ? 'reconstructed' : 'faithful';
}

export function buildPortfolioStrategyAssessment(
  input: BuildPortfolioStrategyAssessmentInput,
): PortfolioStrategyAssessment {
  const inferredAssumptions: string[] = [];
  const generatedAtIso = input.generatedAtIso ?? new Date().toISOString();
  if (!input.generatedAtIso) {
    inferredAssumptions.push('Assessment timestamp defaulted to the current runtime clock.');
  }
  const parsedAsOf = new Date(generatedAtIso);
  const asOf = Number.isNaN(parsedAsOf.getTime()) ? new Date() : parsedAsOf;
  const assessmentYear = asOf.getFullYear();
  const robAge = ageOnDate(input.data.household.robBirthDate, asOf);
  const debbieAge = ageOnDate(input.data.household.debbieBirthDate, asOf);
  const youngestAge = Math.min(robAge, debbieAge);
  const oldestAge = Math.max(robAge, debbieAge);
  const planningEndAge = Math.max(
    input.assumptions.robPlanningEndAge,
    input.assumptions.debbiePlanningEndAge,
  );
  const yearsToPlanningEnd = Math.max(0, planningEndAge - youngestAge);
  const totalPortfolio = totalPortfolioValue(input.data);
  const spendingNow = annualSpending(input.data);
  const activeRule = input.assumptions.withdrawalRule ?? 'tax_bracket_waterfall';
  const targetLegacy =
    input.legacyTargetTodayDollars ??
    input.data.goals?.legacyTargetTodayDollars ??
    DEFAULT_LEGACY_TARGET_TODAY_DOLLARS;
  if (
    input.legacyTargetTodayDollars === undefined &&
    input.data.goals?.legacyTargetTodayDollars === undefined
  ) {
    inferredAssumptions.push('Legacy target defaulted to $1,000,000 because no explicit goal was supplied.');
  }
  if (!input.path) {
    inferredAssumptions.push('No simulation path supplied; path-dependent checks are unavailable.');
  }
  if (
    input.data.rules.assetClassMappingAssumptions?.CENTRAL_MANAGED &&
    input.data.rules.assetClassMappingEvidence?.CENTRAL_MANAGED !== 'exact_lookthrough'
  ) {
    inferredAssumptions.push('CENTRAL_MANAGED asset mapping is configured but not marked as exact look-through evidence.');
  }
  if (
    input.data.rules.assetClassMappingAssumptions?.TRP_2030 &&
    input.data.rules.assetClassMappingEvidence?.TRP_2030 !== 'exact_lookthrough'
  ) {
    inferredAssumptions.push('TRP_2030 asset mapping is configured but not marked as exact look-through evidence.');
  }

  const standards = mergeStandards(
    buildDefaultStandards({ youngestAge, yearsToPlanningEnd }),
    input.standards,
  );
  const allocation = buildPortfolioAllocation(input.data);
  const holdingConcentrations = collectHoldings({
    data: input.data,
    totalPortfolio,
    inferredAssumptions,
  });
  const managedSleeveValue = PORTFOLIO_BUCKETS.reduce((total, bucket) => {
    const accountBucket = bucketFor(input.data, bucket);
    return (
      total +
      (accountBucket?.sourceAccounts ?? [])
        .filter((account) => account.managed)
        .reduce((sum, account) => sum + Math.max(0, account.balance), 0)
    );
  }, 0);
  const managedSleeveShare = totalPortfolio > 0 ? roundRate(managedSleeveValue / totalPortfolio) : 0;
  const largestHolding = holdingConcentrations[0] ?? null;
  const holdingsOverPortfolioLimit = holdingConcentrations.filter(
    (holding) => holding.portfolioShare > standards.maxSingleHoldingPortfolioShare,
  );
  const holdingsOverAccountLimit = holdingConcentrations.filter(
    (holding) =>
      holding.largestAccountShare > standards.maxSingleHoldingAccountShare &&
      holding.portfolioShare >= 0.05,
  );

  const currentCashRunwayYears =
    spendingNow > 0 ? roundYears((input.data.accounts.cash.balance ?? 0) / spendingNow) : 0;
  const projectedCashRunwayYears = maxProjectedCashRunway(input.path);
  const spendingPhase = input.path
    ? buildSpendingPhaseMetrics({
        data: input.data,
        path: input.path,
        assessmentYear,
        inflation: input.assumptions.inflation,
      })
    : null;
  const planningHorizonYears =
    input.path?.monteCarloMetadata.planningHorizonYears ??
    Math.max(0, (input.path?.yearlySeries.at(-1)?.year ?? assessmentYear) - assessmentYear);
  const medianEndingWealthNominal = input.path?.medianEndingWealth ?? null;
  const medianEndingWealthTodayDollars =
    medianEndingWealthNominal === null
      ? null
      : roundMoney(
          presentValue(
            medianEndingWealthNominal,
            planningHorizonYears,
            input.assumptions.inflation,
          ),
        );
  const medianLegacyToTargetRatio =
    medianEndingWealthTodayDollars !== null && targetLegacy > 0
      ? roundRate(medianEndingWealthTodayDollars / targetLegacy)
      : null;
  const supportedAnnualSpendTodayDollars =
    input.supportedAnnualSpendTodayDollars ?? null;
  const supportedSpendGapAnnual =
    supportedAnnualSpendTodayDollars === null
      ? null
      : roundMoney(supportedAnnualSpendTodayDollars - spendingNow);

  const withdrawalOrdering = buildWithdrawalPathSummary({
    data: input.data,
    path: input.path,
    activeRule,
    assessmentYear,
  });

  const checks: PortfolioStrategyCheck[] = [];
  checks.push(
    check(
      'age_allocation_fit',
      'Age and horizon allocation fit',
      worstStatus([
        check(
          'total_equity_fit',
          'Total equity fit',
          allocationStatus(allocation.totalEquity, standards.targetTotalEquityShare),
          '',
          '',
          {},
        ),
        check(
          'bond_fit',
          'Bond fit',
          allocationStatus(allocation.BONDS, standards.targetBondShare),
          '',
          '',
          {},
        ),
      ]),
      `Portfolio is ${Math.round(allocation.totalEquity * 100)}% equity and ${Math.round(
        allocation.BONDS * 100,
      )}% bonds against the ${standards.ageBand.replace(/_/g, ' ')} standard band.`,
      'Keep the target allocation explicit by age band; rebalance only if it drifts outside the stated band.',
      {
        totalEquityShare: roundRate(allocation.totalEquity),
        totalEquityBandMin: standards.targetTotalEquityShare.min,
        totalEquityBandMax: standards.targetTotalEquityShare.max,
        bondShare: roundRate(allocation.BONDS),
        bondBandMin: standards.targetBondShare.min,
        bondBandMax: standards.targetBondShare.max,
      },
    ),
  );

  const cashRunwayStatus =
    projectedCashRunwayYears !== null &&
    projectedCashRunwayYears > standards.cashRunwayYears.max * 1.5
      ? 'fail'
      : currentCashRunwayYears < standards.cashRunwayYears.min ||
          currentCashRunwayYears > standards.cashRunwayYears.max ||
          (projectedCashRunwayYears !== null &&
            projectedCashRunwayYears > standards.cashRunwayYears.max)
        ? 'watch'
        : 'pass';
  checks.push(
    check(
      'cash_runway',
      'Cash runway',
      cashRunwayStatus,
      `Current cash runway is ${currentCashRunwayYears.toFixed(2)} years${
        projectedCashRunwayYears !== null
          ? `; projected peak median cash runway is ${projectedCashRunwayYears.toFixed(2)} years`
          : ''
      }.`,
      'Target the explicit cash-runway band and reinvest persistent excess cash rather than letting windfalls sit idle.',
      {
        currentCashRunwayYears,
        maxProjectedCashRunwayYears: projectedCashRunwayYears,
        standardMinYears: standards.cashRunwayYears.min,
        standardMaxYears: standards.cashRunwayYears.max,
      },
    ),
  );

  const legacyStatus =
    medianLegacyToTargetRatio === null
      ? 'watch'
      : medianLegacyToTargetRatio > standards.legacyTargetBand.upperMultiple * 2
        ? 'fail'
        : medianLegacyToTargetRatio > standards.legacyTargetBand.upperMultiple ||
            medianLegacyToTargetRatio < standards.legacyTargetBand.lowerMultiple
          ? 'watch'
          : 'pass';
  checks.push(
    check(
      'legacy_target_alignment',
      'Legacy target alignment',
      legacyStatus,
      medianLegacyToTargetRatio === null
        ? 'No simulation ending-wealth path was supplied, so legacy alignment cannot be measured.'
        : `Median ending wealth is about ${medianLegacyToTargetRatio.toFixed(2)}x the legacy target in today-dollar terms.`,
      'For a maximize-early-spending north star, solve spending until median legacy sits near the target band rather than far above it.',
      {
        legacyTargetTodayDollars: targetLegacy,
        medianEndingWealthNominal,
        medianEndingWealthTodayDollars,
        medianLegacyToTargetRatio,
        targetBandLowerMultiple: standards.legacyTargetBand.lowerMultiple,
        targetBandUpperMultiple: standards.legacyTargetBand.upperMultiple,
      },
    ),
  );

  const spendRatio = spendingPhase?.earlyToLateRealSpendRatio ?? null;
  checks.push(
    check(
      'spending_phase_shape',
      'Early spending shape',
      spendRatio === null
        ? 'watch'
        : spendRatio >= standards.minimumEarlyToLateRealSpendRatio
          ? 'pass'
          : 'watch',
      spendRatio === null
        ? 'No path spending series was supplied, so early-versus-late spend shape cannot be measured.'
        : `Average real spending in the 60s is ${spendRatio.toFixed(2)}x late-life spending.`,
      'Use a front-loaded spend schedule when the goal is to spend more in the healthy early-retirement years.',
      {
        earlyToLateRealSpendRatio: spendRatio,
        minimumRatio: standards.minimumEarlyToLateRealSpendRatio,
        averageRealSpend60s: spendingPhase?.averageRealSpend60s ?? null,
        averageRealSpend70s: spendingPhase?.averageRealSpend70s ?? null,
        averageRealSpend80Plus: spendingPhase?.averageRealSpend80Plus ?? null,
      },
    ),
  );

  const fullCostAcaYears =
    input.path?.yearlySeries.filter(
      (year) =>
        year.medianAcaPremiumEstimate > 0 &&
        year.medianNetAcaCost / Math.max(1, year.medianAcaPremiumEstimate) >= 0.8,
    ) ?? [];
  const maxAcaNetCost = fullCostAcaYears.reduce(
    (max, year) => Math.max(max, year.medianNetAcaCost),
    0,
  );
  checks.push(
    check(
      'aca_bridge_integrity',
      'ACA bridge integrity',
      fullCostAcaYears.length && maxAcaNetCost >= 15_000
        ? 'fail'
        : fullCostAcaYears.length
          ? 'watch'
          : 'pass',
      fullCostAcaYears.length
        ? `ACA years paying near-full premium cost: ${fullCostAcaYears
            .map((year) => year.year)
            .join(', ')}.`
        : 'No near-full-cost ACA year detected in the supplied path.',
      'Avoid voluntary MAGI spikes in ACA bridge years unless the model explicitly accepts the subsidy tradeoff.',
      {
        nearFullCostAcaYearCount: fullCostAcaYears.length,
        firstNearFullCostAcaYear: fullCostAcaYears[0]?.year ?? null,
        maxNearFullCostAcaNetCost: roundMoney(maxAcaNetCost),
      },
    ),
  );

  const conversionEntries = input.path?.simulationDiagnostics.rothConversionEligibilityPath ?? [];
  const annualCapBindingYears = conversionEntries.filter(
    (entry) =>
      entry.annualPolicyMaxBinding || entry.safeRoomUnusedDueToAnnualPolicyMax > 500,
  );
  const safeRoomUnusedDueToAnnualPolicyMax = annualCapBindingYears.reduce(
    (total, entry) => total + Math.max(0, entry.safeRoomUnusedDueToAnnualPolicyMax),
    0,
  );
  const conversionPolicy = input.data.rules.rothConversionPolicy;
  const lowIncomeTarget = conversionPolicy?.lowIncomeBracketFill?.annualTargetDollars ?? null;
  const annualMax = conversionPolicy?.maxAnnualDollars ?? null;
  const policyCapBelowTarget =
    lowIncomeTarget !== null && annualMax !== null && annualMax < lowIncomeTarget;
  checks.push(
    check(
      'roth_conversion_headroom',
      'Roth conversion headroom',
      annualCapBindingYears.length > 0 || policyCapBelowTarget ? 'watch' : 'pass',
      annualCapBindingYears.length > 0
        ? `Annual conversion cap or policy limit binds in ${annualCapBindingYears.length} year(s).`
        : policyCapBelowTarget
          ? 'Low-income bracket fill target is above the annual conversion cap.'
          : 'No annual conversion cap binding detected in the supplied path.',
      'Track unused conversion room by reason and use the explicit low-income window where ACA and IRMAA ceilings permit.',
      {
        annualCapBindingYearCount: annualCapBindingYears.length,
        safeRoomUnusedDueToAnnualPolicyMax: roundMoney(safeRoomUnusedDueToAnnualPolicyMax),
        lowIncomeBracketFillTarget: lowIncomeTarget,
        annualConversionMax: annualMax,
        policyCapBelowTarget,
      },
    ),
  );

  checks.push(buildRmdCheck({ data: input.data }));

  const concentrationStatus =
    holdingsOverPortfolioLimit.length > 0 ||
    holdingsOverAccountLimit.length > 0 ||
    managedSleeveShare > standards.maxManagedSleevePortfolioShare * 2
      ? 'fail'
      : managedSleeveShare > standards.maxManagedSleevePortfolioShare
        ? 'watch'
        : 'pass';
  checks.push(
    check(
      'holding_concentration',
      'Holding concentration',
      concentrationStatus,
      largestHolding
        ? `Largest holding is ${largestHolding.symbol} at ${Math.round(
            largestHolding.portfolioShare * 100,
          )}% of portfolio and ${Math.round(
            largestHolding.largestAccountShare * 100,
          )}% of its largest account.`
        : 'No holdings available for concentration analysis.',
      'Flag large single-fund, single-manager, and managed-sleeve exposures separately from asset-class allocation.',
      {
        largestHoldingSymbol: largestHolding?.symbol ?? null,
        largestHoldingPortfolioShare: largestHolding?.portfolioShare ?? null,
        largestHoldingAccountShare: largestHolding?.largestAccountShare ?? null,
        holdingsOverPortfolioLimitCount: holdingsOverPortfolioLimit.length,
        holdingsOverAccountLimitCount: holdingsOverAccountLimit.length,
        managedSleeveShare,
        managedSleeveLimit: standards.maxManagedSleevePortfolioShare,
      },
    ),
  );

  checks.push(
    check(
      'withdrawal_rule_alignment',
      'Withdrawal rule alignment',
      withdrawalOrdering.activeRuleAlignment,
      withdrawalOrdering.activeRuleDetail,
      'Keep withdrawal ordering as a first-class policy axis and compare it against the north-star spend and legacy objective.',
      {
        activeRule,
        firstPretaxWithdrawalYear: withdrawalOrdering.firstPretaxWithdrawalYear,
        firstRothWithdrawalYear: withdrawalOrdering.firstRothWithdrawalYear,
        firstAcaFullCostYear: withdrawalOrdering.firstAcaFullCostYear,
      },
    ),
  );

  return {
    version: 'portfolio_strategy_assessment_v1',
    generatedAtIso,
    status: worstStatus(checks),
    modelCompleteness: modelCompletenessFrom(inferredAssumptions),
    inferredAssumptions: [...new Set(inferredAssumptions)],
    householdContext: {
      assessmentYear,
      robAge,
      debbieAge,
      youngestAge,
      oldestAge,
      planningEndAge,
      withdrawalRule: activeRule,
      legacyTargetTodayDollars: targetLegacy,
    },
    standards,
    metrics: {
      totalPortfolioValue: roundMoney(totalPortfolio),
      currentAnnualSpending: roundMoney(spendingNow),
      supportedAnnualSpendTodayDollars:
        supportedAnnualSpendTodayDollars === null
          ? null
          : roundMoney(supportedAnnualSpendTodayDollars),
      supportedSpendGapAnnual,
      allocation: {
        US_EQUITY: roundRate(allocation.US_EQUITY),
        INTL_EQUITY: roundRate(allocation.INTL_EQUITY),
        BONDS: roundRate(allocation.BONDS),
        CASH: roundRate(allocation.CASH),
        totalEquity: roundRate(allocation.totalEquity),
      },
      bucketShares: bucketShares(input.data, totalPortfolio),
      currentCashRunwayYears,
      maxProjectedCashRunwayYears: projectedCashRunwayYears,
      medianEndingWealthNominal:
        medianEndingWealthNominal === null ? null : roundMoney(medianEndingWealthNominal),
      medianEndingWealthTodayDollars,
      medianLegacyToTargetRatio,
      spendingPhase,
      concentration: {
        largestHolding,
        holdingsOverPortfolioLimit,
        holdingsOverAccountLimit,
        managedSleeveShare,
      },
    },
    checks,
    withdrawalOrdering,
    actionItems: buildActionItems(checks),
  };
}
