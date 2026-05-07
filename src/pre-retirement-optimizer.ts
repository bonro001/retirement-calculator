import type {
  MarketAssumptions,
  PreRetirementContributionSettings,
  SeedData,
} from './types';
import { calculatePreRetirementContributions } from './contribution-engine';
import { calculateFederalTax, type YearTaxInputs } from './tax-engine';

// BACKLOG item: surface the numerical decomposition behind
// "Accumulate / Max 401k / Pre-build the taxable bridge" strategic-prep
// advice. Converts a generic card into a decision-grade recommendation
// that names current shortfalls, quantifies their tax value, and
// projects the remaining surplus available for taxable-bridge build-up.
//
// Pure function of SeedData + MarketAssumptions. Zero UI dependencies.
// Consumed by a flight-path-policy recommendation and/or a dashboard
// tile.

export interface ContributionShortfall {
  bucket: 'employee_401k' | 'hsa';
  label: string;
  currentAnnualContribution: number;
  annualLimit: number;
  shortfallAnnual: number;
  shortfallPct: number; // currentAnnualContribution / annualLimit
  estimatedMarginalFederalTaxSavedPerYear: number;
}

export interface BridgeBuildUpProjection {
  // Annual cash flow once both pre-tax buckets are maxed:
  grossSalary: number;
  preTaxContributionsAtMax: number;
  estimatedFederalTaxAtMax: number;
  estimatedFicaTax: number;
  estimatedTakeHomeAtMax: number;
  estimatedAnnualLifestyleSpend: number;
  estimatedAnnualSurplus: number;
  // Over the user's remaining working horizon:
  yearsUntilSalaryEnds: number;
  projectedBridgePotContribution: number;
  currentTaxableBalance: number;
  projectedTaxableAtRetirement: number;
  // Windfalls that land during the bridge window (retirement → Medicare)
  // and carry a tax treatment that makes them land in a liquid/taxable
  // bucket. These reduce the effective coverage gap because they're
  // bridge-year inflows.
  bridgeWindowWindfallTotal: number;
  bridgeWindowWindfallNames: string[];
  // Target to cover early-retirement years until age 65 / Medicare:
  bridgeYearsCovered: number;
  bridgeTargetBalance: number;
  // Coverage gap AFTER crediting bridge-window windfalls.
  bridgeCoverageGap: number;
}

export interface PreRetirementOptimizerRecommendation {
  applicable: boolean;
  reason?: string;
  // The decomposition:
  shortfalls: ContributionShortfall[];
  bridge: BridgeBuildUpProjection;
  // Headlines for a UI card:
  headline: string;
  actionSteps: Array<{
    priority: number;
    action: string;
    impact: string;
  }>;
  // The trade-off-in-tension check. Returns true when the advisory to
  // both "max 401k" AND "pre-build taxable bridge" can be executed in
  // parallel (i.e., surplus is non-negative after maxing pre-tax).
  bothRecommendationsCompatible: boolean;
}

export interface PreRetirementOptimizerInput {
  seedData: SeedData;
  assumptions?: MarketAssumptions;
  // Marginal federal rate used for tax-savings math. Defaults to 22%
  // (common for MFJ in the $168k-$210k salary range after std ded +
  // pre-tax contributions).
  marginalFederalRate?: number;
  // FICA rate on remaining wages (Social Security 6.2% + Medicare
  // 1.45%). Does not include the 0.9% additional Medicare tax which
  // only applies >$250k MFJ.
  ficaRate?: number;
  // Medicare age — used to define the length of the ACA-bridge
  // window (retirement → age 65).
  medicareAge?: number;
}

function getAge(birthDateIso: string, asOf: Date): number {
  const birth = new Date(birthDateIso);
  const years = asOf.getFullYear() - birth.getFullYear();
  const monthDelta = asOf.getMonth() - birth.getMonth();
  return monthDelta < 0 || (monthDelta === 0 && asOf.getDate() < birth.getDate())
    ? years - 1
    : years;
}

function yearsUntil(dateIso: string, asOf: Date): number {
  const target = new Date(dateIso);
  const msPerYear = 1000 * 60 * 60 * 24 * 365.25;
  return Math.max(0, (target.valueOf() - asOf.valueOf()) / msPerYear);
}

