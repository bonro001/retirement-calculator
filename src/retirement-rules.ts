import type { FilingStatus } from './tax-engine';

export interface IrmaaBracket {
  maxMagi: number;
  partBSurchargeMonthly: number;
  partDSurchargeMonthly: number;
}

export interface IrmaaConfig {
  taxYear: number;
  lookbackYears: number;
  brackets: {
    single: IrmaaBracket[];
    head_of_household: IrmaaBracket[];
    married_filing_jointly: IrmaaBracket[];
    married_filing_separately: IrmaaBracket[];
  };
}

export interface IrmaaTierResult {
  taxYear: number;
  referenceMagi: number;
  filingStatus: FilingStatus;
  tier: number;
  tierLabel: string;
  partBSurchargeMonthly: number;
  partDSurchargeMonthly: number;
  surchargeMonthly: number;
  surchargeAnnual: number;
}

export interface RmdConfig {
  uniformLifetimeTable: Record<number, number>;
}

export interface RmdHouseholdMemberInput {
  birthDate: string;
  age: number;
  accountShare?: number;
  startAgeOverride?: number;
}

export interface RmdCalculationInput {
  pretaxBalance: number;
  members: RmdHouseholdMemberInput[];
}

export interface RmdCalculationDetail {
  age: number;
  startAge: number;
  accountShare: number;
  divisor: number;
  amount: number;
}

export interface RmdCalculationResult {
  amount: number;
  details: RmdCalculationDetail[];
}

const IRMAA_INF = Number.POSITIVE_INFINITY;

export const DEFAULT_IRMAA_CONFIG: IrmaaConfig = {
  taxYear: 2026,
  lookbackYears: 2,
  brackets: {
    single: [
      { maxMagi: 109_000, partBSurchargeMonthly: 0, partDSurchargeMonthly: 0 },
      { maxMagi: 137_000, partBSurchargeMonthly: 81.2, partDSurchargeMonthly: 14.5 },
      { maxMagi: 171_000, partBSurchargeMonthly: 202.9, partDSurchargeMonthly: 37.5 },
      { maxMagi: 205_000, partBSurchargeMonthly: 324.6, partDSurchargeMonthly: 60.4 },
      { maxMagi: 500_000, partBSurchargeMonthly: 446.3, partDSurchargeMonthly: 83.3 },
      { maxMagi: IRMAA_INF, partBSurchargeMonthly: 487.0, partDSurchargeMonthly: 91.0 },
    ],
    head_of_household: [
      { maxMagi: 109_000, partBSurchargeMonthly: 0, partDSurchargeMonthly: 0 },
      { maxMagi: 137_000, partBSurchargeMonthly: 81.2, partDSurchargeMonthly: 14.5 },
      { maxMagi: 171_000, partBSurchargeMonthly: 202.9, partDSurchargeMonthly: 37.5 },
      { maxMagi: 205_000, partBSurchargeMonthly: 324.6, partDSurchargeMonthly: 60.4 },
      { maxMagi: 500_000, partBSurchargeMonthly: 446.3, partDSurchargeMonthly: 83.3 },
      { maxMagi: IRMAA_INF, partBSurchargeMonthly: 487.0, partDSurchargeMonthly: 91.0 },
    ],
    married_filing_jointly: [
      { maxMagi: 218_000, partBSurchargeMonthly: 0, partDSurchargeMonthly: 0 },
      { maxMagi: 274_000, partBSurchargeMonthly: 81.2, partDSurchargeMonthly: 14.5 },
      { maxMagi: 342_000, partBSurchargeMonthly: 202.9, partDSurchargeMonthly: 37.5 },
      { maxMagi: 410_000, partBSurchargeMonthly: 324.6, partDSurchargeMonthly: 60.4 },
      { maxMagi: 750_000, partBSurchargeMonthly: 446.3, partDSurchargeMonthly: 83.3 },
      { maxMagi: IRMAA_INF, partBSurchargeMonthly: 487.0, partDSurchargeMonthly: 91.0 },
    ],
    married_filing_separately: [
      { maxMagi: 109_000, partBSurchargeMonthly: 0, partDSurchargeMonthly: 0 },
      { maxMagi: 391_000, partBSurchargeMonthly: 446.3, partDSurchargeMonthly: 83.3 },
      { maxMagi: IRMAA_INF, partBSurchargeMonthly: 487.0, partDSurchargeMonthly: 91.0 },
    ],
  },
};

