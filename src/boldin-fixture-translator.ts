import type {
  AccountBucket,
  AccountsData,
  IncomeData,
  MarketAssumptions,
  SeedData,
  SpendingData,
  WindfallEntry,
} from './types';
import { initialSeedData } from './data';

// Shape of fixtures/boldin_*.json. Mirrors Boldin's UI groupings so the fixture
// stays readable as "what Boldin displays" — the translator is the only code
// that understands how to fold that into our bucket-shaped SeedData.
export interface BoldinFixture {
  $meta?: Record<string, unknown>;
  household: {
    you: {
      name: string;
      retirementDate: string;
      retirementAgeYM: string;
      longevityAge: number;
      longevityYear: number;
    };
    spouse: {
      name: string;
      alreadyRetired?: boolean;
      retiredForYears?: number;
      approxRetirementYear?: number;
      longevityAge: number;
      longevityYear: number;
    };
    filingStatus: string;
    state: string;
  };
  income: {
    work: {
      monthly: number;
      annual: number;
      startsBefore?: string;
      endsOn: string;
      growthRateAnnual?: number;
    };
    socialSecurity: {
      you: { monthlyAtClaim: number; claimDate: string; claimAge: number };
      spouse: { monthlyAtClaim: number; claimDate: string; claimAge?: number };
      combinedMonthlyWhenBothClaiming?: number;
      lifetimeBenefit?: number;
      colaAnnual?: number;
    };
    windfalls?: Array<{
      label: string;
      amount: number;
      date: string;
      depositTo?: string;
    }>;
  };
  accounts: Array<{
    name: string;
    type: string;
    taxTreatment?: string;
    balance: number;
    rateOfReturn: number;
    rateLabel?: string;
    costBasis?: number;
    turnover?: number;
  }>;
  accountsTotal?: number;
  realEstate: {
    currentEquity: number;
    mortgageBalance: number;
    appreciationAnnual: number;
    plannedSale: {
      date: string;
      reinvestInNewHome: number;
      note?: string;
    } | null;
    note?: string;
  };
  expenses: {
    recurringMonthly: number;
    oneTime?: Array<{
      label: string;
      totalAmount: number;
      startDate: string;
      endDate: string;
    }>;
    medical?: Record<string, unknown>;
  };
  rates: {
    generalInflation: number;
    medicalInflation: number;
    socialSecurityCola: number;
    housingAppreciation: number;
  };
  moneyFlows?: Record<string, unknown>;
  expected: {
    chanceOfSuccessPct: number;
    netWorthAtLongevity: number;
    lifetimeIncomeTaxesPaid: number;
    currentSavingsBalance: number;
    taxAllocationAllAssetsAt94: number;
    netWorthAt94Approx?: number;
    netWorthAt94MixPct?: { realEstate: number; savings: number };
    notes?: string[];
  };
}

export interface TranslationNote {
  field: string;
  severity: 'info' | 'warn';
  detail: string;
}

export interface TranslationOptions {
  // Override our engine's healthcare baseline premiums with an annualized
  // approximation of Boldin's lifetime medical totals, so total healthcare
  // spend lines up with Boldin.
  healthcareOverlayFromBoldin?: boolean;
  // Turn off the aggressive Roth-conversion policy inherited from seed rules,
  // isolating its tax-saving contribution to ending wealth.
  disableRothConversions?: boolean;
  // Collapse MC volatility to near-zero to approximate Boldin's deterministic
  // single-path projection.
  nearZeroVolatility?: boolean;
  // Omit the home-sale windfall so the comparison is liquid-only on both
  // sides. Compare against Boldin's taxAllocationAllAssetsAt94 figure.
  excludeHome?: boolean;
  // Match Boldin's account-level return distribution: uniform 5.92% mean
  // (Conservative preset) with 11.05% stdev across all buckets. Overrides
  // any per-account rate in the fixture for MarketAssumptions purposes.
  matchBoldinConservativeDistribution?: boolean;
}

export interface TranslatedPlan {
  seedData: SeedData;
  assumptions: MarketAssumptions;
  notes: TranslationNote[];
}

// Map each Boldin account into one of our four buckets (+ HSA). The classifier
// is deliberately narrow — unknown types throw so we notice drift in new
// fixtures rather than silently miscategorizing funds.
type BucketKey = 'pretax' | 'roth' | 'taxable' | 'cash' | 'hsa';

function classifyAccount(name: string, type: string): BucketKey {
  const t = type.toLowerCase();
  if (t.includes('401') || t === 'traditional ira') return 'pretax';
  if (t === 'roth ira') return 'roth';
  if (t === 'investment') return 'taxable';
  if (t === 'savings') return 'cash';
  if (t === 'hsa') return 'hsa';
  throw new Error(`Unknown Boldin account type "${type}" for "${name}"`);
}

