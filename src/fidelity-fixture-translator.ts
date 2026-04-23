import type { MarketAssumptions, SeedData } from './types';
import { initialSeedData } from './data';

// Fidelity fixture is intentionally thinner than the Boldin one: Fidelity
// does not publish per-account rate overrides, so the translator's job here
// is primarily (a) reuse the household + account structure from seed data
// (same portfolio both tools are analyzing) and (b) configure our engine to
// approximate Fidelity's methodology — historical asset-class sampling at
// default mean/vol — rather than Boldin's Conservative-preset override.

export interface FidelityFixture {
  $meta?: Record<string, unknown>;
  household: {
    you: {
      name: string;
      age: number;
      currentlyWorking: boolean;
      retirementAge: number;
      retirementYear: number;
      longevityAge: number;
      longevityYear: number;
    };
    spouse: {
      name: string;
      age: number;
      alreadyRetired: boolean;
      retiredAtAge: number;
      longevityAge: number;
      longevityYear: number;
    };
    filingStatus: string;
    state: string;
  };
  income: {
    work: { annualSalary: number };
  };
  portfolio: {
    totalBalance: number;
    assetMixPct: {
      domesticStock: number;
      foreignStock: number;
      bonds: number;
      shortTerm: number;
      other: number;
      unknown: number;
    };
  };
  expenses: {
    essentialMonthly: number;
    nonEssentialMonthly: number;
    totalMonthly: number;
    longTermCareAnnual: number;
  };
  expected: {
    probabilityOfSuccessPct: number;
    totalLifetimeIncome: number;
    assetsRemainingTenthPercentile: number;
    currentSavingsBalance: number;
  };
}

export interface FidelityTranslationOptions {
  // Collapse MC volatility to near-zero to approximate a deterministic
  // single-path projection. Useful for isolating sequence-risk contribution.
  nearZeroVolatility?: boolean;
  // Disable Roth-conversion engine to isolate its tax-saving contribution.
  disableRothConversions?: boolean;
}

export interface FidelityTranslationNote {
  field: string;
  severity: 'info' | 'warn';
  detail: string;
}

export interface FidelityTranslatedPlan {
  seedData: SeedData;
  assumptions: MarketAssumptions;
  notes: FidelityTranslationNote[];
}

function buildAssumptions(
  fixture: FidelityFixture,
  options: FidelityTranslationOptions,
): MarketAssumptions {
  // Use our engine's historically-anchored defaults. Fidelity explicitly
  // samples from "historical performance" per asset class, so matching their
  // methodology means matching a historical distribution, not a deliberately
  // conservative one. Our defaults are close to SBBI long-run averages.
  const vol = options.nearZeroVolatility
    ? {
        equityVolatility: 0.02,
        internationalEquityVolatility: 0.02,
        bondVolatility: 0.01,
        cashVolatility: 0.005,
        inflationVolatility: 0.005,
      }
    : {
        equityVolatility: 0.16,
        internationalEquityVolatility: 0.18,
        bondVolatility: 0.07,
        cashVolatility: 0.01,
        inflationVolatility: 0.01,
      };

  return {
    // Historical long-run approximations. Fidelity doesn't publish exact
    // numbers but these match common SBBI long-run points and the Trinity
    // regime we just validated against in historical-cohorts.
    equityMean: 0.098,
    internationalEquityMean: 0.085,
    bondMean: 0.053,
    cashMean: 0.03,
    inflation: 0.025,
    simulationRuns: 500,
    irmaaThreshold: 200000,
    guardrailFloorYears: 12,
    guardrailCeilingYears: 18,
    guardrailCutPercent: 0.2,
    robPlanningEndAge: fixture.household.you.longevityAge,
    debbiePlanningEndAge: fixture.household.spouse.longevityAge,
    travelPhaseYears: 5,
    simulationSeed: 424242,
    assumptionsVersion: `fidelity-historical${
      options.nearZeroVolatility ? '-lowvol' : ''
    }`,
    ...vol,
  };
}

export function translateFidelityFixture(
  fixture: FidelityFixture,
  options: FidelityTranslationOptions = {},
): FidelityTranslatedPlan {
  const notes: FidelityTranslationNote[] = [];

  // Reuse the household + account structure from seed-data.json since this
  // is the same portfolio Fidelity is analyzing. Fidelity doesn't expose
  // per-account balances, so using the canonical seed is the only way to
  // drive our engine's bucket model consistently.
  const seedData: SeedData = JSON.parse(JSON.stringify(initialSeedData));

  notes.push({
    field: 'accounts',
    severity: 'info',
    detail:
      'Reusing per-account balances from initialSeedData (seed-data.json). Fidelity does not publish per-account balances.',
  });

  const rothConversionPolicy = options.disableRothConversions
    ? {
        ...(seedData.rules.rothConversionPolicy ?? {}),
        enabled: false,
      }
    : seedData.rules.rothConversionPolicy;
  if (options.disableRothConversions) {
    notes.push({
      field: 'rules.rothConversionPolicy',
      severity: 'info',
      detail:
        'Roth-conversion engine disabled to isolate tax-saving contribution. Fidelity does not surface whether it automatically evaluates conversions.',
    });
  }

  seedData.rules = {
    ...seedData.rules,
    rothConversionPolicy,
  };

  notes.push({
    field: 'assumptions.returns',
    severity: 'info',
    detail:
      'Using historical-approximation means (equity 9.8%, intl 8.5%, bonds 5.3%, cash 3.0%). Fidelity does not publish exact values; these match common SBBI long-run points and the regime under which our historical-cohorts tests pass.',
  });

  notes.push({
    field: 'assumptions.assetMix',
    severity: 'warn',
    detail: `Fidelity reports portfolio asset mix at domestic ${(fixture.portfolio.assetMixPct.domesticStock * 100).toFixed(1)}% / foreign ${(fixture.portfolio.assetMixPct.foreignStock * 100).toFixed(1)}% / bonds ${(fixture.portfolio.assetMixPct.bonds * 100).toFixed(1)}% / short-term ${(fixture.portfolio.assetMixPct.shortTerm * 100).toFixed(1)}%. Our engine's bucket-level allocations from initialSeedData should aggregate near those numbers; drift between the two would be worth a dedicated allocation audit (see BACKLOG.md "Allocation check").`,
  });

  return {
    seedData,
    assumptions: buildAssumptions(fixture, options),
    notes,
  };
}
