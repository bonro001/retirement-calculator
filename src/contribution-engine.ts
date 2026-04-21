import type { PreRetirementContributionSettings } from './types';

export interface ContributionLimitProfile {
  employee401kBaseLimit: number;
  employee401kCatchUpAge: number;
  employee401kCatchUpLimit: number;
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
  filingStatus?: string;
  settings?: PreRetirementContributionSettings;
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

const DEFAULT_LIMITS: ContributionLimitProfile = {
  employee401kBaseLimit: 24_000,
  employee401kCatchUpAge: 50,
  employee401kCatchUpLimit: 7_500,
  hsaSelfLimit: 4_300,
  hsaFamilyLimit: 8_550,
  hsaCatchUpAge: 55,
  hsaCatchUpLimit: 1_000,
};

function clamp(value: number, minimum = 0, maximum = Number.POSITIVE_INFINITY) {
  return Math.max(minimum, Math.min(value, maximum));
}

function toCurrency(value: number) {
  return Number(value.toFixed(2));
}

function deriveAnnualTargetFromAmountOrPercent(
  amount: number | undefined,
  percentOfSalary: number | undefined,
  salaryAnnual: number,
) {
  if (typeof amount === 'number' && amount > 0) {
    return amount;
  }
  if (typeof percentOfSalary === 'number' && percentOfSalary > 0) {
    return salaryAnnual * percentOfSalary;
  }
  return 0;
}

export function deriveAnnual401kTargets(
  settings: PreRetirementContributionSettings | undefined,
  salaryAnnual: number,
) {
  const preTaxAnnualTarget = deriveAnnualTargetFromAmountOrPercent(
    settings?.employee401kPreTaxAnnualAmount ?? settings?.employee401kAnnualAmount,
    settings?.employee401kPreTaxPercentOfSalary ?? settings?.employee401kPercentOfSalary,
    salaryAnnual,
  );
  const rothAnnualTarget = deriveAnnualTargetFromAmountOrPercent(
    settings?.employee401kRothAnnualAmount,
    settings?.employee401kRothPercentOfSalary,
    salaryAnnual,
  );

  return {
    preTaxAnnualTarget,
    rothAnnualTarget,
  };
}

export function deriveAnnualHsaTarget(
  settings: PreRetirementContributionSettings | undefined,
  salaryAnnual: number,
) {
  return deriveAnnualTargetFromAmountOrPercent(
    settings?.hsaAnnualAmount,
    settings?.hsaPercentOfSalary,
    salaryAnnual,
  );
}

function isValidDate(value: string) {
  return !Number.isNaN(new Date(value).getTime());
}

function deriveSalaryThisYear(input: ContributionCalculationInput) {
  const salaryAnnual = clamp(input.salaryAnnual);
  if (typeof input.salaryThisYear === 'number') {
    return clamp(input.salaryThisYear);
  }

  if (
    typeof input.retirementDate === 'string' &&
    typeof input.projectionYear === 'number' &&
    isValidDate(input.retirementDate)
  ) {
    const retirementDate = new Date(input.retirementDate);
    const retirementYear = retirementDate.getFullYear();
    if (input.projectionYear < retirementYear) {
      return salaryAnnual;
    }
    if (input.projectionYear > retirementYear) {
      return 0;
    }

    const monthFraction = clamp(
      (retirementDate.getMonth() + retirementDate.getDate() / 30) / 12,
      0,
      1,
    );
    return salaryAnnual * monthFraction;
  }

  return salaryAnnual;
}

export function calculatePreRetirementContributions(
  input: ContributionCalculationInput,
  limits: ContributionLimitProfile = DEFAULT_LIMITS,
): ContributionCalculationOutput {
  const salaryAnnual = clamp(input.salaryAnnual);
  const salaryThisYear = deriveSalaryThisYear(input);
  const settings = input.settings;
  const pretaxStartingBalance = input.accountBalances?.pretax ?? input.currentPretaxBalance ?? 0;
  const rothStartingBalance = input.accountBalances?.roth ?? 0;
  const hsaStartingBalance = input.accountBalances?.hsa;
  const salaryFraction = salaryAnnual > 0 ? clamp(salaryThisYear / salaryAnnual, 0, 1) : 0;

  const annual401kTargets = deriveAnnual401kTargets(settings, salaryAnnual);
  const annual401kLimit =
    limits.employee401kBaseLimit +
    (input.age >= limits.employee401kCatchUpAge ? limits.employee401kCatchUpLimit : 0);
  const requestedPreTaxContribution = clamp(
    annual401kTargets.preTaxAnnualTarget * salaryFraction,
    0,
    salaryThisYear,
  );
  const requestedRothContribution = clamp(
    annual401kTargets.rothAnnualTarget * salaryFraction,
    0,
    salaryThisYear,
  );
  const requestedTotalEmployeeContribution = requestedPreTaxContribution + requestedRothContribution;
  const employee401kContribution = clamp(
    Math.min(requestedTotalEmployeeContribution, annual401kLimit, salaryThisYear),
  );

  let employee401kPreTaxContribution = requestedPreTaxContribution;
  let employee401kRothContribution = requestedRothContribution;
  if (requestedTotalEmployeeContribution > 0 && employee401kContribution < requestedTotalEmployeeContribution) {
    const scale = employee401kContribution / requestedTotalEmployeeContribution;
    employee401kPreTaxContribution = requestedPreTaxContribution * scale;
    employee401kRothContribution = requestedRothContribution * scale;
  }

  const matchRate = clamp(settings?.employerMatch?.matchRate ?? 0, 0, 2);
  const matchCapPercent = clamp(
    settings?.employerMatch?.maxEmployeeContributionPercentOfSalary ?? 0,
    0,
    1,
  );
  const maxMatchEligibleEmployeeContribution = salaryThisYear * matchCapPercent;
  const employerMatchContribution =
    Math.min(employee401kContribution, maxMatchEligibleEmployeeContribution) * matchRate;

  const annualHsaTarget = deriveAnnualHsaTarget(settings, salaryAnnual);
  const baseHsaLimit =
    settings?.hsaCoverageType === 'self' ? limits.hsaSelfLimit : limits.hsaFamilyLimit;
  const annualHsaLimit =
    baseHsaLimit + (input.age >= limits.hsaCatchUpAge ? limits.hsaCatchUpLimit : 0);
  const proratedHsaTarget = annualHsaTarget * salaryFraction;
  const maxHsaByPayroll = Math.max(salaryThisYear - employee401kPreTaxContribution, 0);
  const hsaContribution = clamp(Math.min(proratedHsaTarget, annualHsaLimit, maxHsaByPayroll));

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