// Per-bucket synthetic allocation chosen to reproduce Boldin's quoted rate of
// return when combined with the overridden MarketAssumptions below. Using a
// single-symbol allocation keeps the weighted return exact instead of solving
// a mix for each bucket.
function allocationForRate(rate: number): Record<string, number> {
  if (rate >= 0.07) return { VTI: 1 };
  if (rate >= 0.04) return { BND: 1 };
  return { CASH: 1 };
}

function sumBalances(
  accounts: BoldinFixture['accounts'],
  bucket: BucketKey,
): number {
  return accounts
    .filter((a) => classifyAccount(a.name, a.type) === bucket)
    .reduce((sum, a) => sum + a.balance, 0);
}

function bucketFromAccounts(
  accounts: BoldinFixture['accounts'],
  bucket: BucketKey,
): AccountBucket {
  const balance = sumBalances(accounts, bucket);
  const reprAccount = accounts.find(
    (a) => classifyAccount(a.name, a.type) === bucket,
  );
  const rate = reprAccount?.rateOfReturn ?? 0.03;
  return {
    balance,
    targetAllocation: allocationForRate(rate),
  };
}

function buildAccounts(fixture: BoldinFixture): AccountsData {
  return {
    pretax: bucketFromAccounts(fixture.accounts, 'pretax'),
    roth: bucketFromAccounts(fixture.accounts, 'roth'),
    taxable: bucketFromAccounts(fixture.accounts, 'taxable'),
    cash: bucketFromAccounts(fixture.accounts, 'cash'),
    hsa: bucketFromAccounts(fixture.accounts, 'hsa'),
  };
}

function birthDateFromRetirement(
  retirementDate: string,
  retirementAgeYM: string,
): string {
  // "62y7m" + retirement date → birth date
  const match = retirementAgeYM.match(/(\d+)y(\d+)m/);
  if (!match) throw new Error(`Bad age format: ${retirementAgeYM}`);
  const years = Number(match[1]);
  const months = Number(match[2]);
  const retirement = new Date(retirementDate);
  const birth = new Date(retirement);
  birth.setFullYear(retirement.getFullYear() - years);
  birth.setMonth(retirement.getMonth() - months);
  return birth.toISOString().slice(0, 10);
}

function birthDateFromLongevity(longevityAge: number, longevityYear: number): string {
  const birthYear = longevityYear - longevityAge;
  return `${birthYear}-06-15`;
}

function buildWindfalls(
  fixture: BoldinFixture,
  options: TranslationOptions,
): WindfallEntry[] {
  const windfalls: WindfallEntry[] = [];

  // Direct windfalls (inheritance, gifts, etc). Boldin deposits these to a
  // taxable account, but typical treatment for an unlabeled Boldin windfall is
  // non-taxable cash (inheritance-like). Mark certainty appropriately.
  for (const w of fixture.income.windfalls ?? []) {
    const year = Number(w.date.slice(0, 4));
    windfalls.push({
      name: w.label,
      year,
      amount: w.amount,
      taxTreatment: 'cash_non_taxable',
      certainty: 'estimated',
    });
  }

  if (options.excludeHome || !fixture.realEstate.plannedSale) {
    return windfalls;
  }

  // Home sale → windfall in the sale year. Appreciate current equity at the
  // housing rate, subtract the amount re-invested into the new home, treat the
  // remainder as net-to-liquid cash. Using cash_non_taxable + MFJ primary-home
  // exclusion assumption is a first-pass approximation; tighten later if the
  // engine's primary_home_sale treatment gives a closer match to Boldin.
  const sale = fixture.realEstate.plannedSale;
  const saleYear = Number(sale.date.slice(0, 4));
  const currentYear = 2026;
  const yearsToSale = saleYear - currentYear;
  const appreciatedValue =
    fixture.realEstate.currentEquity *
    Math.pow(1 + fixture.realEstate.appreciationAnnual, yearsToSale);
  const netToLiquid = Math.round(appreciatedValue - sale.reinvestInNewHome);
  windfalls.push({
    name: 'home_sale_net',
    year: saleYear,
    amount: netToLiquid,
    taxTreatment: 'cash_non_taxable',
    certainty: 'estimated',
  });

  return windfalls;
}

