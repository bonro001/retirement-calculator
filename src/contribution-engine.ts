import type {
  ContributionLimitSettings,
  PreRetirementContributionSettings,
} from './types';
import { CURRENT_LAW_2026_RULE_PACK } from './rule-packs';

export interface ContributionLimitProfile {
  employee401kBaseLimit: number;
  employee401kCatchUpAge: number;
  employee401kCatchUpLimit: number;
  employee401kSuperCatchUpAges: number[];
  employee401kSuperCatchUpLimit: number;
  rothCatchUpWageThreshold: number;
  hsaSelfLimit: number;
  hsaFamilyLimit: number;
  hsaCatchUpAge: number;
  hsaCatchUpLimit: number;
}

export interface ContributionCalculationInput {
  age: number;
  salaryAnnual: number;
  salaryThisYear?: number;
  retirementDate?: string;
  projectionYear?: number;
  salaryProrationRule?: SalaryProrationRule;
  filingStatus?: string;
  settings?: PreRetirementContributionSettings;
  limitSettings?: ContributionLimitSettings;
  currentPretaxBalance?: number;
  accountBalances?: {
    pretax: number;
    roth?: number;
    hsa?: number;
  };
}

export interface ContributionCalculationOutput {
  employee401kPreTaxContribution: number;
  employee401kRothContribution: number;
  employee401kContribution: number;
  employerMatchContribution: number;
  total401kContribution: number;
  hsaContribution: number;
  salaryThisYear: number;
  salaryFraction: number;
  employee401kAnnualLimit: number;
  employee401kRemainingRoom: number;
  employee401kBaseLimit: number;
  employee401kPreTaxAnnualLimit: number;
  employee401kCatchUpLimit: number;
  employee401kCatchUpContribution: number;
  employee401kRothRequiredCatchUpLimit: number;
  employee401kRothRequiredCatchUpContribution: number;
  employee401kCatchUpDisallowedDueToMissingRoth: number;
  rothCatchUpRequirementApplies: boolean;
  rothCatchUpWageThreshold: number;
  priorYearFicaWagesFromEmployer: number | null;
  employerPlanSupportsRothDeferrals: boolean;
  employerPlanSupportsSuperCatchUp: boolean;
  hsaAnnualLimit: number;
  hsaRemainingRoom: number;
  adjustedWages: number;
  taxableWageReduction: number;
  updatedPretaxBalance: number;
  updatedRothBalance: number;
  totalPretaxContribution: number;
  updatedAccountBalances: {
    pretax: number;
    roth?: number;
    hsa?: number;
  };
}

export type SalaryProrationRule = 'month_fraction' | 'daily';

export const DEFAULT_LIMITS: ContributionLimitProfile = {
  employee401kBaseLimit: CURRENT_LAW_2026_RULE_PACK.contributions.employee401kBaseLimit,
  employee401kCatchUpAge: CURRENT_LAW_2026_RULE_PACK.contributions.employee401kCatchUpAge,
  employee401kCatchUpLimit: CURRENT_LAW_2026_RULE_PACK.contributions.employee401kCatchUpLimit,
  employee401kSuperCatchUpAges: CURRENT_LAW_2026_RULE_PACK.contributions.employee401kSuperCatchUpAges,
  employee401kSuperCatchUpLimit: CURRENT_LAW_2026_RULE_PACK.contributions.employee401kSuperCatchUpLimit,
  rothCatchUpWageThreshold: CURRENT_LAW_2026_RULE_PACK.contributions.rothCatchUpWageThreshold,
  hsaSelfLimit: CURRENT_LAW_2026_RULE_PACK.contributions.hsaSelfLimit,
  hsaFamilyLimit: CURRENT_LAW_2026_RULE_PACK.contributions.hsaFamilyLimit,
  hsaCatchUpAge: CURRENT_LAW_2026_RULE_PACK.contributions.hsaCatchUpAge,
  hsaCatchUpLimit: CURRENT_LAW_2026_RULE_PACK.contributions.hsaCatchUpLimit,
};

function clamp(value: number, minimum = 0, maximum = Number.POSITIVE_INFINITY) {
  return Math.max(minimum, Math.min(value, maximum));
}

function toCurrency(value: number) {
  return Number(value.toFixed(2));
}

