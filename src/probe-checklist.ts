import type { PlanEvaluation } from './plan-evaluation';
import type { MarketAssumptions, SeedData, WindfallEntry } from './types';
import { calculateRunwayGapMetrics } from './runway-utils';

export type ProbeStatus = 'modeled' | 'partial' | 'missing' | 'attention';

export interface ProbeChecklistItem {
  id: string;
  title: string;
  status: ProbeStatus;
  summary: string;
}

export interface ProbeChecklistResult {
  generatedAtIso: string;
  items: ProbeChecklistItem[];
}

interface BuildProbeChecklistInput {
  data: SeedData;
  assumptions: MarketAssumptions;
  evaluation: PlanEvaluation | null;
}

const RMD_START_AGE = 75;

function currentAgeOnDate(birthDate: string, asOf: Date) {
  const birth = new Date(birthDate);
  let age = asOf.getFullYear() - birth.getFullYear();
  const hasHadBirthday =
    asOf.getMonth() > birth.getMonth() ||
    (asOf.getMonth() === birth.getMonth() && asOf.getDate() >= birth.getDate());
  if (!hasHadBirthday) {
    age -= 1;
  }
  return age;
}

function findWindfall(data: SeedData, name: string) {
  return data.income.windfalls.find((item) => item.name === name);
}

function describeWindfallTreatment(windfall: WindfallEntry | undefined) {
  if (!windfall) {
    return {
      status: 'missing' as const,
      summary: 'No inheritance event is modeled.',
    };
  }

  if (!windfall.taxTreatment) {
    return {
      status: 'partial' as const,
      summary:
        'Inheritance tax treatment is inferred as non-taxable cash. Set tax treatment explicitly for higher confidence.',
    };
  }

  if (windfall.taxTreatment === 'inherited_ira_10y') {
    const distributionYears = Math.max(1, Math.round(windfall.distributionYears ?? 10));
    const annualForcedIncome = windfall.amount / distributionYears;
    return {
      status: 'modeled' as const,
      summary: `Inherited IRA treatment modeled with ~${annualForcedIncome.toLocaleString('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 0,
      })}/year forced ordinary income over ${distributionYears} years.`,
    };
  }

  return {
    status: 'modeled' as const,
    summary: `Inheritance treatment modeled as "${windfall.taxTreatment}".`,
  };
}

