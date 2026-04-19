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
    hsa?: number;
  };
}

export interface ContributionCalculationOutput {
  employee401kContribution: number;
  employerMatchContribution: number;
  total401kContribution: number;
  hsaContribution: number;
  adjustedWages: number;
  taxableWageReduction: number;
  updatedPretaxBalance: number;
  totalPretaxContribution: number;
  updatedAccountBalances: {
    pretax: number;
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
  const hsaStartingBalance = input.accountBalances?.hsa;
  const salaryFraction = salaryAnnual > 0 ? clamp(salaryThisYear / salaryAnnual, 0, 1) : 0;

  const annual401kTarget = deriveAnnualTargetFromAmountOrPercent(
    settings?.employee401kAnnualAmount,
    settings?.employee401kPercentOfSalary,
    salaryAnnual,
  );
  const annual401kLimit =
    limits.employee401kBaseLimit +
    (input.age >= limits.employee401kCatchUpAge ? limits.employee401kCatchUpLimit : 0);
  const prorated401kTarget = annual401kTarget * salaryFraction;
  const employee401kContribution = clamp(
    Math.min(prorated401kTarget, annual401kLimit, salaryThisYear),
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

  const annualHsaTarget = deriveAnnualTargetFromAmountOrPercent(
    settings?.hsaAnnualAmount,
    settings?.hsaPercentOfSalary,
    salaryAnnual,
  );
  const baseHsaLimit =
    settings?.hsaCoverageType === 'self' ? limits.hsaSelfLimit : limits.hsaFamilyLimit;
  const annualHsaLimit =
    baseHsaLimit + (input.age >= limits.hsaCatchUpAge ? limits.hsaCatchUpLimit : 0);
  const proratedHsaTarget = annualHsaTarget * salaryFraction;
  const maxHsaByPayroll = Math.max(salaryThisYear - employee401kContribution, 0);
  const hsaContribution = clamp(Math.min(proratedHsaTarget, annualHsaLimit, maxHsaByPayroll));

  const total401kContribution = employee401kContribution + employerMatchContribution;
  const totalPretaxContribution = total401kContribution + hsaContribution;
  const taxableWageReduction = employee401kContribution + hsaContribution;
  const adjustedWages = Math.max(salaryThisYear - taxableWageReduction, 0);
  const updatedPretaxBalance = pretaxStartingBalance + totalPretaxContribution;
  const updatedHsaBalance =
    typeof hsaStartingBalance === 'number' ? hsaStartingBalance + hsaContribution : undefined;

  return {
    employee401kContribution: toCurrency(employee401kContribution),
    employerMatchContribution: toCurrency(employerMatchContribution),
    total401kContribution: toCurrency(total401kContribution),
    hsaContribution: toCurrency(hsaContribution),
    adjustedWages: toCurrency(adjustedWages),
    taxableWageReduction: toCurrency(taxableWageReduction),
    updatedPretaxBalance: toCurrency(updatedPretaxBalance),
    totalPretaxContribution: toCurrency(totalPretaxContribution),
    updatedAccountBalances: {
      pretax: toCurrency(updatedPretaxBalance),
      hsa: typeof updatedHsaBalance === 'number' ? toCurrency(updatedHsaBalance) : undefined,
    },
  };
}
