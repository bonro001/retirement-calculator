import { getAssetClassMappingMetadata } from './asset-class-mapper';
import type {
  InputFidelityStatus,
  MarketAssumptions,
  ModelFidelityAssessment,
  ModelFidelityInput,
  ReliabilityImpactLevel,
  SeedData,
} from './types';

interface BuildModelFidelityInput {
  data: SeedData;
  assumptions: MarketAssumptions;
}

const MODEL_FIDELITY_REFERENCE_DATE = new Date('2026-04-16T12:00:00Z');
const ACCOUNT_BUCKETS = ['pretax', 'roth', 'taxable', 'cash', 'hsa'] as const;

function isValidDate(value: string) {
  return !Number.isNaN(new Date(value).getTime());
}

function round(value: number) {
  return Number(value.toFixed(2));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function ageAtReferenceDate(value: string) {
  if (!isValidDate(value)) {
    return null;
  }
  const birthDate = new Date(value);
  let age = MODEL_FIDELITY_REFERENCE_DATE.getUTCFullYear() - birthDate.getUTCFullYear();
  const hadBirthday =
    MODEL_FIDELITY_REFERENCE_DATE.getUTCMonth() > birthDate.getUTCMonth() ||
    (MODEL_FIDELITY_REFERENCE_DATE.getUTCMonth() === birthDate.getUTCMonth() &&
      MODEL_FIDELITY_REFERENCE_DATE.getUTCDate() >= birthDate.getUTCDate());
  if (!hadBirthday) {
    age -= 1;
  }
  return age;
}

function formatInvalidList(items: string[]) {
  return items.length > 0 ? items.join(', ') : 'none';
}

function weightedScoreForStatus(status: InputFidelityStatus) {
  if (status === 'exact') {
    return 1;
  }
  if (status === 'estimated') {
    return 0.75;
  }
  if (status === 'inferred') {
    return 0.5;
  }
  return 0;
}

function weightForImpact(level: ReliabilityImpactLevel) {
  if (level === 'high') {
    return 3;
  }
  if (level === 'medium') {
    return 2;
  }
  return 1;
}

function summarizeEffectOnReliability(score: number, blockingCount: number) {
  if (blockingCount > 0) {
    return 'Low reliability: one or more blocking assumptions are missing.';
  }
  if (score >= 85) {
    return 'High reliability: key assumptions are explicit and mostly exact.';
  }
  if (score >= 70) {
    return 'Moderate reliability: outputs are usable but depend on estimated/inferred inputs.';
  }
  return 'Low reliability: decision outputs materially depend on approximate assumptions.';
}

function toAssessmentGrade(input: {
  score: number;
  blockingCount: number;
  softCount: number;
}): ModelFidelityAssessment['assessmentGrade'] {
  if (input.blockingCount > 0 || input.score < 65) {
    return 'exploratory';
  }
  if (input.softCount > 2 || input.score < 85) {
    return 'planning_grade';
  }
  return 'decision_grade';
}

function buildCoreInputChecks(input: BuildModelFidelityInput): ModelFidelityInput[] {
  const checks: ModelFidelityInput[] = [];

  const pushCore = (
    id: string,
    label: string,
    valid: boolean,
    detail: string,
  ) => {
    checks.push({
      id,
      label,
      status: valid ? 'exact' : 'missing',
      reliabilityImpact: 'high',
      blocking: !valid,
      detail,
    });
  };

  pushCore(
    'household.robBirthDate',
    'Rob birth date',
    isValidDate(input.data.household.robBirthDate),
    'Required for age timeline, RMD timing, and Social Security coordination.',
  );
  pushCore(
    'household.debbieBirthDate',
    'Debbie birth date',
    isValidDate(input.data.household.debbieBirthDate),
    'Required for age timeline, RMD timing, and Social Security coordination.',
  );
  pushCore(
    'income.salaryEndDate',
    'Salary end date',
    isValidDate(input.data.income.salaryEndDate),
    'Required for retirement-year transition and bridge withdrawal modeling.',
  );
  pushCore(
    'income.socialSecurity',
    'Social Security elections',
    input.data.income.socialSecurity.length > 0 &&
      input.data.income.socialSecurity.every((entry) => entry.fraMonthly > 0 && entry.claimAge > 0),
    'Required for retirement cashflow and tax sequencing.',
  );
  const invalidSocialSecurityClaimAges = input.data.income.socialSecurity
    .filter((entry) => !isFiniteNumber(entry.claimAge) || entry.claimAge < 62 || entry.claimAge > 70)
    .map((entry) => `${entry.person || 'unknown'}:${entry.claimAge}`);
  pushCore(
    'income.social_security_claim_age_range',
    'Social Security claim age range',
    input.data.income.socialSecurity.length > 0 && invalidSocialSecurityClaimAges.length === 0,
    invalidSocialSecurityClaimAges.length === 0
      ? 'Each Social Security claim age is inside the explicit 62-70 modeling range.'
      : `Claim ages outside the 62-70 modeling range: ${formatInvalidList(
          invalidSocialSecurityClaimAges,
        )}.`,
  );
  pushCore(
    'assumptions.simulationSeed',
    'Simulation seed',
    input.assumptions.simulationSeed !== undefined,
    'Required for deterministic reproducibility of Monte Carlo results.',
  );
  pushCore(
    'assumptions.assumptionsVersion',
    'Assumptions version tag',
    Boolean(input.assumptions.assumptionsVersion),
    'Required for traceable versioned simulation assumptions.',
  );
  pushCore(
    'assumptions.simulation_runs',
    'Simulation run count',
    Number.isInteger(input.assumptions.simulationRuns) && input.assumptions.simulationRuns > 0,
    'Required to run a positive, deterministic Monte Carlo sample.',
  );

  const spendingFields: Array<[string, number | undefined]> = [
    ['spending.essentialMonthly', input.data.spending.essentialMonthly],
    ['spending.optionalMonthly', input.data.spending.optionalMonthly],
    ['spending.annualTaxesInsurance', input.data.spending.annualTaxesInsurance],
    ['spending.travelEarlyRetirementAnnual', input.data.spending.travelEarlyRetirementAnnual],
    ['spending.travelFloorAnnual', input.data.spending.travelFloorAnnual],
    ['spending.essentialMinimumMonthly', input.data.spending.essentialMinimumMonthly],
    ['spending.optionalMinimumMonthly', input.data.spending.optionalMinimumMonthly],
    ['spending.travelMinimumAnnual', input.data.spending.travelMinimumAnnual],
  ];
  const invalidSpendingFields = spendingFields
    .filter(([, value]) => value !== undefined && (!isFiniteNumber(value) || value < 0))
    .map(([field]) => field);
  pushCore(
    'spending.non_negative_amounts',
    'Non-negative spending amounts',
    invalidSpendingFields.length === 0,
    invalidSpendingFields.length === 0
      ? 'All explicit spending and spending-minimum inputs are finite and non-negative.'
      : `Invalid negative or non-finite spending inputs: ${formatInvalidList(
          invalidSpendingFields,
        )}.`,
  );

  const invalidAccountBalances = ACCOUNT_BUCKETS
    .filter((bucketName) => {
      const bucket = input.data.accounts[bucketName];
      return bucket !== undefined && (!isFiniteNumber(bucket.balance) || bucket.balance < 0);
    })
    .map((bucketName) => `accounts.${bucketName}.balance`);
  pushCore(
    'accounts.non_negative_balances',
    'Non-negative account balances',
    invalidAccountBalances.length === 0,
    invalidAccountBalances.length === 0
      ? 'All explicit account balances are finite and non-negative.'
      : `Invalid negative or non-finite account balances: ${formatInvalidList(
          invalidAccountBalances,
        )}.`,
  );

  const invalidAllocations = ACCOUNT_BUCKETS.flatMap((bucketName) => {
    const bucket = input.data.accounts[bucketName];
    if (!bucket) {
      return [];
    }
    const allocation = bucket.targetAllocation ?? {};
    const entries = Object.entries(allocation);
    const invalidEntries = entries
      .filter(([, value]) => !isFiniteNumber(value) || value < 0)
      .map(([symbol]) => `${bucketName}.${symbol}`);
    const allocationSum = entries.reduce(
      (sum, [, value]) => sum + (isFiniteNumber(value) ? value : 0),
      0,
    );
    const bucketHasMaterialBalance = isFiniteNumber(bucket.balance) && bucket.balance > 1;
    const sumInvalid =
      bucketHasMaterialBalance &&
      (entries.length === 0 || Math.abs(allocationSum - 1) > 0.01);
    return [
      ...invalidEntries,
      ...(sumInvalid
        ? [`${bucketName}.allocation_sum=${round(allocationSum * 100)}%`]
        : []),
    ];
  });
  pushCore(
    'accounts.target_allocation_totals',
    'Account target allocation totals',
    invalidAllocations.length === 0,
    invalidAllocations.length === 0
      ? 'Each funded account has finite, non-negative target allocations that sum to approximately 100%.'
      : `Invalid target allocations: ${formatInvalidList(invalidAllocations)}.`,
  );

  const robAge = ageAtReferenceDate(input.data.household.robBirthDate);
  const debbieAge = ageAtReferenceDate(input.data.household.debbieBirthDate);
  const invalidHorizonFields = [
    !isFiniteNumber(input.assumptions.robPlanningEndAge) ||
    (robAge !== null && input.assumptions.robPlanningEndAge < robAge)
      ? 'assumptions.robPlanningEndAge'
      : null,
    !isFiniteNumber(input.assumptions.debbiePlanningEndAge) ||
    (debbieAge !== null && input.assumptions.debbiePlanningEndAge < debbieAge)
      ? 'assumptions.debbiePlanningEndAge'
      : null,
    !isFiniteNumber(input.assumptions.travelPhaseYears) ||
    input.assumptions.travelPhaseYears < 0
      ? 'assumptions.travelPhaseYears'
      : null,
    input.assumptions.travelFlatYears !== undefined &&
    (!isFiniteNumber(input.assumptions.travelFlatYears) || input.assumptions.travelFlatYears < 0)
      ? 'assumptions.travelFlatYears'
      : null,
  ].filter((field): field is string => field !== null);
  pushCore(
    'assumptions.planning_horizon',
    'Planning horizon',
    invalidHorizonFields.length === 0,
    invalidHorizonFields.length === 0
      ? 'Planning end ages and travel-phase durations are explicit, finite, and forward-looking.'
      : `Invalid horizon inputs: ${formatInvalidList(invalidHorizonFields)}.`,
  );

  const finiteMarketFields: Array<[string, number]> = [
    ['assumptions.equityMean', input.assumptions.equityMean],
    ['assumptions.internationalEquityMean', input.assumptions.internationalEquityMean],
    ['assumptions.bondMean', input.assumptions.bondMean],
    ['assumptions.cashMean', input.assumptions.cashMean],
    ['assumptions.inflation', input.assumptions.inflation],
  ];
  const volatilityFields: Array<[string, number]> = [
    ['assumptions.equityVolatility', input.assumptions.equityVolatility],
    ['assumptions.internationalEquityVolatility', input.assumptions.internationalEquityVolatility],
    ['assumptions.bondVolatility', input.assumptions.bondVolatility],
    ['assumptions.cashVolatility', input.assumptions.cashVolatility],
    ['assumptions.inflationVolatility', input.assumptions.inflationVolatility],
  ];
  const invalidMarketFields = [
    ...finiteMarketFields
      .filter(([, value]) => !isFiniteNumber(value))
      .map(([field]) => field),
    ...volatilityFields
      .filter(([, value]) => !isFiniteNumber(value) || value < 0)
      .map(([field]) => field),
  ];
  pushCore(
    'assumptions.market_parameters',
    'Market and inflation parameters',
    invalidMarketFields.length === 0,
    invalidMarketFields.length === 0
      ? 'Return, volatility, and inflation assumptions are finite; volatility assumptions are non-negative.'
      : `Invalid market assumptions: ${formatInvalidList(invalidMarketFields)}.`,
  );

  const invalidGuardrailFields = [
    !isFiniteNumber(input.assumptions.irmaaThreshold) || input.assumptions.irmaaThreshold <= 0
      ? 'assumptions.irmaaThreshold'
      : null,
    !isFiniteNumber(input.assumptions.guardrailFloorYears) ||
    input.assumptions.guardrailFloorYears < 0
      ? 'assumptions.guardrailFloorYears'
      : null,
    !isFiniteNumber(input.assumptions.guardrailCeilingYears) ||
    input.assumptions.guardrailCeilingYears < input.assumptions.guardrailFloorYears
      ? 'assumptions.guardrailCeilingYears'
      : null,
    !isFiniteNumber(input.assumptions.guardrailCutPercent) ||
    input.assumptions.guardrailCutPercent < 0 ||
    input.assumptions.guardrailCutPercent > 1
      ? 'assumptions.guardrailCutPercent'
      : null,
  ].filter((field): field is string => field !== null);
  pushCore(
    'assumptions.guardrail_parameters',
    'Guardrail and tax-threshold parameters',
    invalidGuardrailFields.length === 0,
    invalidGuardrailFields.length === 0
      ? 'Guardrail and IRMAA threshold parameters are finite and internally ordered.'
      : `Invalid guardrail/tax-threshold inputs: ${formatInvalidList(invalidGuardrailFields)}.`,
  );

  return checks;
}

function buildSpecificReliabilityChecks(input: BuildModelFidelityInput): ModelFidelityInput[] {
  const checks: ModelFidelityInput[] = [];
  const allocations = [
    input.data.accounts.pretax.targetAllocation,
    input.data.accounts.roth.targetAllocation,
    input.data.accounts.taxable.targetAllocation,
    input.data.accounts.cash.targetAllocation,
    input.data.accounts.hsa?.targetAllocation ?? {},
  ];
  const mappingMetadata = getAssetClassMappingMetadata(
    allocations,
    input.data.rules.assetClassMappingAssumptions,
  );
  const ambiguousMappings = mappingMetadata.ambiguousAssumptionsUsed.map((item) => item.symbol);
  const ambiguousMappedExplicitly = ambiguousMappings.every((symbol) => {
    if (symbol === 'TRP_2030') {
      return Boolean(input.data.rules.assetClassMappingAssumptions?.TRP_2030);
    }
    return Boolean(input.data.rules.assetClassMappingAssumptions?.CENTRAL_MANAGED);
  });
  const ambiguousMappedFromExactEvidence = ambiguousMappings.every((symbol) => {
    if (symbol === 'TRP_2030') {
      return input.data.rules.assetClassMappingEvidence?.TRP_2030 === 'exact_lookthrough';
    }
    return input.data.rules.assetClassMappingEvidence?.CENTRAL_MANAGED === 'exact_lookthrough';
  });
  const explicitRmdStartAge = input.data.rules.rmdPolicy?.startAgeOverride;
  const explicitPayrollTakeHomeFactor = input.data.rules.payrollModel?.takeHomeFactor;
  const explicitPayrollProrationRule = input.data.rules.payrollModel?.salaryProrationRule;
  const symbolShare = (bucket: SeedData['accounts'][keyof SeedData['accounts']], symbol: string) => {
    if (!bucket) {
      return 0;
    }
    const normalized = symbol.toUpperCase();
    const sourceAccounts = bucket?.sourceAccounts ?? [];
    const sourceHoldingsValue = sourceAccounts.reduce(
      (total, account) =>
        total +
        (account.holdings ?? [])
          .filter((holding) => holding.symbol.toUpperCase() === normalized)
          .reduce((sum, holding) => sum + Math.max(0, holding.value), 0),
      0,
    );
    if (sourceHoldingsValue > 0 && bucket.balance > 0) {
      return sourceHoldingsValue / bucket.balance;
    }
    return bucket?.targetAllocation?.[normalized] ?? 0;
  };
  const schdTotalShare = [
    input.data.accounts.pretax,
    input.data.accounts.roth,
    input.data.accounts.taxable,
    input.data.accounts.hsa,
  ].reduce((total, bucket) => total + (bucket ? symbolShare(bucket, 'SCHD') : 0), 0);
  const fcntxRothShare = symbolShare(input.data.accounts.roth, 'FCNTX');
  const mubTaxableShare = symbolShare(input.data.accounts.taxable, 'MUB');

	  checks.push({
	    id: 'inferred_rmd_start_timing',
    label: 'RMD start timing',
    status: typeof explicitRmdStartAge === 'number' ? 'exact' : 'inferred',
    reliabilityImpact: 'medium',
    blocking: false,
    detail: typeof explicitRmdStartAge === 'number'
      ? `RMD start age explicitly provided (${Math.floor(explicitRmdStartAge)}).`
      : 'RMD start timing is inferred from birth-year legislation rules; no explicit user-provided override exists.',
	  });

	  const pretaxSourceAccounts = input.data.accounts.pretax.sourceAccounts ?? [];
	  const missingPretaxOwners = pretaxSourceAccounts.filter(
	    (account) => !account.owner || !account.owner.trim(),
	  );
	  checks.push({
	    id: 'pretax_rmd_account_ownership',
	    label: 'Pre-tax account RMD ownership',
	    status:
	      pretaxSourceAccounts.length > 0 && missingPretaxOwners.length === 0
	        ? 'exact'
	        : 'inferred',
	    reliabilityImpact: 'high',
	    blocking: false,
	    detail:
	      pretaxSourceAccounts.length > 0 && missingPretaxOwners.length === 0
	        ? 'Each pre-tax source account has explicit owner metadata for RMD divisor selection.'
	        : 'One or more pre-tax source accounts are missing owner metadata, so RMD ownership would be inferred.',
	  });

	  checks.push({
    id: 'opaque_holdings_mapping',
    label: 'Opaque holdings asset mapping',
    status: ambiguousMappings.length === 0
      ? 'exact'
      : ambiguousMappedExplicitly && ambiguousMappedFromExactEvidence
        ? 'exact'
        : ambiguousMappedExplicitly
          ? 'estimated'
        : 'inferred',
    reliabilityImpact: ambiguousMappings.length === 0 || ambiguousMappedFromExactEvidence
      ? 'low'
      : 'high',
    blocking: false,
    detail: ambiguousMappings.length
      ? ambiguousMappedFromExactEvidence
        ? `Ambiguous holdings (${ambiguousMappings.join(', ')}) are mapped with explicit look-through evidence.`
        : `Ambiguous holdings (${ambiguousMappings.join(', ')}) require proxy asset-class mapping assumptions.`
      : 'No ambiguous holdings mappings detected.',
  });

  checks.push({
    id: 'payroll_take_home_estimate',
    label: 'Payroll take-home estimate',
    status: typeof explicitPayrollTakeHomeFactor === 'number' ? 'exact' : 'inferred',
    reliabilityImpact: 'medium',
    blocking: false,
    detail: typeof explicitPayrollTakeHomeFactor === 'number'
      ? `Payroll take-home factor explicitly provided (${round(
        explicitPayrollTakeHomeFactor * 100,
      )}%).`
      : 'Runway payroll bridge guidance uses an inferred take-home factor (72%) rather than household-specific paycheck net modeling.',
  });

  checks.push({
    id: 'payroll_timing_proration_assumptions',
    label: 'Payroll timing and proration assumptions',
    status: explicitPayrollProrationRule ? 'exact' : 'estimated',
    reliabilityImpact: 'medium',
    blocking: false,
    detail: explicitPayrollProrationRule
      ? `Payroll proration rule explicitly provided (${explicitPayrollProrationRule}).`
      : 'Payroll effects rely on monthly proration and retirement-date timing assumptions rather than paycheck-level calendars.',
  });

  const recommendationTrustRisks = [
    schdTotalShare > 0
      ? `SCHD exposure is mapped to broad equity returns; dividend/factor concentration is not separately priced in the headline simulation.`
      : null,
    fcntxRothShare > 0.25
      ? `FCNTX is ${round(fcntxRothShare * 100)}% of Roth exposure; manager/style concentration affects recommendation trust, not the Monte Carlo success-rate math.`
      : null,
    mubTaxableShare > 0
      ? `MUB in taxable is treated through broad bond/taxable-account mechanics; state/AMT/after-tax muni nuances are recommendation-trust risks.`
      : null,
    ambiguousMappings.includes('TRP_2030')
      ? 'TRP_2030 is modeled through asset-class look-through/proxy mapping; fund-manager glidepath risk is not separately priced.'
      : null,
    ambiguousMappings.includes('CENTRAL_MANAGED')
      ? 'CENTRAL_MANAGED is modeled through asset-class look-through/proxy mapping; manager/security-selection risk is not separately priced.'
      : null,
  ].filter((item): item is string => item !== null);
  checks.push({
    id: 'recommendation_trust_risk_classification',
    label: 'Recommendation trust risk classification',
    status: recommendationTrustRisks.length > 0 ? 'estimated' : 'exact',
    reliabilityImpact: recommendationTrustRisks.length > 0 ? 'medium' : 'low',
    blocking: false,
    detail: recommendationTrustRisks.length > 0
      ? `Headline math uses broad asset-class mappings; these risks are surfaced for recommendation trust rather than treated as priced Monte Carlo factors: ${recommendationTrustRisks.join(' ')}`
      : 'No concentration, opaque-manager, or tax-location recommendation-trust risks detected.',
  });

  const inheritance = input.data.income.windfalls.find((item) => item.name === 'inheritance');
  const materialCashIns = input.data.income.windfalls.filter((item) => item.amount > 0);
  const windfallDeployment = input.data.rules.windfallDeploymentPolicy;
  checks.push({
    id: 'windfall_cash_destination_policy',
    label: 'Cash-in destination policy',
    status: materialCashIns.length === 0
      ? 'exact'
      : windfallDeployment?.assumptionSource &&
          windfallDeployment.enabled !== false &&
          windfallDeployment.destinationAccount &&
          windfallDeployment.investmentPolicy
        ? 'exact'
        : 'inferred',
    reliabilityImpact: materialCashIns.length > 0 ? 'high' : 'low',
    blocking: false,
    detail: materialCashIns.length === 0
      ? 'No material windfall or house-sale cash-in events included in the base plan.'
      : windfallDeployment?.assumptionSource
        ? `Cash-in deployment is explicit: unspent proceeds go to a ${windfallDeployment.trackingMode ?? 'taxable_shadow_sleeve'} in ${windfallDeployment.destinationAccount ?? 'taxable'} using ${windfallDeployment.investmentPolicy ?? 'current_portfolio_mix'} (${windfallDeployment.assumptionSource}).`
        : 'Material windfall or house-sale cash-in events exist, but destination and investment policy are inferred from engine defaults rather than an explicit household rule.',
  });

  checks.push({
    id: 'uncertain_inheritance',
    label: 'Inheritance certainty',
    status: !inheritance
      ? 'exact'
      : inheritance.amount > 0
        ? inheritance.certainty === 'certain'
          ? 'exact'
          : inheritance.certainty === 'estimated' || inheritance.certainty === 'uncertain'
            ? 'estimated'
            : inheritance.taxTreatment
              ? 'estimated'
              : 'inferred'
        : 'exact',
    reliabilityImpact: inheritance?.amount ? 'high' : 'low',
    blocking: false,
    detail: !inheritance
      ? 'No inheritance event included in the base plan.'
      : inheritance.certainty
        ? `Inheritance certainty explicitly marked as "${inheritance.certainty}".`
        : 'Inheritance timing and realizable amount remain uncertain even with explicit tax treatment.',
  });

  const homeSale = input.data.income.windfalls.find((item) => item.name === 'home_sale');
  const homeSaleLiquidityModeled =
    typeof homeSale?.liquidityAmount === 'number' ||
    typeof homeSale?.replacementHomeCost === 'number';
  const homeSaleFullyModeled =
    homeSale &&
    homeSale.taxTreatment === 'primary_home_sale' &&
    typeof homeSale.costBasis === 'number' &&
    homeSaleLiquidityModeled &&
    typeof homeSale.sellingCostPercent === 'number' &&
    typeof homeSale.exclusionAmount === 'number';
  checks.push({
    id: 'simplified_home_sale_assumptions',
    label: 'Home-sale proceeds realism',
    status: !homeSale
      ? 'exact'
      : homeSaleFullyModeled
        ? homeSale.certainty === 'estimated' || homeSale.certainty === 'uncertain'
          ? 'estimated'
          : 'exact'
        : homeSale.taxTreatment
          ? 'estimated'
          : 'inferred',
    reliabilityImpact: homeSale ? 'medium' : 'low',
    blocking: false,
    detail: !homeSale
      ? 'No home sale event included in the base plan.'
      : homeSaleFullyModeled
        ? homeSale.certainty === 'estimated' || homeSale.certainty === 'uncertain'
          ? 'Home downsizing is explicitly modeled, but sale amount/timing/replacement home are marked as estimates.'
          : 'Home sale includes tax treatment, basis, and net liquidity/downsize assumptions.'
        : 'Home sale is modeled with simplified net-proceeds assumptions (basis, replacement home, and/or explicit liquidity missing).',
  });

  return checks;
}

function computeModelFidelityFromInputs(
  checks: ModelFidelityInput[],
): ModelFidelityAssessment {
  const weightedTotal = checks.reduce(
    (sum, item) => sum + weightForImpact(item.reliabilityImpact),
    0,
  );
  const weightedScore = checks.reduce(
    (sum, item) =>
      sum +
      weightedScoreForStatus(item.status) * weightForImpact(item.reliabilityImpact),
    0,
  );
  const score = weightedTotal > 0 ? (weightedScore / weightedTotal) * 100 : 0;
  const blockingAssumptions = checks
    .filter((item) => item.blocking || item.status === 'missing')
    .map((item) => item.id);
  const softAssumptions = checks
    .filter((item) => item.status === 'estimated' || item.status === 'inferred')
    .map((item) => item.id);
  const modelCompleteness: ModelFidelityAssessment['modelCompleteness'] =
    softAssumptions.length > 0 || blockingAssumptions.length > 0 ? 'reconstructed' : 'faithful';
  const normalizedScore = round(score);
  const assessmentGrade = toAssessmentGrade({
    score: normalizedScore,
    blockingCount: blockingAssumptions.length,
    softCount: softAssumptions.length,
  });

  return {
    score: normalizedScore,
    modelFidelityScore: normalizedScore,
    modelCompleteness,
    assessmentGrade,
    blockingAssumptions,
    softAssumptions,
    effectOnReliability: summarizeEffectOnReliability(score, blockingAssumptions.length),
    inputs: checks,
  };
}

function slugifyAssumption(value: string) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized.length > 0 ? normalized : 'assumption';
}

