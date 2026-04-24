export type FilingStatus =
  | 'single'
  | 'married_filing_jointly'
  | 'married_filing_separately'
  | 'head_of_household';

interface OrdinaryBracket {
  upTo: number;
  rate: number;
}

interface CapitalGainsBracketThreshold {
  zeroRateTop: number;
  fifteenRateTop: number;
}

interface SocialSecurityThresholds {
  firstBase: number;
  secondBase: number;
  secondTierAdjustmentCap: number;
}

interface FilingStatusTaxProfile {
  standardDeduction: number;
  ordinaryBrackets: OrdinaryBracket[];
  capitalGainsThresholds: CapitalGainsBracketThreshold;
  socialSecurityThresholds: SocialSecurityThresholds;
}

interface NetInvestmentIncomeTaxConfig {
  rate: number;
  magiThresholds: Record<FilingStatus, number>;
}

interface AdditionalMedicareTaxConfig {
  // IRC §1401(b). 0.9% additional Medicare tax on wages above the
  // filing-status threshold. Employee-side only; this engine does not
  // model self-employment income separately.
  rate: number;
  wageThresholds: Record<FilingStatus, number>;
}

interface AgeBasedStandardDeductionConfig {
  // Per-qualifying-event (age 65+) dollar add-on to the standard deduction.
  // IRS allows this once per event per spouse (65+ and/or blind). This engine
  // models age-65+ only; blindness is out of scope.
  perElderlyByStatus: Record<FilingStatus, number>;
}

export interface TaxEngineConfig {
  taxYear: number;
  profiles: Record<FilingStatus, FilingStatusTaxProfile>;
  netInvestmentIncomeTax: NetInvestmentIncomeTaxConfig;
  additionalStandardDeductionForAge65: AgeBasedStandardDeductionConfig;
  additionalMedicareTax: AdditionalMedicareTaxConfig;
}

export interface YearTaxInputs {
  wages: number;
  pension: number;
  socialSecurityBenefits: number;
  ira401kWithdrawals: number;
  rothWithdrawals: number;
  taxableInterest: number;
  qualifiedDividends: number;
  ordinaryDividends: number;
  realizedLTCG: number;
  realizedSTCG: number;
  otherOrdinaryIncome: number;
  filingStatus: string;
  taxExemptInterest?: number;
  // Optional — when present, an age >= 65 triggers an additional standard
  // deduction add-on per IRC §63(f). For MFJ both spouses are considered.
  headAge?: number;
  spouseAge?: number;
}

export interface YearTaxOutputs {
  AGI: number;
  provisionalIncome: number;
  taxableSocialSecurity: number;
  ordinaryTaxableIncome: number;
  LTCGTaxableIncome: number;
  totalTaxableIncome: number;
  federalTax: number;
  effectiveTaxRate: number;
  marginalOrdinaryBracket: number;
  marginalLTCGBracket: number;
  MAGI: number;
  // NIIT (IRC §1411) — 3.8% surtax on net investment income to the extent
  // MAGI exceeds the filing-status threshold. Included in federalTax.
  netInvestmentIncomeTax: number;
  // Effective standard deduction actually applied, including any age-65+
  // add-on(s). Equals profile.standardDeduction when no 65+ member present.
  standardDeductionApplied: number;
  // Additional Medicare Tax (IRC §1401(b)) — 0.9% on wages above the
  // filing-status threshold. Zero for most retirees (no wages); material
  // for still-working high-wage households. Included in federalTax.
  additionalMedicareTax: number;
}

const ORDINARY_INF = Number.POSITIVE_INFINITY;