function deriveAnnualTargetFromAmountOrPercent(
  amount: number | undefined,
  amountByYear: Record<string, number> | undefined,
  percentOfSalary: number | undefined,
  salaryAnnual: number,
  projectionYear?: number,
) {
  const yearAmount =
    typeof projectionYear === 'number' ? amountByYear?.[String(projectionYear)] : undefined;
  if (typeof yearAmount === 'number' && yearAmount > 0) {
    return yearAmount;
  }
  if (typeof amount === 'number' && amount > 0) {
    return amount;
  }
  if (typeof percentOfSalary === 'number' && percentOfSalary > 0) {
    return salaryAnnual * percentOfSalary;
  }
  return 0;
}

function deriveRequestedTargetFromAmountOrPercent(
  amount: number | undefined,
  amountByYear: Record<string, number> | undefined,
  percentOfSalary: number | undefined,
  salaryThisYear: number,
  projectionYear?: number,
) {
  const yearAmount =
    typeof projectionYear === 'number' ? amountByYear?.[String(projectionYear)] : undefined;
  if (typeof yearAmount === 'number' && yearAmount > 0) {
    return yearAmount;
  }
  if (typeof amount === 'number' && amount > 0) {
    return amount;
  }
  if (typeof percentOfSalary === 'number' && percentOfSalary > 0) {
    return salaryThisYear * percentOfSalary;
  }
  return 0;
}

function resolveYearLimit(
  fallback: number,
  byYear: Record<string, number> | undefined,
  projectionYear: number | undefined,
) {
  if (typeof projectionYear !== 'number') {
    return fallback;
  }
  const value = byYear?.[String(projectionYear)];
  return typeof value === 'number' && value > 0 ? value : fallback;
}

export function resolveContributionLimitProfile(
  settings: ContributionLimitSettings | undefined,
  projectionYear?: number,
  fallback: ContributionLimitProfile = DEFAULT_LIMITS,
): ContributionLimitProfile {
  const base401k =
    settings?.employee401kBaseLimit ?? fallback.employee401kBaseLimit;
  const catchUp401k =
    settings?.employee401kCatchUpLimit ?? fallback.employee401kCatchUpLimit;
  const superCatchUp401k =
    settings?.employee401kSuperCatchUpLimit ?? fallback.employee401kSuperCatchUpLimit;
  const rothCatchUpWageThreshold =
    settings?.rothCatchUpWageThreshold ?? fallback.rothCatchUpWageThreshold;
  const hsaSelf = settings?.hsaSelfLimit ?? fallback.hsaSelfLimit;
  const hsaFamily = settings?.hsaFamilyLimit ?? fallback.hsaFamilyLimit;
  const hsaCatchUp = settings?.hsaCatchUpLimit ?? fallback.hsaCatchUpLimit;

  return {
    employee401kBaseLimit: resolveYearLimit(
      base401k,
      settings?.employee401kBaseLimitByYear,
      projectionYear,
    ),
    employee401kCatchUpAge:
      settings?.employee401kCatchUpAge ?? fallback.employee401kCatchUpAge,
    employee401kCatchUpLimit: resolveYearLimit(
      catchUp401k,
      settings?.employee401kCatchUpLimitByYear,
      projectionYear,
    ),
    employee401kSuperCatchUpAges:
      settings?.employee401kSuperCatchUpAges ?? fallback.employee401kSuperCatchUpAges,
    employee401kSuperCatchUpLimit: resolveYearLimit(
      superCatchUp401k,
      settings?.employee401kSuperCatchUpLimitByYear,
      projectionYear,
    ),
    rothCatchUpWageThreshold: resolveYearLimit(
      rothCatchUpWageThreshold,
      settings?.rothCatchUpWageThresholdByYear,
      projectionYear,
    ),
    hsaSelfLimit: resolveYearLimit(
      hsaSelf,
      settings?.hsaSelfLimitByYear,
      projectionYear,
    ),
    hsaFamilyLimit: resolveYearLimit(
      hsaFamily,
      settings?.hsaFamilyLimitByYear,
      projectionYear,
    ),
    hsaCatchUpAge: settings?.hsaCatchUpAge ?? fallback.hsaCatchUpAge,
    hsaCatchUpLimit: resolveYearLimit(
      hsaCatchUp,
      settings?.hsaCatchUpLimitByYear,
      projectionYear,
    ),
  };
}

export function deriveAnnual401kTargets(
  settings: PreRetirementContributionSettings | undefined,
  salaryAnnual: number,
  projectionYear?: number,
) {
  const preTaxAnnualTarget = deriveAnnualTargetFromAmountOrPercent(
    settings?.employee401kPreTaxAnnualAmount ?? settings?.employee401kAnnualAmount,
    settings?.employee401kPreTaxAnnualAmountByYear ?? settings?.employee401kAnnualAmountByYear,
    settings?.employee401kPreTaxPercentOfSalary ?? settings?.employee401kPercentOfSalary,
    salaryAnnual,
    projectionYear,
  );
  const rothAnnualTarget = deriveAnnualTargetFromAmountOrPercent(
    settings?.employee401kRothAnnualAmount,
    settings?.employee401kRothAnnualAmountByYear,
    settings?.employee401kRothPercentOfSalary,
    salaryAnnual,
    projectionYear,
  );

  return {
    preTaxAnnualTarget,
    rothAnnualTarget,
  };
}

