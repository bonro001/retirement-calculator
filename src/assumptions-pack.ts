import type { MarketAssumptions, SeedData } from './types';

const CURRENT_DATE = new Date('2026-04-16T12:00:00Z');
const CURRENT_YEAR = CURRENT_DATE.getUTCFullYear();

export interface SharedAssumptionsPack {
  id: string;
  profileName: string;
  generatedAt: string;
  version: string;
  returns: {
    usEquityMean: number;
    usEquityVolatility: number;
    internationalEquityMean: number;
    internationalEquityVolatility: number;
    bondMean: number;
    bondVolatility: number;
    cashMean: number;
    cashVolatility: number;
  };
  inflation: {
    mean: number;
    volatility: number;
  };
  taxes: {
    moduleStatus: 'scaffold';
    filingStatus: string;
    state: string;
    heuristicFederalRate: number;
    heuristicStateRate: number;
    heuristicEffectiveRate: number;
  };
  socialSecurity: {
    moduleStatus: 'scaffold';
    fraAge: number;
    earlyClaimReductionPerYear: number;
    delayedRetirementCreditPerYear: number;
    entries: Array<{
      person: string;
      fraMonthly: number;
      claimAge: number;
    }>;
  };
  spending: {
    essentialMonthly: number;
    optionalMonthly: number;
    annualTaxesInsurance: number;
    travelEarlyRetirementAnnual: number;
    travelPhaseYears: number;
  };
  horizon: {
    robPlanningEndAge: number;
    debbiePlanningEndAge: number;
    planningEndYear: number;
  };
}

function calculateAgeOnDate(birthDateValue: string, asOfDate: Date) {
  const birthDate = new Date(birthDateValue);
  let age = asOfDate.getUTCFullYear() - birthDate.getUTCFullYear();
  const monthDelta = asOfDate.getUTCMonth() - birthDate.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && asOfDate.getUTCDate() < birthDate.getUTCDate())) {
    age -= 1;
  }
  return age;
}

function clampRate(value: number) {
  return Math.max(0, Math.min(1, value));
}

function getHeuristicTaxRates(state: string) {
  const heuristicFederalRate = 0.16;
  const noIncomeTaxStates = new Set(['TX', 'FL', 'WA', 'NV', 'TN', 'SD', 'WY', 'AK', 'NH']);
  const heuristicStateRate = noIncomeTaxStates.has(state.toUpperCase()) ? 0 : 0.04;
  const heuristicEffectiveRate = clampRate(heuristicFederalRate + heuristicStateRate);
  return { heuristicFederalRate, heuristicStateRate, heuristicEffectiveRate };
}

export function createSharedAssumptionsPack(
  data: SeedData,
  assumptions: MarketAssumptions,
): SharedAssumptionsPack {
  const robAge = calculateAgeOnDate(data.household.robBirthDate, CURRENT_DATE);
  const debbieAge = calculateAgeOnDate(data.household.debbieBirthDate, CURRENT_DATE);
  const horizonYears = Math.max(
    assumptions.robPlanningEndAge - robAge,
    assumptions.debbiePlanningEndAge - debbieAge,
    0,
  );
  const planningEndYear = CURRENT_YEAR + horizonYears;
  const taxRates = getHeuristicTaxRates(data.household.state);

  return {
    id: `shared-profile-${CURRENT_YEAR}`,
    profileName: 'Shared Comparison Profile',
    generatedAt: new Date().toISOString(),
    version: 'v1-scaffold',
    returns: {
      usEquityMean: assumptions.equityMean,
      usEquityVolatility: assumptions.equityVolatility,
      internationalEquityMean: assumptions.internationalEquityMean,
      internationalEquityVolatility: assumptions.internationalEquityVolatility,
      bondMean: assumptions.bondMean,
      bondVolatility: assumptions.bondVolatility,
      cashMean: assumptions.cashMean,
      cashVolatility: assumptions.cashVolatility,
    },
    inflation: {
      mean: assumptions.inflation,
      volatility: assumptions.inflationVolatility,
    },
    taxes: {
      moduleStatus: 'scaffold',
      filingStatus: data.household.filingStatus,
      state: data.household.state,
      heuristicFederalRate: taxRates.heuristicFederalRate,
      heuristicStateRate: taxRates.heuristicStateRate,
      heuristicEffectiveRate: taxRates.heuristicEffectiveRate,
    },
    socialSecurity: {
      moduleStatus: 'scaffold',
      fraAge: 67,
      earlyClaimReductionPerYear: 0.06,
      delayedRetirementCreditPerYear: 0.08,
      entries: data.income.socialSecurity.map((entry) => ({
        person: entry.person,
        fraMonthly: entry.fraMonthly,
        claimAge: entry.claimAge,
      })),
    },
    spending: {
      essentialMonthly: data.spending.essentialMonthly,
      optionalMonthly: data.spending.optionalMonthly,
      annualTaxesInsurance: data.spending.annualTaxesInsurance,
      travelEarlyRetirementAnnual: data.spending.travelEarlyRetirementAnnual,
      travelPhaseYears: assumptions.travelPhaseYears,
    },
    horizon: {
      robPlanningEndAge: assumptions.robPlanningEndAge,
      debbiePlanningEndAge: assumptions.debbiePlanningEndAge,
      planningEndYear,
    },
  };
}