function estimateWindfallLiquidity(
  windfall: SeedData['income']['windfalls'][number],
) {
  if (typeof windfall.liquidityAmount === 'number') {
    return Math.max(0, windfall.liquidityAmount);
  }
  if (windfall.name !== 'home_sale') {
    return Math.max(0, windfall.amount);
  }
  const gross = Math.max(0, windfall.amount);
  const sellingCost = gross * Math.max(0, Math.min(1, windfall.sellingCostPercent ?? 0));
  const replacementHomeCost = Math.max(0, windfall.replacementHomeCost ?? 0);
  const replacementCost =
    replacementHomeCost +
    replacementHomeCost * Math.max(0, Math.min(1, windfall.purchaseClosingCostPercent ?? 0)) +
    Math.max(0, windfall.movingCost ?? 0);
  return Math.max(0, gross - sellingCost - replacementCost);
}

function deriveCurrentContributionRates(
  settings: PreRetirementContributionSettings | undefined,
  salaryAnnual: number,
): { current401kAnnual: number; currentHsaAnnual: number } {
  if (!settings) {
    return { current401kAnnual: 0, currentHsaAnnual: 0 };
  }
  const preTaxPct =
    settings.employee401kPreTaxPercentOfSalary ??
    settings.employee401kPercentOfSalary ??
    0;
  const rothPct = settings.employee401kRothPercentOfSalary ?? 0;
  const pretaxAmt = settings.employee401kPreTaxAnnualAmount ?? 0;
  const rothAmt = settings.employee401kRothAnnualAmount ?? 0;
  const legacyAmt = settings.employee401kAnnualAmount ?? 0;
  const current401k =
    Math.max(pretaxAmt, preTaxPct * salaryAnnual) +
    Math.max(rothAmt, rothPct * salaryAnnual) +
    legacyAmt;

  const hsaPct = settings.hsaPercentOfSalary ?? 0;
  const hsaAmt = settings.hsaAnnualAmount ?? 0;
  const currentHsa = hsaAmt > 0 ? hsaAmt : hsaPct * salaryAnnual;

  return { current401kAnnual: current401k, currentHsaAnnual: currentHsa };
}