function buildIncome(
  fixture: BoldinFixture,
  options: TranslationOptions,
): IncomeData {
  return {
    salaryAnnual: fixture.income.work.annual,
    salaryEndDate: fixture.income.work.endsOn,
    socialSecurity: [
      {
        person: 'rob',
        fraMonthly: fixture.income.socialSecurity.you.monthlyAtClaim,
        claimAge: fixture.income.socialSecurity.you.claimAge,
      },
      {
        person: 'debbie',
        fraMonthly: fixture.income.socialSecurity.spouse.monthlyAtClaim,
        claimAge: fixture.income.socialSecurity.spouse.claimAge ?? 67,
      },
    ],
    windfalls: buildWindfalls(fixture, options),
    // Boldin explicitly shows "Recurring Contributions: None" for this scenario.
    preRetirementContributions: {
      employee401kPreTaxPercentOfSalary: 0,
      employee401kRothPercentOfSalary: 0,
      hsaPercentOfSalary: 0,
    },
  };
}

function buildSpending(fixture: BoldinFixture): SpendingData {
  const recurringAnnual = fixture.expenses.recurringMonthly * 12;
  // Boldin presents one flat recurring number. Split 55/45 essential/optional
  // to match the seed shape; we can tighten if Boldin's budgeting screen adds
  // detail later.
  const essentialMonthly = Math.round(fixture.expenses.recurringMonthly * 0.55);
  const optionalMonthly = fixture.expenses.recurringMonthly - essentialMonthly;

  // Travel bolus: Boldin shows a total over a date range. Amortize evenly.
  const travel = fixture.expenses.oneTime?.find((o) => /travel/i.test(o.label));
  let travelAnnual = 0;
  if (travel) {
    const start = new Date(travel.startDate);
    const end = new Date(travel.endDate);
    const years = Math.max(
      1,
      (end.getFullYear() - start.getFullYear()) +
        (end.getMonth() - start.getMonth()) / 12,
    );
    travelAnnual = Math.round(travel.totalAmount / years);
  }

  return {
    essentialMonthly,
    optionalMonthly,
    annualTaxesInsurance: 0, // Boldin rolls this into recurring.
    travelEarlyRetirementAnnual: travelAnnual,
  };
}

function buildAssumptions(
  fixture: BoldinFixture,
  options: TranslationOptions,
): MarketAssumptions {
  let means = {
    equityMean: 0.0808,
    internationalEquityMean: 0.0808,
    bondMean: 0.045,
    cashMean: 0.03,
  };
  let vol = options.nearZeroVolatility
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

  if (options.matchBoldinConservativeDistribution) {
    // Boldin "Conservative" preset per the Rate Inspector: avg 5.92%, stdev
    // 11.05%. Apply uniformly across equity + bond buckets so every bucket
    // samples the same distribution Boldin is using.
    means = {
      equityMean: 0.0592,
      internationalEquityMean: 0.0592,
      bondMean: 0.0592,
      cashMean: 0.03,
    };
    vol = {
      equityVolatility: 0.1105,
      internationalEquityVolatility: 0.1105,
      bondVolatility: 0.1105,
      cashVolatility: 0.01,
      inflationVolatility: 0.01,
    };
  }

  const versionTags = ['boldin-lower-returns-v1'];
  if (options.nearZeroVolatility) versionTags.push('lowvol');
  if (options.matchBoldinConservativeDistribution)
    versionTags.push('boldin-cons');

  return {
    ...means,
    inflation: fixture.rates.generalInflation,
    simulationRuns: 500,
    irmaaThreshold: 200000,
    guardrailFloorYears: 12,
    guardrailCeilingYears: 18,
    guardrailCutPercent: 0.2,
    robPlanningEndAge: fixture.household.you.longevityAge,
    debbiePlanningEndAge: fixture.household.spouse.longevityAge,
    travelPhaseYears: 5,
    simulationSeed: 424242,
    assumptionsVersion: versionTags.join('-'),
    ...vol,
  };
}

