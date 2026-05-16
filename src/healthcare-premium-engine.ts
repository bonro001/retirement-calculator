import { CURRENT_LAW_2026_RULE_PACK } from './rule-packs';

export interface HealthcarePremiumAssumptions {
  baselineAcaPremiumAnnual: number;
  baselineMedicarePremiumAnnual: number;
}

export interface HealthcarePremiumCalculationInput {
  agesByYear: number[];
  filingStatus: string;
  MAGI: number;
  retirementStatus: boolean;
  medicareEligibilityByPerson: boolean[];
  baselineAcaPremiumAnnual: number;
  baselineMedicarePremiumAnnual: number;
  irmaaSurchargeAnnualPerEligible: number;
}

export interface HealthcarePremiumCalculationOutput {
  acaPremiumEstimate: number;
  acaSubsidyEstimate: number;
  netAcaCost: number;
  medicarePremiumEstimate: number;
  irmaaSurcharge: number;
  totalHealthcarePremiumCost: number;
}

interface AcaSubsidyConfig {
  expectedContributionByFplBand: Array<{
    minFplRatio: number;
    maxFplRatio: number;
    minRate: number;
    maxRate: number;
  }>;
  federalPovertyLevelByHouseholdSize: Record<number, number>;
  subsidyEligibilityMaxFplRatio: number;
}

export interface HealthcarePremiumConfig {
  aca: AcaSubsidyConfig;
}

const DEFAULT_HEALTHCARE_PREMIUM_CONFIG: HealthcarePremiumConfig = {
  aca: {
    expectedContributionByFplBand:
      CURRENT_LAW_2026_RULE_PACK.aca.expectedContributionByFplBand,
    subsidyEligibilityMaxFplRatio:
      CURRENT_LAW_2026_RULE_PACK.aca.subsidyEligibilityMaxFplRatio,
    federalPovertyLevelByHouseholdSize:
      CURRENT_LAW_2026_RULE_PACK.aca.federalPovertyLevelByHouseholdSize,
  },
};

function clamp(value: number, minimum = 0, maximum = Number.POSITIVE_INFINITY) {
  return Math.max(minimum, Math.min(value, maximum));
}

function toCurrency(value: number) {
  return Number(value.toFixed(2));
}

function normalizeFilingStatus(value: string) {
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

function getHouseholdSize(filingStatusInput: string, agesByYear: number[]) {
  const filingStatus = normalizeFilingStatus(filingStatusInput);
  if (filingStatus === 'married_filing_jointly') {
    return Math.max(2, agesByYear.length || 2);
  }
  return 1;
}

function getFplForHouseholdSize(
  householdSize: number,
  fplByHouseholdSize: Record<number, number>,
) {
  if (fplByHouseholdSize[householdSize]) {
    return fplByHouseholdSize[householdSize];
  }

  const maxDefinedSize = Math.max(...Object.keys(fplByHouseholdSize).map(Number));
  const maxDefinedFpl = fplByHouseholdSize[maxDefinedSize];
  const perPersonIncrement = CURRENT_LAW_2026_RULE_PACK.aca.fplAdditionalPerson;
  const extraPeople = Math.max(0, householdSize - maxDefinedSize);
  return maxDefinedFpl + extraPeople * perPersonIncrement;
}

function interpolateRate(
  fplRatio: number,
  bands: AcaSubsidyConfig['expectedContributionByFplBand'],
) {
  for (const band of bands) {
    if (fplRatio >= band.minFplRatio && fplRatio < band.maxFplRatio) {
      const width = band.maxFplRatio - band.minFplRatio;
      if (!Number.isFinite(width) || width <= 0) {
        return clamp(band.maxRate, 0, 1);
      }
      const relative = clamp((fplRatio - band.minFplRatio) / width, 0, 1);
      return clamp(band.minRate + (band.maxRate - band.minRate) * relative, 0, 1);
    }
  }

  return clamp(bands[bands.length - 1]?.maxRate ?? 0, 0, 1);
}

export function calculateHealthcarePremiums(
  input: HealthcarePremiumCalculationInput,
  config: HealthcarePremiumConfig = DEFAULT_HEALTHCARE_PREMIUM_CONFIG,
): HealthcarePremiumCalculationOutput {
  const nonMedicareCount = input.medicareEligibilityByPerson.filter((isEligible) => !isEligible).length;
  const medicareCount = input.medicareEligibilityByPerson.filter(Boolean).length;
  // ACA premium only applies once the household is actually retired. While
  // someone is still in the workforce we assume they (and any covered
  // spouse) are on employer-provided health insurance, so we should not
  // bill them for a hypothetical marketplace plan. Previously this code
  // charged the full ACA premium with no subsidy during working years —
  // surfacing as a misleading "ACA subsidy lost / paying full freight"
  // signal in the Advisor card. Gating the premium itself on
  // `retirementStatus` is the simpler / more honest model: when working,
  // healthcare cost lives in baseline spending, not in this output.
  const acaPremiumEstimate = input.retirementStatus
    ? clamp(input.baselineAcaPremiumAnnual) * nonMedicareCount
    : 0;
  const medicarePremiumEstimate = clamp(input.baselineMedicarePremiumAnnual) * medicareCount;
  const irmaaSurcharge = clamp(input.irmaaSurchargeAnnualPerEligible) * medicareCount;

  const householdSize = getHouseholdSize(input.filingStatus, input.agesByYear);
  const fpl = getFplForHouseholdSize(
    householdSize,
    config.aca.federalPovertyLevelByHouseholdSize,
  );
  const magi = clamp(input.MAGI);
  const fplRatio = fpl > 0 ? magi / fpl : Number.POSITIVE_INFINITY;
  const eligibleForAcaSubsidy =
    fplRatio <= config.aca.subsidyEligibilityMaxFplRatio;
  const expectedContributionRate = interpolateRate(
    fplRatio,
    config.aca.expectedContributionByFplBand,
  );
  const expectedAcaContribution = expectedContributionRate * magi;

  const acaSubsidyEstimate =
    input.retirementStatus && nonMedicareCount > 0 && eligibleForAcaSubsidy
      ? clamp(acaPremiumEstimate - expectedAcaContribution, 0, acaPremiumEstimate)
      : 0;
  const netAcaCost = Math.max(0, acaPremiumEstimate - acaSubsidyEstimate);
  const totalHealthcarePremiumCost = netAcaCost + medicarePremiumEstimate + irmaaSurcharge;

  return {
    acaPremiumEstimate: toCurrency(acaPremiumEstimate),
    acaSubsidyEstimate: toCurrency(acaSubsidyEstimate),
    netAcaCost: toCurrency(netAcaCost),
    medicarePremiumEstimate: toCurrency(medicarePremiumEstimate),
    irmaaSurcharge: toCurrency(irmaaSurcharge),
    totalHealthcarePremiumCost: toCurrency(totalHealthcarePremiumCost),
  };
}