export function reconcileModelFidelityAssessmentWithAdditionalAssumptions(input: {
  baseAssessment: ModelFidelityAssessment;
  inferredAssumptions: string[];
}): ModelFidelityAssessment {
  const normalizedAssumptions = Array.from(
    new Set(
      input.inferredAssumptions
        .map((assumption) => assumption.trim())
        .filter((assumption) => assumption.length > 0),
    ),
  );
  if (normalizedAssumptions.length === 0) {
    return input.baseAssessment;
  }

  const existingDetails = new Set(
    input.baseAssessment.inputs.map((item) => item.detail.trim()),
  );
  const additionalInputs: ModelFidelityInput[] = normalizedAssumptions
    .filter((assumption) => !existingDetails.has(assumption))
    .map((assumption, index) => ({
      id: `playbook_inferred_assumption_${index + 1}_${slugifyAssumption(assumption)}`,
      label: 'Playbook projection assumption',
      status: 'inferred',
      reliabilityImpact: 'medium',
      blocking: false,
      detail: assumption,
    }));

  if (additionalInputs.length === 0) {
    return input.baseAssessment;
  }

  const reconciled = computeModelFidelityFromInputs([
    ...input.baseAssessment.inputs,
    ...additionalInputs,
  ]);

  if (
    reconciled.modelCompleteness === 'reconstructed' &&
    reconciled.assessmentGrade === 'decision_grade'
  ) {
    return {
      ...reconciled,
      assessmentGrade: 'planning_grade',
    };
  }

  return reconciled;
}

export function buildModelFidelityAssessment(
  input: BuildModelFidelityInput,
): ModelFidelityAssessment {
  const checks = [...buildCoreInputChecks(input), ...buildSpecificReliabilityChecks(input)];
  return computeModelFidelityFromInputs(checks);
}