export function buildProbeChecklist(input: BuildProbeChecklistInput): ProbeChecklistResult {
  const now = new Date();
  const retirementYear = new Date(input.data.income.salaryEndDate).getFullYear();
  const currentYear = now.getFullYear();
  const currentAges = {
    rob: currentAgeOnDate(input.data.household.robBirthDate, now),
    debbie: currentAgeOnDate(input.data.household.debbieBirthDate, now),
  };
  const yearsUntilRmd = Math.max(0, RMD_START_AGE - Math.max(currentAges.rob, currentAges.debbie));
  const firstRmdYear = currentYear + yearsUntilRmd;
  const conversionWindowYears = Math.max(1, firstRmdYear - retirementYear);
  const annualPretaxReductionTarget = input.data.accounts.pretax.balance / conversionWindowYears;

  const inheritance = findWindfall(input.data, 'inheritance');
  const homeSale = findWindfall(input.data, 'home_sale');
  const homeSaleExclusion =
    homeSale?.exclusionAmount ??
    (input.data.household.filingStatus === 'married_filing_jointly' ? 500_000 : 250_000);
  const homeSaleGain =
    homeSale && typeof homeSale.costBasis === 'number'
      ? Math.max(0, homeSale.amount - homeSale.costBasis)
      : null;
  const homeSaleTaxableGain =
    homeSaleGain === null ? null : Math.max(0, homeSaleGain - homeSaleExclusion);
  const homeReplacementCost =
    homeSale && typeof homeSale.replacementHomeCost === 'number'
      ? Math.max(0, homeSale.replacementHomeCost)
      : null;
  const homeSaleSellingCost =
    homeSale && typeof homeSale.sellingCostPercent === 'number'
      ? Math.max(0, homeSale.amount * homeSale.sellingCostPercent)
      : 0;
  const homePurchaseCost =
    homeReplacementCost === null
      ? null
      : homeReplacementCost +
        homeReplacementCost * Math.max(0, homeSale?.purchaseClosingCostPercent ?? 0) +
        Math.max(0, homeSale?.movingCost ?? 0);
  const computedHomeSaleLiquidity =
    homeSale && homePurchaseCost !== null
      ? Math.max(0, homeSale.amount - homeSaleSellingCost - homePurchaseCost)
      : null;

  const runway = calculateRunwayGapMetrics({
    data: input.data,
    targetMonths: 18,
  });
  const runwayGap = runway.cashGap;
  const medicalInflationAnnual =
    input.data.rules.healthcarePremiums?.medicalInflationAnnual ?? input.assumptions.inflation;

  const socialSecurityTaxModeled = input.evaluation
    ? input.evaluation.raw.baselinePath.yearlySeries.some((year) => year.medianTaxableIncome > 0)
    : true;

  const inheritanceTreatment = describeWindfallTreatment(inheritance);

  const items: ProbeChecklistItem[] = [
    {
      id: 'roth-conversion-sizing',
      title: 'Roth conversion sizing to RMD start',
      status: 'partial',
      summary: `Need roughly ${annualPretaxReductionTarget.toLocaleString('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 0,
      })}/year of pre-tax reduction between retirement (${retirementYear}) and RMD start (${firstRmdYear}) to fully drain today's pre-tax balance. Use as sizing anchor, not final recommendation.`,
    },
    {
      id: 'inheritance-treatment',
      title: 'Inheritance tax treatment',
      status: inheritanceTreatment.status,
      summary: inheritanceTreatment.summary,
    },
    {
      id: 'home-sale-treatment',
      title: 'Home sale capital-gains treatment',
      status:
        !homeSale
          ? 'missing'
          : homeSale.taxTreatment ? (homeSaleTaxableGain === null ? 'partial' : 'modeled') : 'partial',
      summary: !homeSale
        ? 'No home sale event is modeled.'
        : homeSaleTaxableGain === null
          ? 'Home sale event exists but cost basis is missing, so taxable gain is not fully modeled.'
          : `Estimated taxable gain from home sale is ${homeSaleTaxableGain.toLocaleString('en-US', {
            style: 'currency',
            currency: 'USD',
            maximumFractionDigits: 0,
          })} after exclusion.`,
    },
    {
      id: 'home-sale-liquidity-assumption',
      title: 'Home sale liquidity assumption',
      status:
        !homeSale
          ? 'missing'
          : typeof homeSale.liquidityAmount === 'number' || computedHomeSaleLiquidity !== null
            ? 'modeled'
            : 'partial',
      summary: !homeSale
        ? 'No home sale event is modeled.'
        : typeof homeSale.liquidityAmount === 'number'
          ? `Home sale liquidity is explicitly modeled at ${homeSale.liquidityAmount.toLocaleString('en-US', {
              style: 'currency',
              currency: 'USD',
              maximumFractionDigits: 0,
            })} (gross sale amount ${homeSale.amount.toLocaleString('en-US', {
              style: 'currency',
              currency: 'USD',
              maximumFractionDigits: 0,
            })}).`
          : computedHomeSaleLiquidity !== null
            ? `Home downsizing liquidity is computed at ${computedHomeSaleLiquidity.toLocaleString('en-US', {
                style: 'currency',
                currency: 'USD',
                maximumFractionDigits: 0,
              })} after replacement-home and transaction-cost assumptions.`
            : 'Model currently assumes full home sale proceeds are available as plan liquidity; set liquidity amount or replacement-home cost if part is reinvested.',
    },
    {
      id: 'social-security-taxation',
      title: 'Social Security taxation',
      status: socialSecurityTaxModeled ? 'modeled' : 'partial',
      summary: socialSecurityTaxModeled
        ? 'Federal tax engine includes provisional-income Social Security taxation each year.'
        : 'Unable to verify Social Security taxation from current run output.',
    },
    {
      id: 'healthcare-trajectory',
      title: 'Healthcare inflation trajectory',
      status: input.data.rules.healthcarePremiums?.medicalInflationAnnual ? 'modeled' : 'partial',
      summary: `Healthcare premiums are projected with ${(
        medicalInflationAnnual * 100
      ).toFixed(1)}% annual medical inflation.`,
    },
    {
      id: 'sequence-runway',
      title: 'Early-retirement runway exposure',
      status: runwayGap > 0 ? 'attention' : 'modeled',
      summary:
        runwayGap > 0
          ? `Cash runway is short by ${runwayGap.toLocaleString('en-US', {
              style: 'currency',
              currency: 'USD',
              maximumFractionDigits: 0,
            })} vs 18-month essential-plus-fixed target (${runway.targetCashRunway.toLocaleString(
              'en-US',
              {
                style: 'currency',
                currency: 'USD',
                maximumFractionDigits: 0,
              },
            )}).`
          : 'Cash runway meets or exceeds the 18-month target.',
    },
    {
      id: 'hsa-strategy',
      title: 'HSA spend-down strategy',
      status: input.data.rules.hsaStrategy
        ? input.data.rules.hsaStrategy.enabled
          ? 'modeled'
          : 'partial'
        : 'missing',
      summary: input.data.rules.hsaStrategy
        ? input.data.rules.hsaStrategy.enabled
          ? 'HSA strategy is enabled and available for healthcare funding decisions.'
          : 'HSA strategy is present but disabled; enable to include HSA healthcare offsets in planning.'
        : 'No explicit HSA spending policy is configured yet.',
    },
    {
      id: 'ltc-tail-risk',
      title: 'Long-term care tail risk',
      status: input.data.rules.ltcAssumptions
        ? input.data.rules.ltcAssumptions.enabled
          ? typeof input.data.rules.ltcAssumptions.eventProbability === 'number'
            ? 'modeled'
            : 'partial'
          : 'partial'
        : 'missing',
      summary: input.data.rules.ltcAssumptions
        ? input.data.rules.ltcAssumptions.enabled
          ? typeof input.data.rules.ltcAssumptions.eventProbability === 'number'
            ? `Long-term care cost assumption is active with ${(input.data.rules.ltcAssumptions.eventProbability * 100).toFixed(
                0,
              )}% event probability.`
            : 'Long-term care cost is active but treated as a certain event; set event probability for probabilistic modeling.'
          : 'Long-term care assumption is present but disabled; enable to stress-test tail-cost risk.'
        : 'No long-term care cost assumption is currently modeled.',
    },
  ];

  return {
    generatedAtIso: new Date().toISOString(),
    items,
  };
}
