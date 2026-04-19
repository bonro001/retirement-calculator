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
    maxFplRatio: number;
    minRate: number;
    maxRate: number;
  }>;
  federalPovertyLevelByHouseholdSize: Record<number, number>;
}

export interface HealthcarePremiumConfig {
  aca: AcaSubsidyConfig;
}

const DEFAULT_HEALTHCARE_PREMIUM_CONFIG: HealthcarePremiumConfig = {
  aca: {
    expectedContributionByFplBand: [
      { maxFplRatio: 1.5, minRate: 0, maxRate: 0 },
      { maxFplRatio: 2.0, minRate: 0, maxRate: 0.02 },
      { maxFplRatio: 2.5, minRate: 0.02, maxRate: 0.04 },
      { maxFplRatio: 3.0, minRate: 0.04, maxRate: 0.06 },
      { maxFplRatio: 4.0, minRate: 0.06, maxRate: 0.085 },
      { maxFplRatio: Number.POSITIVE_INFINITY, minRate: 0.085, maxRate: 0.085 },
    ],
    federalPovertyLevelByHouseholdSize: {
      1: 15_650,
      2: 21_150,
      3: 26_650,
      4: 32_150,
    },
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
  const perPersonIncrement = 5_500;
  const extraPeople = Math.max(0, householdSize - maxDefinedSize);
  return maxDefinedFpl + extraPeople * perPersonIncrement;
}

function interpolateRate(
  fplRatio: number,
  bands: AcaSubsidyConfig['expectedContributionByFplBand'],
) {
  let previousMax = 0;
  let previousRate = bands[0]?.minRate ?? 0;

  for (const band of bands) {
    if (fplRatio <= band.maxFplRatio) {
      if (!Number.isFinite(band.maxFplRatio) || band.maxFplRatio <= previousMax) {
        return clamp(band.maxRate, 0, 1);
      }

      const relative = clamp((fplRatio - previousMax) / (band.maxFplRatio - previousMax), 0, 1);
      return clamp(previousRate + (band.maxRate - band.minRate) * relative, 0, 1);
    }
    previousMax = band.maxFplRatio;
    previousRate = band.maxRate;
  }

  return clamp(previousRate, 0, 1);
}

export function calculateHealthcarePremiums(
  input: HealthcarePremiumCalculationInput,
  config: HealthcarePremiumConfig = DEFAULT_HEALTHCARE_PREMIUM_CONFIG,
): HealthcarePremiumCalculationOutput {
  const nonMedicareCount = input.medicareEligibilityByPerson.filter((isEligible) => !isEligible).length;
  const medicareCount = input.medicareEligibilityByPerson.filter(Boolean).length;
  const acaPremiumEstimate = clamp(input.baselineAcaPremiumAnnual) * nonMedicareCount;
  const medicarePremiumEstimate = clamp(input.baselineMedicarePremiumAnnual) * medicareCount;
  const irmaaSurcharge = clamp(input.irmaaSurchargeAnnualPerEligible) * medicareCount;

  const householdSize = getHouseholdSize(input.filingStatus, input.agesByYear);
  const fpl = getFplForHouseholdSize(
    householdSize,
    config.aca.federalPovertyLevelByHouseholdSize,
  );
  const magi = clamp(input.MAGI);
  const fplRatio = fpl > 0 ? magi / fpl : Number.POSITIVE_INFINITY;
  const expectedContributionRate = interpolateRate(
    fplRatio,
    config.aca.expectedContributionByFplBand,
  );
  const expectedAcaContribution = expectedContributionRate * magi;

  const acaSubsidyEstimate =
    input.retirementStatus && nonMedicareCount > 0
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