export const DEFAULT_TAX_ENGINE_CONFIG: TaxEngineConfig = {
  taxYear: 2026,
  profiles: {
    single: {
      standardDeduction: 14_600,
      ordinaryBrackets: [
        { upTo: 11_600, rate: 0.1 },
        { upTo: 47_150, rate: 0.12 },
        { upTo: 100_525, rate: 0.22 },
        { upTo: 191_950, rate: 0.24 },
        { upTo: 243_725, rate: 0.32 },
        { upTo: 609_350, rate: 0.35 },
        { upTo: ORDINARY_INF, rate: 0.37 },
      ],
      capitalGainsThresholds: {
        zeroRateTop: 47_025,
        fifteenRateTop: 518_900,
      },
      socialSecurityThresholds: {
        firstBase: 25_000,
        secondBase: 34_000,
        secondTierAdjustmentCap: 4_500,
      },
    },
    married_filing_jointly: {
      standardDeduction: 29_200,
      ordinaryBrackets: [
        { upTo: 23_200, rate: 0.1 },
        { upTo: 94_300, rate: 0.12 },
        { upTo: 201_050, rate: 0.22 },
        { upTo: 383_900, rate: 0.24 },
        { upTo: 487_450, rate: 0.32 },
        { upTo: 731_200, rate: 0.35 },
        { upTo: ORDINARY_INF, rate: 0.37 },
      ],
      capitalGainsThresholds: {
        zeroRateTop: 94_050,
        fifteenRateTop: 583_750,
      },
      socialSecurityThresholds: {
        firstBase: 32_000,
        secondBase: 44_000,
        secondTierAdjustmentCap: 6_000,
      },
    },
    married_filing_separately: {
      standardDeduction: 14_600,
      ordinaryBrackets: [
        { upTo: 11_600, rate: 0.1 },
        { upTo: 47_150, rate: 0.12 },
        { upTo: 100_525, rate: 0.22 },
        { upTo: 191_950, rate: 0.24 },
        { upTo: 243_725, rate: 0.32 },
        { upTo: 365_600, rate: 0.35 },
        { upTo: ORDINARY_INF, rate: 0.37 },
      ],
      capitalGainsThresholds: {
        zeroRateTop: 47_025,
        fifteenRateTop: 291_850,
      },
      socialSecurityThresholds: {
        firstBase: 0,
        secondBase: 0,
        secondTierAdjustmentCap: 0,
      },
    },
    head_of_household: {
      standardDeduction: 21_900,
      ordinaryBrackets: [
        { upTo: 16_550, rate: 0.1 },
        { upTo: 63_100, rate: 0.12 },
        { upTo: 100_500, rate: 0.22 },
        { upTo: 191_950, rate: 0.24 },
        { upTo: 243_700, rate: 0.32 },
        { upTo: 609_350, rate: 0.35 },
        { upTo: ORDINARY_INF, rate: 0.37 },
      ],
      capitalGainsThresholds: {
        zeroRateTop: 63_000,
        fifteenRateTop: 551_350,
      },
      socialSecurityThresholds: {
        firstBase: 25_000,
        secondBase: 34_000,
        secondTierAdjustmentCap: 4_500,
      },
    },
  },
  netInvestmentIncomeTax: {
    // IRC §1411. Rate and thresholds are statutory and not indexed.
    rate: 0.038,
    magiThresholds: {
      single: 200_000,
      head_of_household: 200_000,
      married_filing_jointly: 250_000,
      married_filing_separately: 125_000,
    },
  },
  additionalStandardDeductionForAge65: {
    // 2024 IRS amounts per Rev. Proc. 2023-34: $1,950 for single/HoH,
    // $1,550 for MFJ/MFS (per qualifying spouse).
    perElderlyByStatus: {
      single: 1_950,
      head_of_household: 1_950,
      married_filing_jointly: 1_550,
      married_filing_separately: 1_550,
    },
  },
  additionalMedicareTax: {
    // IRC §1401(b) statutory rate and thresholds — not indexed.
    rate: 0.009,
    wageThresholds: {
      single: 200_000,
      head_of_household: 200_000,
      married_filing_jointly: 250_000,
      married_filing_separately: 125_000,
    },
  },
};

function normalizeMoney(value: number) {
  return Number(value.toFixed(2));
}