export const DEFAULT_RMD_CONFIG: RmdConfig = {
  uniformLifetimeTable: {
    72: 27.4,
    73: 26.5,
    74: 25.5,
    75: 24.6,
    76: 23.7,
    77: 22.9,
    78: 22.0,
    79: 21.1,
    80: 20.2,
    81: 19.4,
    82: 18.5,
    83: 17.7,
    84: 16.8,
    85: 16.0,
    86: 15.2,
    87: 14.4,
    88: 13.7,
    89: 12.9,
    90: 12.2,
    91: 11.5,
    92: 10.8,
    93: 10.1,
    94: 9.5,
    95: 8.9,
    96: 8.4,
    97: 7.8,
    98: 7.3,
    99: 6.8,
    100: 6.4,
    101: 6.0,
    102: 5.6,
    103: 5.2,
    104: 4.9,
    105: 4.6,
    106: 4.3,
    107: 4.1,
    108: 3.9,
    109: 3.7,
    110: 3.5,
    111: 3.4,
    112: 3.3,
    113: 3.1,
    114: 3.0,
    115: 2.9,
    116: 2.8,
    117: 2.7,
    118: 2.5,
    119: 2.3,
    120: 2.0,
  },
};

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

export function getRmdStartAgeForBirthYear(birthYear: number) {
  if (birthYear <= 1950) {
    return 72;
  }
  if (birthYear <= 1959) {
    return 73;
  }
  return 75;
}

function normalizeShare(index: number, memberCount: number, explicitShares: number[]) {
  if (!explicitShares.length) {
    return 1 / Math.max(1, memberCount);
  }

  const totalExplicit = explicitShares.reduce((total, share) => total + share, 0);
  if (totalExplicit <= 0) {
    return 1 / Math.max(1, memberCount);
  }

  return explicitShares[index] / totalExplicit;
}

function getUniformLifetimeDivisor(age: number, config: RmdConfig) {
  const normalizedAge = Math.max(72, Math.min(120, Math.floor(age)));
  return config.uniformLifetimeTable[normalizedAge] ?? config.uniformLifetimeTable[120];
}

export function calculateRequiredMinimumDistribution(
  input: RmdCalculationInput,
  config: RmdConfig = DEFAULT_RMD_CONFIG,
): RmdCalculationResult {
  const pretaxBalance = Math.max(0, input.pretaxBalance);
  const explicitShares = input.members
    .map((member) => member.accountShare ?? 0)
    .filter((value) => value > 0);

  const details: RmdCalculationDetail[] = [];
  let amount = 0;

  input.members.forEach((member, index) => {
    const birthYear = new Date(member.birthDate).getFullYear();
    const startAge = Math.max(
      0,
      Math.floor(member.startAgeOverride ?? getRmdStartAgeForBirthYear(birthYear)),
    );
    if (member.age < startAge) {
      return;
    }

    const share = normalizeShare(index, input.members.length, explicitShares);
    const divisor = getUniformLifetimeDivisor(member.age, config);
    const memberBalance = pretaxBalance * share;
    const memberRmd = divisor > 0 ? memberBalance / divisor : 0;

    amount += memberRmd;
    details.push({
      age: member.age,
      startAge,
      accountShare: share,
      divisor,
      amount: memberRmd,
    });
  });

  return {
    amount,
    details,
  };
}

export function calculateIrmaaTier(
  magi: number,
  filingStatusInput: string,
  config: IrmaaConfig = DEFAULT_IRMAA_CONFIG,
): IrmaaTierResult {
  const filingStatus = normalizeFilingStatus(filingStatusInput);
  const brackets = config.brackets[filingStatus];
  const referenceMagi = Math.max(0, magi);
  const tierIndex = brackets.findIndex((bracket) => referenceMagi <= bracket.maxMagi);
  const tier = tierIndex >= 0 ? tierIndex + 1 : brackets.length;
  const selectedBracket = brackets[Math.max(0, tier - 1)];
  const surchargeMonthly =
    selectedBracket.partBSurchargeMonthly + selectedBracket.partDSurchargeMonthly;
  const surchargeAnnual = surchargeMonthly * 12;

  return {
    taxYear: config.taxYear,
    referenceMagi,
    filingStatus,
    tier,
    tierLabel: `Tier ${tier}`,
    partBSurchargeMonthly: selectedBracket.partBSurchargeMonthly,
    partDSurchargeMonthly: selectedBracket.partDSurchargeMonthly,
    surchargeMonthly,
    surchargeAnnual,
  };
}