export function deriveAnnualHsaTarget(
  settings: PreRetirementContributionSettings | undefined,
  salaryAnnual: number,
  projectionYear?: number,
) {
  return deriveAnnualTargetFromAmountOrPercent(
    settings?.hsaAnnualAmount,
    settings?.hsaAnnualAmountByYear,
    settings?.hsaPercentOfSalary,
    salaryAnnual,
    projectionYear,
  );
}

function isValidDate(value: string) {
  return !Number.isNaN(new Date(value).getTime());
}

function daysInUtcYear(year: number) {
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  return (end - start) / 86_400_000;
}

export function calculateSalaryProrationFraction(input: {
  retirementDate: string;
  projectionYear: number;
  rule?: SalaryProrationRule;
}) {
  if (!isValidDate(input.retirementDate)) {
    return 1;
  }

  const retirementDate = new Date(input.retirementDate);
  const retirementYear = retirementDate.getUTCFullYear();
  if (input.projectionYear < retirementYear) {
    return 1;
  }
  if (input.projectionYear > retirementYear) {
    return 0;
  }

  if (input.rule === 'daily') {
    const start = Date.UTC(input.projectionYear, 0, 1);
    const endExclusive = Date.UTC(
      retirementDate.getUTCFullYear(),
      retirementDate.getUTCMonth(),
      retirementDate.getUTCDate(),
    );
    return clamp((endExclusive - start) / 86_400_000 / daysInUtcYear(input.projectionYear), 0, 1);
  }

  return clamp(retirementDate.getUTCMonth() / 12, 0, 1);
}

export function calculateProratedSalary(input: {
  salaryAnnual: number;
  retirementDate?: string;
  projectionYear?: number;
  rule?: SalaryProrationRule;
}) {
  const salaryAnnual = clamp(input.salaryAnnual);
  if (
    typeof input.retirementDate === 'string' &&
    typeof input.projectionYear === 'number'
  ) {
    return salaryAnnual * calculateSalaryProrationFraction({
      retirementDate: input.retirementDate,
      projectionYear: input.projectionYear,
      rule: input.rule,
    });
  }
  return salaryAnnual;
}

function deriveSalaryThisYear(input: ContributionCalculationInput) {
  if (typeof input.salaryThisYear === 'number') {
    return clamp(input.salaryThisYear);
  }
  return calculateProratedSalary({
    salaryAnnual: input.salaryAnnual,
    retirementDate: input.retirementDate,
    projectionYear: input.projectionYear,
    rule: input.salaryProrationRule,
  });
}

function resolve401kCatchUpLimit(input: {
  age: number;
  settings: PreRetirementContributionSettings | undefined;
  limits: ContributionLimitProfile;
}) {
  if (input.age < input.limits.employee401kCatchUpAge) {
    return 0;
  }
  const supportsSuperCatchUp = input.settings?.employerPlanSupportsSuperCatchUp === true;
  if (
    supportsSuperCatchUp &&
    input.limits.employee401kSuperCatchUpAges.includes(Math.floor(input.age))
  ) {
    return input.limits.employee401kSuperCatchUpLimit;
  }
  return input.limits.employee401kCatchUpLimit;
}

