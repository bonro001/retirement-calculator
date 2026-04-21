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

function isValidDate(value: string) {
  return !Number.isNaN(new Date(value).getTime());
}

function round(value: number) {
  return Number(value.toFixed(2));
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

  const inheritance = input.data.income.windfalls.find((item) => item.name === 'inheritance');
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
  const homeSaleFullyModeled =
    homeSale &&
    homeSale.taxTreatment === 'primary_home_sale' &&
    typeof homeSale.costBasis === 'number' &&
    typeof homeSale.liquidityAmount === 'number' &&
    typeof homeSale.sellingCostPercent === 'number' &&
    typeof homeSale.exclusionAmount === 'number';
  checks.push({
    id: 'simplified_home_sale_assumptions',
    label: 'Home-sale proceeds realism',
    status: !homeSale
      ? 'exact'
      : homeSaleFullyModeled
        ? 'exact'
        : homeSale.taxTreatment
          ? 'estimated'
          : 'inferred',
    reliabilityImpact: homeSale ? 'medium' : 'low',
    blocking: false,
    detail: !homeSale
      ? 'No home sale event included in the base plan.'
      : homeSaleFullyModeled
        ? 'Home sale includes tax treatment, basis, and net liquidity assumptions.'
        : 'Home sale is modeled with simplified net-proceeds assumptions (basis and/or explicit liquidity missing).',
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