export function translateBoldinFixture(
  fixture: BoldinFixture,
  options: TranslationOptions = {},
): TranslatedPlan {
  const notes: TranslationNote[] = [];

  const robBirthDate = birthDateFromRetirement(
    fixture.household.you.retirementDate,
    fixture.household.you.retirementAgeYM,
  );
  const debbieBirthDate = birthDateFromLongevity(
    fixture.household.spouse.longevityAge,
    fixture.household.spouse.longevityYear,
  );
  notes.push({
    field: 'household.spouseBirthDate',
    severity: 'info',
    detail: 'Derived from spouse longevity age and year; month defaulted to June.',
  });

  notes.push({
    field: 'accounts.targetAllocation',
    severity: 'info',
    detail:
      'Using single-symbol allocations (VTI / BND / CASH) per bucket so the weighted return matches the Boldin rate when combined with overridden MarketAssumptions.',
  });
  notes.push({
    field: 'windfalls.home_sale_net',
    severity: 'warn',
    detail:
      'Home sale modeled as cash_non_taxable windfall in the sale year. Ignores primary-home-sale tax treatment — may over-state liquidity slightly.',
  });
  notes.push({
    field: 'spending.split',
    severity: 'warn',
    detail:
      'Boldin shows one recurring number; split 55/45 essential/optional as a placeholder.',
  });
  if (!options.nearZeroVolatility) {
    notes.push({
      field: 'assumptions.volatility',
      severity: 'warn',
      detail:
        'Boldin projects deterministically; we keep MC volatility, so success-rate deltas include MC noise.',
    });
  }

  // Healthcare overlay: amortize Boldin's published lifetime medical totals
  // and bump our engine's baseline premiums so aggregate healthcare spend
  // lines up with Boldin rather than our defaults.
  const lifetimeMedical = 46750 + 402190;
  const maxLongevityAge = Math.max(
    fixture.household.you.longevityAge,
    fixture.household.spouse.longevityAge,
  );
  const maxLongevityYear = Math.max(
    fixture.household.you.longevityYear,
    fixture.household.spouse.longevityYear,
  );
  const planningHorizonYears = maxLongevityYear - 2026; // ~31 for this household.
  const amortizedAnnualMedical = Math.round(lifetimeMedical / planningHorizonYears);
  // Medicare runs from age 65 to longevity for each spouse. Rob: ~25 years
  // (2029→2054). Debbie: ~29 years (2028→2057). Combined ~54 person-years.
  const combinedMedicarePersonYears = 54;
  const medicareImpliedAnnualPerPerson = Math.round(402190 / combinedMedicarePersonYears);

  const healthcarePremiums = options.healthcareOverlayFromBoldin
    ? {
        baselineAcaPremiumAnnual: Math.round(46750 / 2.5), // Rob's ~2.5 pre-65 years
        baselineMedicarePremiumAnnual: medicareImpliedAnnualPerPerson,
        medicalInflationAnnual: fixture.rates.medicalInflation,
      }
    : {
        ...(initialSeedData.rules.healthcarePremiums ?? {
          baselineAcaPremiumAnnual: 14400,
          baselineMedicarePremiumAnnual: 2220,
        }),
        medicalInflationAnnual: fixture.rates.medicalInflation,
      };
  if (options.healthcareOverlayFromBoldin) {
    notes.push({
      field: 'rules.healthcarePremiums',
      severity: 'info',
      detail: `Overridden from Boldin lifetime totals (~$${amortizedAnnualMedical}/yr aggregate, medicare ~$${medicareImpliedAnnualPerPerson}/person-yr).`,
    });
  }

  const rothConversionPolicy = options.disableRothConversions
    ? {
        ...(initialSeedData.rules.rothConversionPolicy ?? {}),
        enabled: false,
      }
    : initialSeedData.rules.rothConversionPolicy;
  if (options.disableRothConversions) {
    notes.push({
      field: 'rules.rothConversionPolicy',
      severity: 'info',
      detail:
        'Disabled to isolate tax-saving contribution (Boldin does not auto-convert).',
    });
  }

  if (options.nearZeroVolatility) {
    notes.push({
      field: 'assumptions.volatility',
      severity: 'info',
      detail:
        'Reduced to near-zero to approximate Boldin deterministic single-path projection.',
    });
  }

  if (options.excludeHome) {
    notes.push({
      field: 'income.windfalls.home_sale_net',
      severity: 'info',
      detail:
        'Home sale excluded — comparing liquid-only on both sides against Boldin taxAllocationAllAssetsAt94.',
    });
  }

  if (options.matchBoldinConservativeDistribution) {
    notes.push({
      field: 'assumptions.distribution',
      severity: 'info',
      detail:
        'Overridden to match Boldin Conservative preset: 5.92% mean / 11.05% stdev on equity + bond buckets.',
    });
  }

  const seedData: SeedData = {
    household: {
      robBirthDate,
      debbieBirthDate,
      filingStatus: fixture.household.filingStatus,
      planningAge: maxLongevityAge + 1,
      state: fixture.household.state,
    },
    income: buildIncome(fixture, options),
    spending: buildSpending(fixture),
    accounts: buildAccounts(fixture),
    rules: {
      ...initialSeedData.rules,
      rothConversionPolicy,
      healthcarePremiums,
    },
    stressors: initialSeedData.stressors,
    responses: initialSeedData.responses,
  };

  return {
    seedData,
    assumptions: buildAssumptions(fixture, options),
    notes,
  };
}