export function calculatePreRetirementContributions(
  input: ContributionCalculationInput,
  limits: ContributionLimitProfile = DEFAULT_LIMITS,
): ContributionCalculationOutput {
  const effectiveLimits = resolveContributionLimitProfile(
    input.limitSettings,
    input.projectionYear,
    limits,
  );
  const salaryAnnual = clamp(input.salaryAnnual);
  const salaryThisYear = deriveSalaryThisYear(input);
  const settings = input.settings;
  const pretaxStartingBalance = input.accountBalances?.pretax ?? input.currentPretaxBalance ?? 0;
  const rothStartingBalance = input.accountBalances?.roth ?? 0;
  const hsaStartingBalance = input.accountBalances?.hsa;
  const salaryFraction = salaryAnnual > 0 ? clamp(salaryThisYear / salaryAnnual, 0, 1) : 0;

  const employerPlanSupportsRothDeferrals =
    settings?.employerPlanSupportsRothDeferrals === true;
  const employerPlanSupportsSuperCatchUp =
    settings?.employerPlanSupportsSuperCatchUp === true;
  const catchUpLimit = resolve401kCatchUpLimit({
    age: input.age,
    settings,
    limits: effectiveLimits,
  });
  const priorYearFicaWagesFromEmployer =
    typeof settings?.priorYearFicaWagesFromEmployer === 'number'
      ? clamp(settings.priorYearFicaWagesFromEmployer)
      : null;
  const rothCatchUpRequirementApplies =
    catchUpLimit > 0 &&
    typeof priorYearFicaWagesFromEmployer === 'number' &&
    priorYearFicaWagesFromEmployer > effectiveLimits.rothCatchUpWageThreshold;
  const catchUpDisallowedDueToMissingRoth =
    rothCatchUpRequirementApplies && !employerPlanSupportsRothDeferrals
      ? catchUpLimit
      : 0;
  const annual401kLimit =
    effectiveLimits.employee401kBaseLimit +
    Math.max(0, catchUpLimit - catchUpDisallowedDueToMissingRoth);
  const preTaxAnnual401kLimit =
    rothCatchUpRequirementApplies
      ? effectiveLimits.employee401kBaseLimit
      : annual401kLimit;
  const rothRequiredCatchUpLimit =
    rothCatchUpRequirementApplies && employerPlanSupportsRothDeferrals
      ? catchUpLimit
      : 0;
  const requestedPreTaxContribution = clamp(
    deriveRequestedTargetFromAmountOrPercent(
      settings?.employee401kPreTaxAnnualAmount ?? settings?.employee401kAnnualAmount,
      settings?.employee401kPreTaxAnnualAmountByYear ?? settings?.employee401kAnnualAmountByYear,
      settings?.employee401kPreTaxPercentOfSalary ?? settings?.employee401kPercentOfSalary,
      salaryThisYear,
      input.projectionYear,
    ),
    0,
    salaryThisYear,
  );
  const requestedRothContribution = clamp(
    deriveRequestedTargetFromAmountOrPercent(
      settings?.employee401kRothAnnualAmount,
      settings?.employee401kRothAnnualAmountByYear,
      settings?.employee401kRothPercentOfSalary,
      salaryThisYear,
      input.projectionYear,
    ),
    0,
    salaryThisYear,
  );
  const requestedTotalEmployeeContribution = requestedPreTaxContribution + requestedRothContribution;
  const employee401kContribution = clamp(
    Math.min(requestedTotalEmployeeContribution, annual401kLimit, salaryThisYear),
  );

  let employee401kPreTaxContribution = requestedPreTaxContribution;
  let employee401kRothContribution = requestedRothContribution;
  if (rothCatchUpRequirementApplies && employerPlanSupportsRothDeferrals) {
    employee401kPreTaxContribution = Math.min(
      requestedPreTaxContribution,
      preTaxAnnual401kLimit,
      employee401kContribution,
    );
    const preTaxElectionOverflow = Math.max(
      0,
      requestedPreTaxContribution - preTaxAnnual401kLimit,
    );
    const rothRequestedOrRequired = requestedRothContribution + preTaxElectionOverflow;
    employee401kRothContribution = Math.min(
      rothRequestedOrRequired,
      Math.max(0, employee401kContribution - employee401kPreTaxContribution),
    );
  } else if (requestedTotalEmployeeContribution > 0 && employee401kContribution < requestedTotalEmployeeContribution) {
    const scale = employee401kContribution / requestedTotalEmployeeContribution;
    employee401kPreTaxContribution = requestedPreTaxContribution * scale;
    employee401kRothContribution = requestedRothContribution * scale;
  }

  employee401kPreTaxContribution = Math.min(
    employee401kPreTaxContribution,
    preTaxAnnual401kLimit,
  );
  employee401kRothContribution = Math.min(
    employee401kRothContribution,
    Math.max(0, employee401kContribution - employee401kPreTaxContribution),
  );

  const matchRate = clamp(settings?.employerMatch?.matchRate ?? 0, 0, 2);
  const matchCapPercent = clamp(
    settings?.employerMatch?.maxEmployeeContributionPercentOfSalary ?? 0,
    0,
    1,
  );
  const maxMatchEligibleEmployeeContribution = salaryThisYear * matchCapPercent;
  const employerMatchContribution =
    Math.min(employee401kContribution, maxMatchEligibleEmployeeContribution) * matchRate;

  const baseHsaLimit =
    settings?.hsaCoverageType === 'self'
      ? effectiveLimits.hsaSelfLimit
      : effectiveLimits.hsaFamilyLimit;
  const annualHsaLimit =
    baseHsaLimit +
    (input.age >= effectiveLimits.hsaCatchUpAge
      ? effectiveLimits.hsaCatchUpLimit
      : 0);
  const requestedHsaTarget = deriveRequestedTargetFromAmountOrPercent(
    settings?.hsaAnnualAmount,
    settings?.hsaAnnualAmountByYear,
    settings?.hsaPercentOfSalary,
    salaryThisYear,
    input.projectionYear,
  );
  const maxHsaByPayroll = Math.max(salaryThisYear - employee401kPreTaxContribution, 0);
  const hsaContribution = clamp(Math.min(requestedHsaTarget, annualHsaLimit, maxHsaByPayroll));

  const total401kContribution = employee401kContribution + employerMatchContribution;
  const totalPretaxContribution =
    employee401kPreTaxContribution + employerMatchContribution + hsaContribution;
  const taxableWageReduction = employee401kPreTaxContribution + hsaContribution;
  const adjustedWages = Math.max(salaryThisYear - taxableWageReduction, 0);
  const updatedPretaxBalance = pretaxStartingBalance + totalPretaxContribution;
  const updatedRothBalance = rothStartingBalance + employee401kRothContribution;
  const updatedHsaBalance =
    typeof hsaStartingBalance === 'number' ? hsaStartingBalance + hsaContribution : undefined;
  const employee401kRemainingRoom = Math.max(0, annual401kLimit - employee401kContribution);
  const employee401kCatchUpContribution = Math.max(
    0,
    employee401kContribution - effectiveLimits.employee401kBaseLimit,
  );
  const employee401kRothRequiredCatchUpContribution = rothCatchUpRequirementApplies
    ? Math.min(employee401kRothContribution, employee401kCatchUpContribution)
    : 0;
  const hsaRemainingRoom = Math.max(0, annualHsaLimit - hsaContribution);

  return {
    employee401kPreTaxContribution: toCurrency(employee401kPreTaxContribution),
    employee401kRothContribution: toCurrency(employee401kRothContribution),
    employee401kContribution: toCurrency(employee401kContribution),
    employerMatchContribution: toCurrency(employerMatchContribution),
    total401kContribution: toCurrency(total401kContribution),
    hsaContribution: toCurrency(hsaContribution),
    salaryThisYear: toCurrency(salaryThisYear),
    salaryFraction: toCurrency(salaryFraction),
    employee401kAnnualLimit: toCurrency(annual401kLimit),
    employee401kRemainingRoom: toCurrency(employee401kRemainingRoom),
    employee401kBaseLimit: toCurrency(effectiveLimits.employee401kBaseLimit),
    employee401kPreTaxAnnualLimit: toCurrency(preTaxAnnual401kLimit),
    employee401kCatchUpLimit: toCurrency(catchUpLimit),
    employee401kCatchUpContribution: toCurrency(employee401kCatchUpContribution),
    employee401kRothRequiredCatchUpLimit: toCurrency(rothRequiredCatchUpLimit),
    employee401kRothRequiredCatchUpContribution: toCurrency(
      employee401kRothRequiredCatchUpContribution,
    ),
    employee401kCatchUpDisallowedDueToMissingRoth: toCurrency(
      catchUpDisallowedDueToMissingRoth,
    ),
    rothCatchUpRequirementApplies,
    rothCatchUpWageThreshold: toCurrency(effectiveLimits.rothCatchUpWageThreshold),
    priorYearFicaWagesFromEmployer:
      priorYearFicaWagesFromEmployer === null
        ? null
        : toCurrency(priorYearFicaWagesFromEmployer),
    employerPlanSupportsRothDeferrals,
    employerPlanSupportsSuperCatchUp,
    hsaAnnualLimit: toCurrency(annualHsaLimit),
    hsaRemainingRoom: toCurrency(hsaRemainingRoom),
    adjustedWages: toCurrency(adjustedWages),
    taxableWageReduction: toCurrency(taxableWageReduction),
    updatedPretaxBalance: toCurrency(updatedPretaxBalance),
    updatedRothBalance: toCurrency(updatedRothBalance),
    totalPretaxContribution: toCurrency(totalPretaxContribution),
    updatedAccountBalances: {
      pretax: toCurrency(updatedPretaxBalance),
      roth: toCurrency(updatedRothBalance),
      hsa: typeof updatedHsaBalance === 'number' ? toCurrency(updatedHsaBalance) : undefined,
    },
  };
}