function clampNonNegative(value: number) {
  return Math.max(0, value);
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

function calculateOrdinaryTax(taxableOrdinaryIncome: number, brackets: OrdinaryBracket[]) {
  let remaining = clampNonNegative(taxableOrdinaryIncome);
  let previousTop = 0;
  let tax = 0;

  for (const bracket of brackets) {
    if (remaining <= 0) {
      break;
    }

    const taxableInBracket = Math.min(remaining, bracket.upTo - previousTop);
    if (taxableInBracket > 0) {
      tax += taxableInBracket * bracket.rate;
      remaining -= taxableInBracket;
    }
    previousTop = bracket.upTo;
  }

  return tax;
}

function getMarginalOrdinaryBracket(
  taxableOrdinaryIncome: number,
  brackets: OrdinaryBracket[],
) {
  const lookupIncome = clampNonNegative(taxableOrdinaryIncome) + 1;
  for (const bracket of brackets) {
    if (lookupIncome <= bracket.upTo) {
      return bracket.rate;
    }
  }
  return brackets[brackets.length - 1]?.rate ?? 0;
}

function calculateLTCGTax(
  ordinaryTaxableIncome: number,
  ltcgTaxableIncome: number,
  thresholds: CapitalGainsBracketThreshold,
) {
  let remaining = clampNonNegative(ltcgTaxableIncome);
  const zeroRateRoom = Math.max(0, thresholds.zeroRateTop - ordinaryTaxableIncome);
  const zeroRateAmount = Math.min(remaining, zeroRateRoom);
  remaining -= zeroRateAmount;

  const fifteenRateRoom = Math.max(
    0,
    thresholds.fifteenRateTop - ordinaryTaxableIncome - zeroRateAmount,
  );
  const fifteenRateAmount = Math.min(remaining, fifteenRateRoom);
  remaining -= fifteenRateAmount;

  const twentyRateAmount = remaining;
  return fifteenRateAmount * 0.15 + twentyRateAmount * 0.2;
}

function getMarginalLTCGBracket(
  ordinaryTaxableIncome: number,
  ltcgTaxableIncome: number,
  thresholds: CapitalGainsBracketThreshold,
) {
  const stackedIncome = ordinaryTaxableIncome + ltcgTaxableIncome;
  if (stackedIncome < thresholds.zeroRateTop) {
    return 0;
  }
  if (stackedIncome < thresholds.fifteenRateTop) {
    return 0.15;
  }
  return 0.2;
}

function calculateTaxableSocialSecurity(
  socialSecurityBenefits: number,
  provisionalIncome: number,
  thresholds: SocialSecurityThresholds,
) {
  const benefits = clampNonNegative(socialSecurityBenefits);
  const provisional = clampNonNegative(provisionalIncome);

  if (benefits <= 0) {
    return 0;
  }

  if (provisional <= thresholds.firstBase) {
    return 0;
  }

  if (provisional <= thresholds.secondBase) {
    return Math.min(benefits * 0.5, (provisional - thresholds.firstBase) * 0.5);
  }

  const baseHalfTaxable = Math.min(benefits * 0.5, thresholds.secondTierAdjustmentCap);
  const secondTierTaxable = (provisional - thresholds.secondBase) * 0.85 + baseHalfTaxable;
  return Math.min(benefits * 0.85, secondTierTaxable);
}

function countElderlyMembers(
  inputs: YearTaxInputs,
  filingStatus: FilingStatus,
): number {
  const headOver65 =
    typeof inputs.headAge === 'number' && inputs.headAge >= 65 ? 1 : 0;
  if (filingStatus !== 'married_filing_jointly') {
    return headOver65;
  }
  const spouseOver65 =
    typeof inputs.spouseAge === 'number' && inputs.spouseAge >= 65 ? 1 : 0;
  return headOver65 + spouseOver65;
}

function calculateAdditionalMedicareTax(
  inputs: YearTaxInputs,
  filingStatus: FilingStatus,
  config: TaxEngineConfig,
): number {
  const wages = clampNonNegative(inputs.wages);
  if (wages <= 0) return 0;
  const threshold = config.additionalMedicareTax.wageThresholds[filingStatus];
  const excess = Math.max(0, wages - threshold);
  if (excess <= 0) return 0;
  return config.additionalMedicareTax.rate * excess;
}

function calculateNetInvestmentIncomeTax(
  inputs: YearTaxInputs,
  MAGI: number,
  filingStatus: FilingStatus,
  config: TaxEngineConfig,
): number {
  const netInvestmentIncome =
    clampNonNegative(inputs.taxableInterest) +
    clampNonNegative(inputs.qualifiedDividends) +
    clampNonNegative(inputs.ordinaryDividends) +
    clampNonNegative(inputs.realizedLTCG) +
    clampNonNegative(inputs.realizedSTCG);
  if (netInvestmentIncome <= 0) {
    return 0;
  }
  const threshold = config.netInvestmentIncomeTax.magiThresholds[filingStatus];
  const magiExcess = Math.max(0, MAGI - threshold);
  if (magiExcess <= 0) {
    return 0;
  }
  return config.netInvestmentIncomeTax.rate * Math.min(netInvestmentIncome, magiExcess);
}

export function calculateFederalTax(
  inputs: YearTaxInputs,
  config: TaxEngineConfig = DEFAULT_TAX_ENGINE_CONFIG,
): YearTaxOutputs {
  const filingStatus = normalizeFilingStatus(inputs.filingStatus);
  const profile = config.profiles[filingStatus];
  const taxExemptInterest = clampNonNegative(inputs.taxExemptInterest ?? 0);

  const ordinaryIncomeExcludingSS =
    clampNonNegative(inputs.wages) +
    clampNonNegative(inputs.pension) +
    clampNonNegative(inputs.ira401kWithdrawals) +
    clampNonNegative(inputs.taxableInterest) +
    clampNonNegative(inputs.ordinaryDividends) +
    clampNonNegative(inputs.realizedSTCG) +
    clampNonNegative(inputs.otherOrdinaryIncome);

  const preferentialIncome =
    clampNonNegative(inputs.qualifiedDividends) + clampNonNegative(inputs.realizedLTCG);

  const provisionalIncome =
    ordinaryIncomeExcludingSS +
    preferentialIncome +
    taxExemptInterest +
    clampNonNegative(inputs.socialSecurityBenefits) * 0.5;

  const taxableSocialSecurity = calculateTaxableSocialSecurity(
    inputs.socialSecurityBenefits,
    provisionalIncome,
    profile.socialSecurityThresholds,
  );

  const AGI = ordinaryIncomeExcludingSS + taxableSocialSecurity + preferentialIncome;
  const MAGI = AGI + taxExemptInterest;

  const elderlyCount = countElderlyMembers(inputs, filingStatus);
  const ageBump =
    elderlyCount *
    config.additionalStandardDeductionForAge65.perElderlyByStatus[filingStatus];
  const standardDeductionApplied = profile.standardDeduction + ageBump;

  const totalTaxableIncome = clampNonNegative(AGI - standardDeductionApplied);
  const LTCGTaxableIncome = Math.min(preferentialIncome, totalTaxableIncome);
  const ordinaryTaxableIncome = clampNonNegative(totalTaxableIncome - LTCGTaxableIncome);

  const ordinaryTax = calculateOrdinaryTax(ordinaryTaxableIncome, profile.ordinaryBrackets);
  const LTCGTax = calculateLTCGTax(
    ordinaryTaxableIncome,
    LTCGTaxableIncome,
    profile.capitalGainsThresholds,
  );
  const netInvestmentIncomeTax = calculateNetInvestmentIncomeTax(
    inputs,
    MAGI,
    filingStatus,
    config,
  );
  const additionalMedicareTax = calculateAdditionalMedicareTax(
    inputs,
    filingStatus,
    config,
  );
  const federalTax =
    ordinaryTax + LTCGTax + netInvestmentIncomeTax + additionalMedicareTax;

  const effectiveTaxRate = AGI <= 0 ? 0 : federalTax / AGI;
  const marginalOrdinaryBracket = getMarginalOrdinaryBracket(
    ordinaryTaxableIncome,
    profile.ordinaryBrackets,
  );
  const marginalLTCGBracket = getMarginalLTCGBracket(
    ordinaryTaxableIncome,
    LTCGTaxableIncome,
    profile.capitalGainsThresholds,
  );

  return {
    AGI: normalizeMoney(AGI),
    provisionalIncome: normalizeMoney(provisionalIncome),
    taxableSocialSecurity: normalizeMoney(taxableSocialSecurity),
    ordinaryTaxableIncome: normalizeMoney(ordinaryTaxableIncome),
    LTCGTaxableIncome: normalizeMoney(LTCGTaxableIncome),
    totalTaxableIncome: normalizeMoney(totalTaxableIncome),
    federalTax: normalizeMoney(federalTax),
    effectiveTaxRate: normalizeMoney(effectiveTaxRate),
    marginalOrdinaryBracket,
    marginalLTCGBracket,
    MAGI: normalizeMoney(MAGI),
    netInvestmentIncomeTax: normalizeMoney(netInvestmentIncomeTax),
    standardDeductionApplied: normalizeMoney(standardDeductionApplied),
    additionalMedicareTax: normalizeMoney(additionalMedicareTax),
  };
}