export function buildPreRetirementOptimizerRecommendation(
  input: PreRetirementOptimizerInput,
  now: Date = new Date(),
): PreRetirementOptimizerRecommendation {
  const { seedData } = input;
  const salaryAnnual = seedData.income.salaryAnnual;
  const salaryEndDate = seedData.income.salaryEndDate;
  const marginalFederalRate = input.marginalFederalRate ?? 0.22;
  const ficaRate = input.ficaRate ?? 0.0765;
  const medicareAge = input.medicareAge ?? 65;

  if (salaryAnnual <= 0) {
    return emptyRecommendation('User is already retired or has no wage income.');
  }
  const yearsUntilSalaryEnds = yearsUntil(salaryEndDate, now);
  if (yearsUntilSalaryEnds <= 0) {
    return emptyRecommendation('Salary end date has passed.');
  }

  const headAge = getAge(seedData.household.robBirthDate, now);

  // Use existing contribution-engine limits (includes catch-up).
  const contribution = calculatePreRetirementContributions({
    age: headAge,
    salaryAnnual,
    projectionYear: now.getFullYear(),
    filingStatus: seedData.household.filingStatus,
    settings: seedData.income.preRetirementContributions,
    limitSettings: seedData.rules.contributionLimits,
  });

  const limit401k = contribution.employee401kAnnualLimit;
  const limitHsa = contribution.hsaAnnualLimit;

  const { current401kAnnual, currentHsaAnnual } = deriveCurrentContributionRates(
    seedData.income.preRetirementContributions,
    salaryAnnual,
  );

  const shortfall401k = Math.max(0, limit401k - current401kAnnual);
  const shortfallHsa = Math.max(0, limitHsa - currentHsaAnnual);

  const shortfalls: ContributionShortfall[] = [
    {
      bucket: 'employee_401k',
      label: '401(k) employee contribution (incl. catch-up if 50+)',
      currentAnnualContribution: current401kAnnual,
      annualLimit: limit401k,
      shortfallAnnual: shortfall401k,
      shortfallPct:
        limit401k > 0 ? current401kAnnual / limit401k : 0,
      estimatedMarginalFederalTaxSavedPerYear:
        shortfall401k * marginalFederalRate,
    },
    {
      bucket: 'hsa',
      label: 'HSA (triple tax advantage)',
      currentAnnualContribution: currentHsaAnnual,
      annualLimit: limitHsa,
      shortfallAnnual: shortfallHsa,
      shortfallPct: limitHsa > 0 ? currentHsaAnnual / limitHsa : 0,
      estimatedMarginalFederalTaxSavedPerYear:
        shortfallHsa * marginalFederalRate,
    },
  ];

  // Cash-flow model assuming BOTH buckets are maxed (not current rates).
  const preTaxAtMax = limit401k + limitHsa;
  const wagesAfterPreTax = salaryAnnual - preTaxAtMax;
  // Rough federal tax at these wages (standard deduction only, no SS yet).
  const estimatedTaxInputs: YearTaxInputs = {
    wages: wagesAfterPreTax,
    pension: 0,
    socialSecurityBenefits: 0,
    ira401kWithdrawals: 0,
    rothWithdrawals: 0,
    taxableInterest: 0,
    qualifiedDividends: 0,
    ordinaryDividends: 0,
    realizedLTCG: 0,
    realizedSTCG: 0,
    otherOrdinaryIncome: 0,
    filingStatus: seedData.household.filingStatus,
  };
  const estimatedFederalTaxAtMax =
    calculateFederalTax(estimatedTaxInputs).federalTax;
  const estimatedFicaTax = salaryAnnual * ficaRate;

  const estimatedTakeHomeAtMax =
    wagesAfterPreTax - estimatedFederalTaxAtMax - estimatedFicaTax;

  const estimatedAnnualLifestyleSpend =
    (seedData.spending.essentialMonthly + seedData.spending.optionalMonthly) *
      12 +
    seedData.spending.annualTaxesInsurance;

  const estimatedAnnualSurplus = Math.max(
    0,
    estimatedTakeHomeAtMax - estimatedAnnualLifestyleSpend,
  );

  const currentTaxableBalance = seedData.accounts.taxable.balance;
  const projectedBridgePotContribution =
    estimatedAnnualSurplus * yearsUntilSalaryEnds;
  const projectedTaxableAtRetirement =
    currentTaxableBalance + projectedBridgePotContribution;

  const bridgeYearsCovered =
    Math.max(0, medicareAge - (headAge + yearsUntilSalaryEnds));
  const bridgeTargetBalance =
    estimatedAnnualLifestyleSpend * bridgeYearsCovered;

  // Sum windfalls that land during the bridge window and whose tax
  // treatment makes them available as liquid inflows — inheritances,
  // home-sale proceeds, and similar. Inherited-IRA distributions are
  // excluded because they spread over 10 years and don't cleanly
  // backstop a 2-3 year bridge window.
  const retirementYear = new Date(salaryEndDate).getFullYear();
  const medicareYear = retirementYear + Math.ceil(bridgeYearsCovered);
  const BRIDGE_ELIGIBLE_TREATMENTS = new Set([
    'cash_non_taxable',
    'ltcg',
    'primary_home_sale',
  ]);
  const bridgeWindfalls = (seedData.income.windfalls ?? []).filter((windfall) => {
    if (windfall.year < retirementYear) return false;
    if (windfall.year > medicareYear) return false;
    const treatment = windfall.taxTreatment ?? 'cash_non_taxable';
    return BRIDGE_ELIGIBLE_TREATMENTS.has(treatment);
  });
  const bridgeWindowWindfallTotal = bridgeWindfalls.reduce(
    (sum, windfall) => sum + estimateWindfallLiquidity(windfall),
    0,
  );
  const bridgeWindowWindfallNames = bridgeWindfalls.map((windfall) => windfall.name);

  const effectiveBridgeReserves =
    projectedTaxableAtRetirement + bridgeWindowWindfallTotal;
  const bridgeCoverageGap = Math.max(
    0,
    bridgeTargetBalance - effectiveBridgeReserves,
  );

  const bridge: BridgeBuildUpProjection = {
    grossSalary: salaryAnnual,
    preTaxContributionsAtMax: preTaxAtMax,
    estimatedFederalTaxAtMax,
    estimatedFicaTax,
    estimatedTakeHomeAtMax,
    estimatedAnnualLifestyleSpend,
    estimatedAnnualSurplus,
    yearsUntilSalaryEnds,
    projectedBridgePotContribution,
    currentTaxableBalance,
    projectedTaxableAtRetirement,
    bridgeWindowWindfallTotal,
    bridgeWindowWindfallNames,
    bridgeYearsCovered,
    bridgeTargetBalance,
    bridgeCoverageGap,
  };

  const hsaShortfallMaterial = shortfallHsa > 1_000;
  const the401kShortfallMaterial = shortfall401k > 1_000;
  const bothRecommendationsCompatible = estimatedAnnualSurplus > 0;

  const actionSteps: PreRetirementOptimizerRecommendation['actionSteps'] = [];
  let priority = 1;
  if (the401kShortfallMaterial) {
    actionSteps.push({
      priority: priority++,
      action: `Increase 401(k) contribution by $${Math.round(shortfall401k).toLocaleString()}/yr to hit the $${limit401k.toLocaleString()} limit (incl. catch-up).`,
      impact: `Saves ~$${Math.round(shortfall401k * marginalFederalRate).toLocaleString()}/yr in current-year federal tax at ${Math.round(marginalFederalRate * 100)}% marginal rate.`,
    });
  }
  if (hsaShortfallMaterial) {
    actionSteps.push({
      priority: priority++,
      action: `Increase HSA contribution by $${Math.round(shortfallHsa).toLocaleString()}/yr to hit the $${limitHsa.toLocaleString()} limit (incl. 55+ catch-up if applicable).`,
      impact: `Saves ~$${Math.round(shortfallHsa * marginalFederalRate).toLocaleString()}/yr in current-year federal tax, plus future HSA withdrawals are tax-free when used for qualified medical expenses.`,
    });
  }
  if (bridgeCoverageGap > 10_000 && estimatedAnnualSurplus > 0) {
    const gapAnnualized = bridgeCoverageGap / Math.max(1, yearsUntilSalaryEnds);
    const windfallNote =
      bridgeWindowWindfallTotal > 0
        ? ` Already crediting $${Math.round(bridgeWindowWindfallTotal).toLocaleString()} from in-window windfalls (${bridgeWindowWindfallNames.join(', ')}).`
        : '';
    actionSteps.push({
      priority: priority++,
      action: `Direct ~$${Math.round(Math.min(estimatedAnnualSurplus, gapAnnualized)).toLocaleString()}/yr of remaining take-home surplus into the taxable brokerage (the "ACA bridge").`,
      impact: `Projected taxable at retirement: $${Math.round(projectedTaxableAtRetirement).toLocaleString()} + windfalls $${Math.round(bridgeWindowWindfallTotal).toLocaleString()}. Bridge target to cover ~${bridgeYearsCovered.toFixed(1)} years pre-Medicare at current spend: $${Math.round(bridgeTargetBalance).toLocaleString()}. Remaining coverage gap: $${Math.round(bridgeCoverageGap).toLocaleString()}.${windfallNote}`,
    });
  } else if (bridgeCoverageGap === 0 && bridgeWindowWindfallTotal > 0) {
    actionSteps.push({
      priority: priority++,
      action: `Bridge is already fully funded ($${Math.round(projectedTaxableAtRetirement + bridgeWindowWindfallTotal).toLocaleString()} vs $${Math.round(bridgeTargetBalance).toLocaleString()} target) — no pre-retirement build-up needed.`,
      impact: `Coverage comes primarily from current taxable ($${Math.round(projectedTaxableAtRetirement).toLocaleString()}) plus in-window windfall${bridgeWindowWindfallNames.length > 1 ? 's' : ''} (${bridgeWindowWindfallNames.join(', ')}: $${Math.round(bridgeWindowWindfallTotal).toLocaleString()}).`,
    });
  }

  const headline =
    actionSteps.length === 0
      ? 'Plan is fully optimized for pre-retirement accumulation — all pre-tax buckets maxed and bridge coverage sufficient.'
      : `${actionSteps.length} concrete pre-retirement move${actionSteps.length > 1 ? 's' : ''} identified with ~$${Math.round(
          shortfalls.reduce(
            (sum, s) => sum + s.estimatedMarginalFederalTaxSavedPerYear,
            0,
          ),
        ).toLocaleString()}/yr total current-tax impact.`;

  return {
    applicable: true,
    shortfalls,
    bridge,
    headline,
    actionSteps,
    bothRecommendationsCompatible,
  };
}

function emptyRecommendation(reason: string): PreRetirementOptimizerRecommendation {
  return {
    applicable: false,
    reason,
    shortfalls: [],
    bridge: {
      grossSalary: 0,
      preTaxContributionsAtMax: 0,
      estimatedFederalTaxAtMax: 0,
      estimatedFicaTax: 0,
      estimatedTakeHomeAtMax: 0,
      estimatedAnnualLifestyleSpend: 0,
      estimatedAnnualSurplus: 0,
      yearsUntilSalaryEnds: 0,
      projectedBridgePotContribution: 0,
      currentTaxableBalance: 0,
      projectedTaxableAtRetirement: 0,
      bridgeWindowWindfallTotal: 0,
      bridgeWindowWindfallNames: [],
      bridgeYearsCovered: 0,
      bridgeTargetBalance: 0,
      bridgeCoverageGap: 0,
    },
    headline: reason,
    actionSteps: [],
    bothRecommendationsCompatible: false,
  };
}
