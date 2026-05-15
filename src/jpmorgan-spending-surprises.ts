import type { MarketAssumptions, SeedData } from './types';
import {
  calculateCurrentAges,
  getAnnualSpendingTargets,
  getRetirementHorizonYears,
} from './utils';

export const JPMORGAN_SPENDING_SOURCE_VERSION =
  'jpmorgan-2026-guide-plus-blanchett-smile-2025-spending-surprises' as const;
export const JPMORGAN_SPENDING_CURVE_SOURCE_VERSION =
  'jpmorgan-2026-guide-to-retirement-changes-in-spending' as const;
export const BLANCHETT_SPENDING_SMILE_SOURCE_VERSION =
  'blanchett-2014-retirement-spending-smile' as const;
export const JPMORGAN_DEFAULT_CURVE_START_AGE = 65;
export const JPMORGAN_CURVE_ANCHOR_SOURCE_AGE = 65;
export const JPMORGAN_SPENDING_SMILE_TAIL_START_AGE = 90;
export const BLANCHETT_SPENDING_SMILE_DEFAULT_TARGET_ANNUAL = 100_000;
export const JPMORGAN_DEFAULT_NON_HEALTHCARE_INFLATION_GAP = 0.01;
export const JPMORGAN_DEFAULT_SURGE_PERCENT = 0.3;
export const JPMORGAN_DEFAULT_SURGE_YEARS = 3;
export const JPMORGAN_DEFAULT_VOLATILITY_PERCENT = 0.2;
export const JPMORGAN_DEFAULT_VOLATILITY_YEARS = 2;
export const MAGIC_AVERAGE_BLEND_WEIGHT = 0.5;

export const JPMORGAN_SPENDING_SOURCE = {
  title:
    'J.P. Morgan Asset Management, Guide to Retirement 2026 and Three new spending surprises 2025',
  version: JPMORGAN_SPENDING_SOURCE_VERSION,
  url: 'https://am.jpmorgan.com/content/dam/jpm-am-aem/global/en/insights/retirement-insights/guide-to-retirement-us.pdf',
  secondaryUrl:
    'https://am.jpmorgan.com/content/dam/jpm-am-aem/americas/us/en/insights/retirement-insights/RI-3-SPEND.pdf',
  localPath: 'docs/research/jpmorgan-three-new-spending-surprises-2025.pdf',
} as const;

export const BLANCHETT_SPENDING_SMILE_SOURCE = {
  title:
    'David Blanchett, Exploring the Retirement Consumption Puzzle, Journal of Financial Planning, May 2014',
  version: BLANCHETT_SPENDING_SMILE_SOURCE_VERSION,
  url: 'https://www.financialplanningassociation.org/sites/default/files/2020-05/1%20Exploring%20the%20Retirement%20Consumption%20Puzzle.pdf',
} as const;

export const JPMORGAN_SPENDING_CURVE_POINTS = [
  { age: 60, annualSpend: 77_060 },
  { age: 65, annualSpend: 70_900 },
  { age: 70, annualSpend: 67_640 },
  { age: 75, annualSpend: 62_460 },
  { age: 80, annualSpend: 57_650 },
  { age: 85, annualSpend: 55_000 },
  { age: 90, annualSpend: 54_000 },
  { age: 95, annualSpend: 53_980 },
] as const;

export type SpendingModelPresetId =
  | 'current_faithful'
  | 'magic_average'
  | 'jpmorgan_curve_travel_included'
  | 'jpmorgan_curve_extra_travel_overlay'
  | 'jpmorgan_curve_early_surge'
  | 'jpmorgan_curve_early_volatility'
  | 'jpmorgan_curve_age75_volatility';

export type TravelTreatment =
  | 'current_explicit_overlay'
  | 'included_in_jpmorgan_curve'
  | 'extra_overlay_above_curve';

export type SpendingModelSimulationMode =
  | 'forward_parametric'
  | 'historical_precedent';

export const SPENDING_MODEL_SIMULATION_MODES: SpendingModelSimulationMode[] = [
  'forward_parametric',
  'historical_precedent',
];

export type HouseholdAgeBasis =
  | 'average_adult'
  | 'older_adult'
  | 'younger_adult'
  | 'rob'
  | 'debbie';

export type AssumptionSourceKind =
  | 'user'
  | 'seed'
  | 'default'
  | 'inferred'
  | 'source_research';

export interface AssumptionSource {
  source: AssumptionSourceKind;
  explanation: string;
  evidence?: string;
}

export interface HouseholdSpendingModifiers {
  travelTreatment: TravelTreatment;
  householdAgeBasis: HouseholdAgeBasis;
  curveStartAge: number;
  preCurveSpendingBehavior: 'source_age_curve' | 'current_real_baseline';
  extraTravelOverlayAnnual?: number;
  extraTravelOverlayYears?: number;
  protectHousingFixedCosts: boolean;
  keepHealthcareSeparate: boolean;
  partialRetirementTransition: boolean;
}

export type SpendingModelAssumptionKey =
  | keyof HouseholdSpendingModifiers
  | 'nonHealthcareInflationGap'
  | 'preset'
  | 'spendingCurveControlPoints'
  | 'spendingSmileEquation'
  | 'extraTravelOverlay'
  | 'magicAverageBlend'
  | 'transitionSurge'
  | 'temporarySpendingShock';

export type SpendingModelAssumptionSources = Partial<
  Record<SpendingModelAssumptionKey, AssumptionSource>
>;

export type SpendingModelAdjustment =
  | {
      kind: 'extra_travel_overlay';
      annualAmount: number;
      years: number;
    }
  | {
      kind: 'transition_surge';
      percent: number;
      years: number;
      start: 'retirement';
      enabledBecause: 'user_selected' | 'partial_retirement_transition';
    }
  | {
      kind: 'temporary_spending_shock';
      shockId: 'early_volatility' | 'age75_volatility';
      percent: number;
      years: number;
      start: 'retirement' | 'age75';
    };

export interface SpendingModelPresetDefinition {
  id: SpendingModelPresetId;
  label: string;
  travelTreatment: TravelTreatment;
  adjustments: SpendingModelAdjustment[];
  defaultSelected: boolean;
}

export type SpendingModelCompleteness = 'faithful' | 'reconstructed';

export interface SpendingModelWarning {
  code:
    | 'travel_double_count'
    | 'extra_travel_missing'
    | 'blend_source_missing'
    | 'surge_not_applicable'
    | 'mode_failed'
    | 'stale_source';
  severity: 'info' | 'warning' | 'blocking';
  message: string;
  relatedFields: string[];
}

export interface SpendingModelScheduleYear {
  year: number;
  householdAge: number;
  inTravelPhase: boolean;
  currentPlanBaselineAnnualSpend: number;
  modelBaselineAnnualSpend: number;
  jpmorganCurveAnnualSpend: number;
  finalAnnualSpend: number;
  curveMultiplier: number;
  protectedFixedCosts: number;
  curveSubjectAnnual: number;
  travelOverlay: number;
  surgeAdjustment: number;
  volatilityAdjustment: number;
}

export interface SpendingModelScheduleResult {
  id: SpendingModelPresetId;
  label: string;
  status: 'complete' | 'skipped';
  modelCompleteness: SpendingModelCompleteness;
  inferredAssumptions: string[];
  assumptionSources: SpendingModelAssumptionSources;
  warnings: SpendingModelWarning[];
  provenance: {
    sourceVersion: typeof JPMORGAN_SPENDING_SOURCE_VERSION;
    curveSourceVersion: typeof JPMORGAN_SPENDING_CURVE_SOURCE_VERSION;
    smileSourceVersion: typeof BLANCHETT_SPENDING_SMILE_SOURCE_VERSION;
    sourceUrl: string;
    secondarySourceUrl: string;
    smileSourceUrl: string;
    localSourcePath: string;
    assumptionsVersion: string;
    simulationSeed: number;
    currency: 'USD';
    valueBasis: 'today_dollars';
  };
  modifiers: HouseholdSpendingModifiers;
  preset: SpendingModelPresetDefinition;
  annualSpendScheduleByYear: Record<number, number>;
  yearlySchedule: SpendingModelScheduleYear[];
  intermediateCalculations: {
    startYear: number;
    retirementYear: number;
    planningEndYear: number;
    householdAgeBasis: HouseholdAgeBasis;
    curveStartAge: number;
    inflationAssumption: number;
    nonHealthcareInflationGap: number;
    realCurveRatioAnnual: number;
    jpmorganCurveSourceAnnualSpendByAge: Record<number, number>;
    blanchettSmileProjectedAnnualSpendByAge: Record<number, number>;
    blanchettSmileAnnualRealChangeByAge: Record<number, number>;
    firstRetirementYearAnnualSpend: number | null;
    age80AnnualSpend: number | null;
    age95AnnualSpend: number | null;
    magicAverageCurrentFaithfulWeight?: number;
    magicAverageJpmorganWeight?: number;
    magicAverageSourcePresetIds?: SpendingModelPresetId[];
	  };
	}

export interface BuildSpendingModelScheduleOptions {
  presetId?: SpendingModelPresetId;
  modifiers?: Partial<HouseholdSpendingModifiers>;
  startYear?: number;
  nonHealthcareInflationGap?: number;
}

const DEFAULT_START_YEAR = 2026;

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function hasOwn<T extends object>(value: T, key: PropertyKey) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function jpmorganAge65AnchorSpend() {
  return (
    JPMORGAN_SPENDING_CURVE_POINTS.find(
      (point) => point.age === JPMORGAN_CURVE_ANCHOR_SOURCE_AGE,
    )?.annualSpend ?? JPMORGAN_SPENDING_CURVE_POINTS[0].annualSpend
  );
}

export function blanchettAnnualRealSpendingChangeForAge(
  age: number,
  annualSpendTarget = BLANCHETT_SPENDING_SMILE_DEFAULT_TARGET_ANNUAL,
) {
  const spendTarget = Math.max(1, annualSpendTarget);
  return (
    0.000_08 * age * age -
    0.012_5 * age -
    0.006_6 * Math.log(spendTarget) +
    0.546
  );
}

function applyBlanchettSmileTail(startSpend: number, startAge: number, endAge: number) {
  if (endAge <= startAge) {
    return startSpend;
  }

  let annualSpend = startSpend;
  let age = startAge;
  while (age < endAge - 0.000_001) {
    const stepYears = Math.min(1, endAge - age);
    const annualChange = blanchettAnnualRealSpendingChangeForAge(age);
    annualSpend *= Math.pow(Math.max(0, 1 + annualChange), stepYears);
    age += stepYears;
  }
  return annualSpend;
}

function jpmorganCurveSourceSpendForAge(sourceAge: number) {
  const points = JPMORGAN_SPENDING_CURVE_POINTS;
  const smileTailStartPoint = points.find(
    (point) => point.age === JPMORGAN_SPENDING_SMILE_TAIL_START_AGE,
  );
  if (sourceAge <= points[0].age) {
    return points[0].annualSpend;
  }
  if (smileTailStartPoint && sourceAge > smileTailStartPoint.age) {
    return applyBlanchettSmileTail(
      smileTailStartPoint.annualSpend,
      smileTailStartPoint.age,
      sourceAge,
    );
  }
  const lastPoint = points[points.length - 1];
  if (sourceAge > lastPoint.age) {
    return applyBlanchettSmileTail(
      lastPoint.annualSpend,
      lastPoint.age,
      sourceAge,
    );
  }
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const next = points[index];
    if (sourceAge <= next.age) {
      const span = next.age - previous.age;
      const progress = span > 0 ? (sourceAge - previous.age) / span : 0;
      return previous.annualSpend + (next.annualSpend - previous.annualSpend) * progress;
    }
  }
  return lastPoint.annualSpend;
}

function jpmorganSourceCurveMultiplierForAge(sourceAge: number) {
  const anchorSpend = jpmorganAge65AnchorSpend();
  return jpmorganCurveSourceSpendForAge(sourceAge) / anchorSpend;
}

function jpmorganCurveSourceAnnualSpendByAge() {
  return Object.fromEntries(
    JPMORGAN_SPENDING_CURVE_POINTS.map((point) => [point.age, point.annualSpend]),
  );
}

function blanchettSmileProjectedAnnualSpendByAge() {
  return Object.fromEntries(
    [90, 91, 92, 93, 94, 95, 96, 100].map((age) => [
      age,
      roundMoney(jpmorganCurveSourceSpendForAge(age)),
    ]),
  );
}

function blanchettSmileAnnualRealChangeByAge() {
  return Object.fromEntries(
    [90, 95, 100].map((age) => [
      age,
      Math.round(blanchettAnnualRealSpendingChangeForAge(age) * 10_000) / 10_000,
    ]),
  );
}

function resolveRetirementYear(data: SeedData) {
  const isoYear = /^(\d{4})-\d{2}-\d{2}/.exec(data.income.salaryEndDate)?.[1];
  if (isoYear) {
    return Number(isoYear);
  }
  const parsed = new Date(data.income.salaryEndDate);
  if (Number.isNaN(parsed.getTime())) {
    return DEFAULT_START_YEAR;
  }
  return parsed.getFullYear();
}

function resolveHouseholdAge(data: SeedData, basis: HouseholdAgeBasis) {
  const ages = calculateCurrentAges(data);
  switch (basis) {
    case 'rob':
      return ages.rob;
    case 'debbie':
      return ages.debbie;
    case 'older_adult':
      return Math.max(ages.rob, ages.debbie);
    case 'younger_adult':
      return Math.min(ages.rob, ages.debbie);
    case 'average_adult':
    default:
      return (ages.rob + ages.debbie) / 2;
  }
}

export function curveMultiplierForAge(input: {
  householdAge: number;
  curveStartAge?: number;
  inflation: number;
  nonHealthcareInflationGap?: number;
  preCurveSpendingBehavior?: HouseholdSpendingModifiers['preCurveSpendingBehavior'];
}) {
  const curveStartAge = input.curveStartAge ?? JPMORGAN_DEFAULT_CURVE_START_AGE;
  const shouldClampPreCurve =
    input.preCurveSpendingBehavior === 'current_real_baseline' &&
    input.householdAge < curveStartAge;
  const effectiveHouseholdAge = shouldClampPreCurve
    ? curveStartAge
    : input.householdAge;
  const sourceAge =
    JPMORGAN_CURVE_ANCHOR_SOURCE_AGE + (effectiveHouseholdAge - curveStartAge);
  const yearsOnCurve = Math.max(0, sourceAge - JPMORGAN_CURVE_ANCHOR_SOURCE_AGE);
  const sourceCurveMultiplier = jpmorganSourceCurveMultiplierForAge(
    sourceAge,
  );
  const suppliedGap =
    input.nonHealthcareInflationGap ?? JPMORGAN_DEFAULT_NON_HEALTHCARE_INFLATION_GAP;
  const gapDelta = suppliedGap - JPMORGAN_DEFAULT_NON_HEALTHCARE_INFLATION_GAP;
  if (Math.abs(gapDelta) < 0.000_000_1) {
    return sourceCurveMultiplier;
  }
  const baseInflation = Math.max(-0.95, input.inflation);
  const defaultRetireeInflation = Math.max(
    -0.95,
    baseInflation - JPMORGAN_DEFAULT_NON_HEALTHCARE_INFLATION_GAP,
  );
  const suppliedRetireeInflation = Math.max(-0.95, baseInflation - suppliedGap);
  const ratio =
    (1 + suppliedRetireeInflation) / Math.max(0.05, 1 + defaultRetireeInflation);
  return sourceCurveMultiplier * Math.pow(Math.max(0, ratio), yearsOnCurve);
}

function findAnnualSpendAtOrAfterAge(
  yearly: SpendingModelScheduleYear[],
  age: number,
) {
  return (
    yearly.find((point) => point.householdAge >= age)?.finalAnnualSpend ?? null
  );
}

function ageStartYear(input: {
  startYear: number;
  startAge: number;
  targetAge: number;
}) {
  return input.startYear + Math.max(0, Math.ceil(input.targetAge - input.startAge));
}

export function resolveHouseholdSpendingModifiers(
  partial: Partial<HouseholdSpendingModifiers> = {},
) {
  const modifiers: HouseholdSpendingModifiers = {
    travelTreatment: partial.travelTreatment ?? 'included_in_jpmorgan_curve',
    householdAgeBasis: partial.householdAgeBasis ?? 'average_adult',
    curveStartAge: partial.curveStartAge ?? JPMORGAN_DEFAULT_CURVE_START_AGE,
    preCurveSpendingBehavior:
      partial.preCurveSpendingBehavior ?? 'source_age_curve',
    extraTravelOverlayAnnual: partial.extraTravelOverlayAnnual,
    extraTravelOverlayYears: partial.extraTravelOverlayYears,
    protectHousingFixedCosts: partial.protectHousingFixedCosts ?? true,
    keepHealthcareSeparate: partial.keepHealthcareSeparate ?? true,
    partialRetirementTransition: partial.partialRetirementTransition ?? false,
  };

  const assumptionSources: SpendingModelAssumptionSources = {
    travelTreatment: hasOwn(partial, 'travelTreatment')
      ? {
          source: 'user',
          explanation: 'Travel treatment was explicitly selected.',
        }
      : {
          source: 'default',
          explanation:
            'J.P. Morgan curve models treat normal go-go travel as included in the population curve by default.',
        },
    householdAgeBasis: hasOwn(partial, 'householdAgeBasis')
      ? {
          source: 'user',
          explanation: 'Household age basis was explicitly selected.',
        }
      : {
          source: 'default',
          explanation: 'Default age basis is the average of the two adults.',
        },
    curveStartAge: hasOwn(partial, 'curveStartAge')
      ? {
          source: 'user',
          explanation: 'J.P. Morgan curve start age was explicitly selected.',
        }
      : {
          source: 'source_research',
          explanation:
            'Default curve onset uses age 65, matching the retirement-spending cohort framing.',
          evidence: JPMORGAN_SPENDING_SOURCE.title,
        },
    preCurveSpendingBehavior: {
      source: hasOwn(partial, 'preCurveSpendingBehavior') ? 'user' : 'default',
      explanation:
        modifiers.preCurveSpendingBehavior === 'source_age_curve'
          ? 'Years before the age-65 anchor use the reported J.P. Morgan 60-64 spending bucket.'
          : 'Years before the curve start age keep the current real spending baseline.',
    },
    protectHousingFixedCosts: hasOwn(partial, 'protectHousingFixedCosts')
      ? {
          source: 'user',
          explanation: 'Fixed housing-cost treatment was explicitly selected.',
        }
      : {
          source: 'default',
          explanation:
            'Paid-off-home carrying costs stay explicit and do not fade with lifestyle spending.',
        },
    keepHealthcareSeparate: hasOwn(partial, 'keepHealthcareSeparate')
      ? {
          source: 'user',
          explanation: 'Healthcare treatment was explicitly selected.',
        }
      : {
          source: 'default',
          explanation:
            'Healthcare, Medicare, HSA, and LTC remain in dedicated engine models.',
        },
    partialRetirementTransition: hasOwn(partial, 'partialRetirementTransition')
      ? {
          source: 'user',
          explanation: 'Partial-retirement transition relevance was explicitly selected.',
        }
      : {
          source: 'default',
          explanation:
            'Early spending surge is not selected by default without explicit partial-retirement/income overlap.',
        },
  };

  if (hasOwn(partial, 'extraTravelOverlayAnnual')) {
    assumptionSources.extraTravelOverlayAnnual = {
      source: 'user',
      explanation: 'Extra travel overlay amount was explicitly supplied.',
    };
  }
  if (hasOwn(partial, 'extraTravelOverlayYears')) {
    assumptionSources.extraTravelOverlayYears = {
      source: 'user',
      explanation: 'Extra travel overlay duration was explicitly supplied.',
    };
  }

  return { modifiers, assumptionSources };
}

export function buildSpendingModelPresetDefinition(
  presetId: SpendingModelPresetId,
  modifiers: HouseholdSpendingModifiers,
): SpendingModelPresetDefinition {
  const extraTravelAnnual = Math.max(0, modifiers.extraTravelOverlayAnnual ?? 0);
  const extraTravelYears = Math.max(0, modifiers.extraTravelOverlayYears ?? 0);
  switch (presetId) {
    case 'current_faithful':
      return {
        id: presetId,
        label: 'Current Plan',
        travelTreatment: 'current_explicit_overlay',
        adjustments: [],
        defaultSelected: true,
      };
    case 'magic_average':
      return {
        id: presetId,
        label: 'Magic Average 50/50',
        travelTreatment: 'included_in_jpmorgan_curve',
        adjustments: [],
        defaultSelected: true,
      };
    case 'jpmorgan_curve_extra_travel_overlay':
      return {
        id: presetId,
        label: 'J.P. Morgan Curve + Extra Travel Overlay',
        travelTreatment: 'extra_overlay_above_curve',
        adjustments:
          extraTravelAnnual > 0 && extraTravelYears > 0
            ? [
                {
                  kind: 'extra_travel_overlay',
                  annualAmount: extraTravelAnnual,
                  years: extraTravelYears,
                },
              ]
            : [],
        defaultSelected: false,
      };
    case 'jpmorgan_curve_early_surge':
      return {
        id: presetId,
        label: 'J.P. Morgan Curve + Early Surge',
        travelTreatment: 'included_in_jpmorgan_curve',
        adjustments: [
          {
            kind: 'transition_surge',
            percent: JPMORGAN_DEFAULT_SURGE_PERCENT,
            years: JPMORGAN_DEFAULT_SURGE_YEARS,
            start: 'retirement',
            enabledBecause: modifiers.partialRetirementTransition
              ? 'partial_retirement_transition'
              : 'user_selected',
          },
        ],
        defaultSelected: modifiers.partialRetirementTransition,
      };
    case 'jpmorgan_curve_early_volatility':
      return {
        id: presetId,
        label: 'J.P. Morgan Curve + Early Volatility',
        travelTreatment: 'included_in_jpmorgan_curve',
        adjustments: [
          {
            kind: 'temporary_spending_shock',
            shockId: 'early_volatility',
            percent: JPMORGAN_DEFAULT_VOLATILITY_PERCENT,
            years: JPMORGAN_DEFAULT_VOLATILITY_YEARS,
            start: 'retirement',
          },
        ],
        defaultSelected: true,
      };
    case 'jpmorgan_curve_age75_volatility':
      return {
        id: presetId,
        label: 'J.P. Morgan Curve + Age-75 Volatility',
        travelTreatment: 'included_in_jpmorgan_curve',
        adjustments: [
          {
            kind: 'temporary_spending_shock',
            shockId: 'age75_volatility',
            percent: JPMORGAN_DEFAULT_VOLATILITY_PERCENT,
            years: JPMORGAN_DEFAULT_VOLATILITY_YEARS,
            start: 'age75',
          },
        ],
        defaultSelected: true,
      };
    case 'jpmorgan_curve_travel_included':
    default:
      return {
        id: 'jpmorgan_curve_travel_included',
        label: 'J.P. Morgan Curve, Travel Included',
        travelTreatment: 'included_in_jpmorgan_curve',
        adjustments: [],
        defaultSelected: true,
      };
  }
}

export function buildDefaultSpendingModelPresetDefinitions(
  modifiers: HouseholdSpendingModifiers = resolveHouseholdSpendingModifiers().modifiers,
) {
  const ids: SpendingModelPresetId[] = [
    'current_faithful',
    'jpmorgan_curve_travel_included',
    'magic_average',
    'jpmorgan_curve_extra_travel_overlay',
    'jpmorgan_curve_early_surge',
    'jpmorgan_curve_early_volatility',
    'jpmorgan_curve_age75_volatility',
  ];
  return ids.map((id) => buildSpendingModelPresetDefinition(id, modifiers));
}

function buildProvenance(assumptions: MarketAssumptions) {
  return {
    sourceVersion: JPMORGAN_SPENDING_SOURCE_VERSION,
    curveSourceVersion: JPMORGAN_SPENDING_CURVE_SOURCE_VERSION,
    smileSourceVersion: BLANCHETT_SPENDING_SMILE_SOURCE_VERSION,
    sourceUrl: JPMORGAN_SPENDING_SOURCE.url,
    secondarySourceUrl: JPMORGAN_SPENDING_SOURCE.secondaryUrl,
    smileSourceUrl: BLANCHETT_SPENDING_SMILE_SOURCE.url,
    localSourcePath: JPMORGAN_SPENDING_SOURCE.localPath,
    assumptionsVersion: assumptions.assumptionsVersion ?? 'unknown',
    simulationSeed: assumptions.simulationSeed ?? 20260416,
    currency: 'USD',
    valueBasis: 'today_dollars',
  } satisfies SpendingModelScheduleResult['provenance'];
}

function buildInferredAssumptions(input: {
  preset: SpendingModelPresetDefinition;
  partialModifiers: Partial<HouseholdSpendingModifiers>;
  modifiers: HouseholdSpendingModifiers;
  nonHealthcareInflationGapSupplied: boolean;
}) {
  if (input.preset.id === 'current_faithful') {
    return [];
  }
  const inferred = [
    'J.P. Morgan publishes aggregate household patterns, not a household-specific coefficient table; this schedule reconstructs the pattern as an explicit deterministic scenario.',
    'J.P. Morgan curve multipliers use Guide to Retirement age-bucket spending values normalized to the age-65 household spend anchor.',
    'The age-90+ smile tail uses Blanchett’s published spending-smile equation with a $100,000 target-spend curve.',
  ];
  if (input.preset.id === 'magic_average') {
    inferred.unshift(
      'Magic Average uses an explicit 50/50 blend of the Current Faithful annual spending path and the J.P. Morgan travel-included annual spending path.',
    );
  }
  if (!hasOwn(input.partialModifiers, 'householdAgeBasis')) {
    inferred.push('Household age basis defaults to average adult age.');
  }
  if (!hasOwn(input.partialModifiers, 'curveStartAge')) {
    inferred.push('The J.P. Morgan curve age-65 anchor defaults to household age 65.');
  }
  if (!hasOwn(input.partialModifiers, 'preCurveSpendingBehavior')) {
    inferred.push(
      'Pre-age-65 retirement years default to the reported J.P. Morgan 60-64 spending bucket instead of being clamped to the age-65 anchor.',
    );
  }
  if (!input.nonHealthcareInflationGapSupplied) {
    inferred.push(
      'Explicit non-healthcare spending inflation sensitivity defaults to the J.P. Morgan guidance that retiree spending inflation may run one percentage point below broad inflation.',
    );
  }
  if (!hasOwn(input.partialModifiers, 'protectHousingFixedCosts')) {
    inferred.push(
      'Annual taxes and insurance are kept flat in real terms because the seed isolates paid-off-home carrying costs from lifestyle spending.',
    );
  }
  if (input.preset.adjustments.some((item) => item.kind === 'transition_surge')) {
    inferred.push(
      'Early surge stress uses a deterministic +30% for three years and is modeled as a stress row, not a household default.',
    );
  }
  if (
    input.preset.adjustments.some(
      (item) => item.kind === 'temporary_spending_shock',
    )
  ) {
    inferred.push(
      'Temporary volatility stress uses a deterministic +20% shock for two years from J.P. Morgan volatility categories.',
    );
  }
  return inferred;
}

function buildPresetAssumptionSources(input: {
  preset: SpendingModelPresetDefinition;
  nonHealthcareInflationGapSupplied: boolean;
}) {
  const sources: SpendingModelAssumptionSources = {
    preset: {
      source: input.preset.id === 'current_faithful' ? 'seed' : 'user',
      explanation:
        input.preset.id === 'current_faithful'
          ? 'Current plan preset uses the existing seed spending behavior.'
          : input.preset.id === 'magic_average'
            ? 'Magic Average preset was explicitly selected as a 50/50 hedge between Current Faithful and J.P. Morgan travel-included spending.'
          : 'Spending model preset was explicitly selected for comparison.',
    },
  };

  if (input.preset.id === 'magic_average') {
    sources.magicAverageBlend = {
      source: 'user',
      explanation:
        'Blend weight is fixed at 50% Current Faithful and 50% J.P. Morgan travel-included for this run.',
    };
  }

  if (input.preset.id !== 'current_faithful') {
    sources.spendingCurveControlPoints = {
      source: 'source_research',
      explanation:
        'Default J.P. Morgan curve uses reported age-bucket spending values from age 60 through 95+, normalized to the household age-65 curve anchor.',
      evidence: JPMORGAN_SPENDING_SOURCE.title,
    };
    sources.spendingSmileEquation = {
      source: 'source_research',
      explanation:
        'A deterministic age-90+ smile tail is projected from the J.P. Morgan 90+ bucket using Blanchett’s published retirement-spending-smile equation.',
      evidence: BLANCHETT_SPENDING_SMILE_SOURCE.title,
    };
    sources.nonHealthcareInflationGap = input.nonHealthcareInflationGapSupplied
      ? {
          source: 'user',
          explanation:
            'Non-healthcare inflation gap was explicitly supplied for the J.P. Morgan curve.',
        }
      : {
          source: 'source_research',
          explanation:
            'Default sensitivity layer uses one-percentage-point lower retiree spending inflation when a custom curve gap is requested.',
          evidence: JPMORGAN_SPENDING_SOURCE.title,
        };
  }

  if (
    input.preset.adjustments.some((item) => item.kind === 'extra_travel_overlay')
  ) {
    sources.extraTravelOverlay = {
      source: 'user',
      explanation:
        'Extra travel overlay is included only when the user supplies amount and duration.',
    };
  }

  if (input.preset.adjustments.some((item) => item.kind === 'transition_surge')) {
    sources.transitionSurge = {
      source: 'source_research',
      explanation:
        'Early surge stress uses J.P. Morgan retirement-surge research as a deterministic stress row.',
      evidence: JPMORGAN_SPENDING_SOURCE.title,
    };
  }

  if (
    input.preset.adjustments.some(
      (item) => item.kind === 'temporary_spending_shock',
    )
  ) {
    sources.temporarySpendingShock = {
      source: 'source_research',
      explanation:
        'Temporary spending shock uses J.P. Morgan volatility categories as deterministic stress rows.',
      evidence: JPMORGAN_SPENDING_SOURCE.title,
    };
  }

  return sources;
}

function validatePreset(input: {
  preset: SpendingModelPresetDefinition;
  modifiers: HouseholdSpendingModifiers;
}) {
  const warnings: SpendingModelWarning[] = [];
  if (
    input.preset.id !== 'current_faithful' &&
    input.preset.travelTreatment === 'current_explicit_overlay'
  ) {
    warnings.push({
      code: 'travel_double_count',
      severity: 'blocking',
      message:
        'J.P. Morgan curve models cannot keep the current explicit travel overlay unless it is marked as extra travel.',
      relatedFields: ['travelTreatment', 'travelEarlyRetirementAnnual'],
    });
  }

  if (
    input.preset.id === 'jpmorgan_curve_extra_travel_overlay' &&
    !input.preset.adjustments.some((item) => item.kind === 'extra_travel_overlay')
  ) {
    warnings.push({
      code: 'extra_travel_missing',
      severity: 'blocking',
      message:
        'Extra travel overlay requires both an explicit annual amount and an explicit year count.',
      relatedFields: ['extraTravelOverlayAnnual', 'extraTravelOverlayYears'],
    });
  }

  if (
    input.preset.id === 'jpmorgan_curve_early_surge' &&
    !input.modifiers.partialRetirementTransition
  ) {
    warnings.push({
      code: 'surge_not_applicable',
      severity: 'info',
      message:
        'Early spending surge is being run as a selected stress row even though partial retirement/income overlap is not modeled.',
      relatedFields: ['partialRetirementTransition'],
    });
  }

  return warnings;
}

function emptySkippedResult(input: {
  preset: SpendingModelPresetDefinition;
  modifiers: HouseholdSpendingModifiers;
  assumptionSources: SpendingModelAssumptionSources;
  assumptions: MarketAssumptions;
  warnings: SpendingModelWarning[];
  startYear: number;
  retirementYear: number;
  planningEndYear: number;
}) {
  return {
    id: input.preset.id,
    label: input.preset.label,
    status: 'skipped',
    modelCompleteness:
      input.preset.id === 'current_faithful' ? 'faithful' : 'reconstructed',
    inferredAssumptions: [],
    assumptionSources: input.assumptionSources,
    warnings: input.warnings,
    provenance: buildProvenance(input.assumptions),
    modifiers: input.modifiers,
    preset: input.preset,
    annualSpendScheduleByYear: {},
    yearlySchedule: [],
    intermediateCalculations: {
      startYear: input.startYear,
      retirementYear: input.retirementYear,
      planningEndYear: input.planningEndYear,
      householdAgeBasis: input.modifiers.householdAgeBasis,
      curveStartAge: input.modifiers.curveStartAge,
      inflationAssumption: input.assumptions.inflation,
      nonHealthcareInflationGap: JPMORGAN_DEFAULT_NON_HEALTHCARE_INFLATION_GAP,
      realCurveRatioAnnual: 1,
      jpmorganCurveSourceAnnualSpendByAge: jpmorganCurveSourceAnnualSpendByAge(),
      blanchettSmileProjectedAnnualSpendByAge:
        blanchettSmileProjectedAnnualSpendByAge(),
      blanchettSmileAnnualRealChangeByAge: blanchettSmileAnnualRealChangeByAge(),
      firstRetirementYearAnnualSpend: null,
      age80AnnualSpend: null,
      age95AnnualSpend: null,
    },
  } satisfies SpendingModelScheduleResult;
}

function annualSpendAtOrAfterAge(
  yearly: SpendingModelScheduleYear[],
  age: number,
) {
  return yearly.find((point) => point.householdAge >= age)?.finalAnnualSpend ?? null;
}

function firstAnnualSpendAtOrAfterYear(
  yearly: SpendingModelScheduleYear[],
  year: number,
) {
  return yearly.find((point) => point.year >= year)?.finalAnnualSpend ?? null;
}

function buildMagicAverageSchedule(input: {
  data: SeedData;
  assumptions: MarketAssumptions;
  options: BuildSpendingModelScheduleOptions;
  preset: SpendingModelPresetDefinition;
  modifiers: HouseholdSpendingModifiers;
  assumptionSources: SpendingModelAssumptionSources;
  warnings: SpendingModelWarning[];
  startYear: number;
  retirementYear: number;
  planningEndYear: number;
  nonHealthcareInflationGapSupplied: boolean;
}): SpendingModelScheduleResult {
  const scheduleOptions = {
    modifiers: input.options.modifiers,
    startYear: input.options.startYear,
    nonHealthcareInflationGap: input.options.nonHealthcareInflationGap,
  };
  const current = buildSpendingModelSchedule(input.data, input.assumptions, {
    ...scheduleOptions,
    presetId: 'current_faithful',
  });
  const jpmorgan = buildSpendingModelSchedule(input.data, input.assumptions, {
    ...scheduleOptions,
    presetId: 'jpmorgan_curve_travel_included',
  });

  if (current.status !== 'complete' || jpmorgan.status !== 'complete') {
    return emptySkippedResult({
      preset: input.preset,
      modifiers: input.modifiers,
      assumptionSources: {
        ...input.assumptionSources,
        ...buildPresetAssumptionSources({
          preset: input.preset,
          nonHealthcareInflationGapSupplied:
            input.nonHealthcareInflationGapSupplied,
        }),
      },
      assumptions: input.assumptions,
      warnings: [
        ...input.warnings,
        {
          code: 'blend_source_missing',
          severity: 'blocking',
          message:
            'Magic Average requires complete Current Faithful and J.P. Morgan travel-included schedules.',
          relatedFields: ['presetId'],
        },
      ],
      startYear: input.startYear,
      retirementYear: input.retirementYear,
      planningEndYear: input.planningEndYear,
    });
  }

  const jpmorganByYear = new Map(
    jpmorgan.yearlySchedule.map((row) => [row.year, row]),
  );
  const yearlySchedule = current.yearlySchedule
    .map((currentRow) => {
      const jpmorganRow = jpmorganByYear.get(currentRow.year);
      if (!jpmorganRow) return null;
      const faithfulWeight = 1 - MAGIC_AVERAGE_BLEND_WEIGHT;
      const blend = (a: number, b: number) =>
        roundMoney(a * faithfulWeight + b * MAGIC_AVERAGE_BLEND_WEIGHT);
      const finalAnnualSpend = blend(
        currentRow.finalAnnualSpend,
        jpmorganRow.finalAnnualSpend,
      );
      return {
        year: currentRow.year,
        householdAge: currentRow.householdAge,
        inTravelPhase: currentRow.inTravelPhase || jpmorganRow.inTravelPhase,
        currentPlanBaselineAnnualSpend:
          currentRow.currentPlanBaselineAnnualSpend,
        modelBaselineAnnualSpend: blend(
          currentRow.modelBaselineAnnualSpend,
          jpmorganRow.modelBaselineAnnualSpend,
        ),
        jpmorganCurveAnnualSpend: blend(
          currentRow.jpmorganCurveAnnualSpend,
          jpmorganRow.jpmorganCurveAnnualSpend,
        ),
        finalAnnualSpend,
        curveMultiplier: blend(
          currentRow.curveMultiplier,
          jpmorganRow.curveMultiplier,
        ),
        protectedFixedCosts: blend(
          currentRow.protectedFixedCosts,
          jpmorganRow.protectedFixedCosts,
        ),
        curveSubjectAnnual: blend(
          currentRow.curveSubjectAnnual,
          jpmorganRow.curveSubjectAnnual,
        ),
        travelOverlay: blend(currentRow.travelOverlay, jpmorganRow.travelOverlay),
        surgeAdjustment: blend(
          currentRow.surgeAdjustment,
          jpmorganRow.surgeAdjustment,
        ),
        volatilityAdjustment: blend(
          currentRow.volatilityAdjustment,
          jpmorganRow.volatilityAdjustment,
        ),
      } satisfies SpendingModelScheduleYear;
    })
    .filter((row): row is SpendingModelScheduleYear => row !== null);

  const annualSpendScheduleByYear = Object.fromEntries(
    yearlySchedule.map((row) => [row.year, row.finalAnnualSpend]),
  );

  return {
    id: input.preset.id,
    label: input.preset.label,
    status: yearlySchedule.length > 0 ? 'complete' : 'skipped',
    modelCompleteness: 'reconstructed',
    inferredAssumptions: buildInferredAssumptions({
      preset: input.preset,
      partialModifiers: input.options.modifiers ?? {},
      modifiers: input.modifiers,
      nonHealthcareInflationGapSupplied: input.nonHealthcareInflationGapSupplied,
    }),
    assumptionSources: {
      ...input.assumptionSources,
      ...buildPresetAssumptionSources({
        preset: input.preset,
        nonHealthcareInflationGapSupplied: input.nonHealthcareInflationGapSupplied,
      }),
    },
    warnings: input.warnings,
    provenance: buildProvenance(input.assumptions),
    modifiers: input.modifiers,
    preset: input.preset,
    annualSpendScheduleByYear,
    yearlySchedule,
    intermediateCalculations: {
      startYear: input.startYear,
      retirementYear: input.retirementYear,
      planningEndYear: input.planningEndYear,
      householdAgeBasis: input.modifiers.householdAgeBasis,
      curveStartAge: input.modifiers.curveStartAge,
      inflationAssumption: input.assumptions.inflation,
      nonHealthcareInflationGap:
        input.options.nonHealthcareInflationGap ??
        JPMORGAN_DEFAULT_NON_HEALTHCARE_INFLATION_GAP,
      realCurveRatioAnnual:
        jpmorgan.intermediateCalculations.realCurveRatioAnnual,
      jpmorganCurveSourceAnnualSpendByAge: jpmorganCurveSourceAnnualSpendByAge(),
      blanchettSmileProjectedAnnualSpendByAge:
        blanchettSmileProjectedAnnualSpendByAge(),
      blanchettSmileAnnualRealChangeByAge: blanchettSmileAnnualRealChangeByAge(),
      firstRetirementYearAnnualSpend: firstAnnualSpendAtOrAfterYear(
        yearlySchedule,
        input.retirementYear,
      ),
      age80AnnualSpend: annualSpendAtOrAfterAge(yearlySchedule, 80),
      age95AnnualSpend: annualSpendAtOrAfterAge(yearlySchedule, 95),
      magicAverageCurrentFaithfulWeight: 1 - MAGIC_AVERAGE_BLEND_WEIGHT,
      magicAverageJpmorganWeight: MAGIC_AVERAGE_BLEND_WEIGHT,
      magicAverageSourcePresetIds: [
        'current_faithful',
        'jpmorgan_curve_travel_included',
      ],
	    },
	  };
	}

function getExtraTravelAdjustment(preset: SpendingModelPresetDefinition) {
  return preset.adjustments.find(
    (item): item is Extract<SpendingModelAdjustment, { kind: 'extra_travel_overlay' }> =>
      item.kind === 'extra_travel_overlay',
  );
}

function getSurgeAdjustment(preset: SpendingModelPresetDefinition) {
  return preset.adjustments.find(
    (item): item is Extract<SpendingModelAdjustment, { kind: 'transition_surge' }> =>
      item.kind === 'transition_surge',
  );
}

function getVolatilityAdjustment(preset: SpendingModelPresetDefinition) {
  return preset.adjustments.find(
    (item): item is Extract<SpendingModelAdjustment, { kind: 'temporary_spending_shock' }> =>
      item.kind === 'temporary_spending_shock',
  );
}

export function buildSpendingModelSchedule(
  data: SeedData,
  assumptions: MarketAssumptions,
  options: BuildSpendingModelScheduleOptions = {},
): SpendingModelScheduleResult {
  const partialModifiers = options.modifiers ?? {};
  const { modifiers, assumptionSources } =
    resolveHouseholdSpendingModifiers(partialModifiers);
  const preset = buildSpendingModelPresetDefinition(
    options.presetId ?? 'jpmorgan_curve_travel_included',
    modifiers,
  );
  const warnings = validatePreset({ preset, modifiers });
  const startYear = options.startYear ?? DEFAULT_START_YEAR;
  const horizonYears = getRetirementHorizonYears(data, assumptions);
  const planningEndYear = startYear + horizonYears;
  const retirementYear = resolveRetirementYear(data);

  if (warnings.some((warning) => warning.severity === 'blocking')) {
    return emptySkippedResult({
      preset,
      modifiers,
      assumptionSources: {
        ...assumptionSources,
        ...buildPresetAssumptionSources({
          preset,
          nonHealthcareInflationGapSupplied:
            options.nonHealthcareInflationGap !== undefined,
        }),
      },
      assumptions,
      warnings,
      startYear,
      retirementYear,
      planningEndYear,
    });
  }

  if (preset.id === 'magic_average') {
    return buildMagicAverageSchedule({
      data,
      assumptions,
      options,
      preset,
      modifiers,
      assumptionSources,
      warnings,
      startYear,
      retirementYear,
      planningEndYear,
      nonHealthcareInflationGapSupplied:
        options.nonHealthcareInflationGap !== undefined,
    });
  }

  const nonHealthcareInflationGap =
    options.nonHealthcareInflationGap ??
    JPMORGAN_DEFAULT_NON_HEALTHCARE_INFLATION_GAP;
  const targets = getAnnualSpendingTargets(data);
  const startAge = resolveHouseholdAge(data, modifiers.householdAgeBasis);
  const annualSpendScheduleByYear: Record<number, number> = {};
  const yearlySchedule: SpendingModelScheduleYear[] = [];
  const extraTravel = getExtraTravelAdjustment(preset);
  const surge = getSurgeAdjustment(preset);
  const volatility = getVolatilityAdjustment(preset);
  const age75StartYear = ageStartYear({
    startYear,
    startAge,
    targetAge: 75,
  });
  const realCurveRatioAnnual =
      curveMultiplierForAge({
        householdAge: modifiers.curveStartAge + 1,
        curveStartAge: modifiers.curveStartAge,
        inflation: assumptions.inflation,
        nonHealthcareInflationGap,
        preCurveSpendingBehavior: modifiers.preCurveSpendingBehavior,
      }) /
    Math.max(
      0.000_001,
      curveMultiplierForAge({
        householdAge: modifiers.curveStartAge,
        curveStartAge: modifiers.curveStartAge,
        inflation: assumptions.inflation,
        nonHealthcareInflationGap,
        preCurveSpendingBehavior: modifiers.preCurveSpendingBehavior,
      }),
    );

  for (let year = startYear; year <= planningEndYear; year += 1) {
    const yearOffset = year - startYear;
    const householdAge = startAge + yearOffset;
    const yearsIntoRetirement = year - retirementYear;
    const travelFlatYears = assumptions.travelFlatYears ?? assumptions.travelPhaseYears;
    const travelFloorAnnual = targets.travelFloorAnnual ?? 0;
    const inTravelPhase = yearsIntoRetirement < assumptions.travelPhaseYears;
    let currentTravelAnnual: number;
    if (yearsIntoRetirement < travelFlatYears) {
      currentTravelAnnual = targets.travelAnnual;
    } else if (yearsIntoRetirement >= assumptions.travelPhaseYears || travelFlatYears >= assumptions.travelPhaseYears) {
      currentTravelAnnual = travelFloorAnnual;
    } else {
      const progress = (yearsIntoRetirement - travelFlatYears) / (assumptions.travelPhaseYears - travelFlatYears);
      currentTravelAnnual = targets.travelAnnual + (travelFloorAnnual - targets.travelAnnual) * progress;
    }
    const currentPlanBaselineAnnualSpend =
      targets.essentialAnnual +
      targets.flexibleAnnual +
      targets.taxesInsuranceAnnual +
      currentTravelAnnual;

    if (preset.id === 'current_faithful') {
      const finalAnnualSpend = roundMoney(currentPlanBaselineAnnualSpend);
      annualSpendScheduleByYear[year] = finalAnnualSpend;
      yearlySchedule.push({
        year,
        householdAge,
        inTravelPhase,
        currentPlanBaselineAnnualSpend: finalAnnualSpend,
        modelBaselineAnnualSpend: finalAnnualSpend,
        jpmorganCurveAnnualSpend: finalAnnualSpend,
        finalAnnualSpend,
        curveMultiplier: 1,
        protectedFixedCosts: 0,
        curveSubjectAnnual: finalAnnualSpend,
        travelOverlay: roundMoney(currentTravelAnnual),
        surgeAdjustment: 0,
        volatilityAdjustment: 0,
      });
      continue;
    }

    const protectedFixedCosts = modifiers.protectHousingFixedCosts
      ? targets.taxesInsuranceAnnual
      : 0;
    const taxesCurveSubjectAnnual = modifiers.protectHousingFixedCosts
      ? 0
      : targets.taxesInsuranceAnnual;
    const explicitTravelOverlay =
      preset.travelTreatment === 'current_explicit_overlay' ? currentTravelAnnual : 0;
    const normalTravelCurveSubjectAnnual =
      preset.travelTreatment === 'current_explicit_overlay' ? 0 : targets.travelAnnual;
    const extraTravelOverlay =
      extraTravel && year >= startYear && year < startYear + extraTravel.years
        ? extraTravel.annualAmount
        : 0;
    const travelOverlay = explicitTravelOverlay + extraTravelOverlay;
    const curveSubjectAnnual =
      targets.essentialAnnual +
      targets.flexibleAnnual +
      taxesCurveSubjectAnnual +
      normalTravelCurveSubjectAnnual;
    const modelBaselineAnnualSpend =
      protectedFixedCosts + curveSubjectAnnual + travelOverlay;
    const curveMultiplier = curveMultiplierForAge({
      householdAge,
      curveStartAge: modifiers.curveStartAge,
      inflation: assumptions.inflation,
      nonHealthcareInflationGap,
      preCurveSpendingBehavior: modifiers.preCurveSpendingBehavior,
    });
    const jpmorganCurveAnnualSpend =
      protectedFixedCosts + curveSubjectAnnual * curveMultiplier + travelOverlay;
    const surgeStartYear = retirementYear;
    const surgeAdjustment =
      surge && year >= surgeStartYear && year < surgeStartYear + surge.years
        ? jpmorganCurveAnnualSpend * surge.percent
        : 0;
    const volatilityStartYear =
      volatility?.start === 'age75' ? age75StartYear : retirementYear;
    const volatilityAdjustment =
      volatility &&
      year >= volatilityStartYear &&
      year < volatilityStartYear + volatility.years
        ? (jpmorganCurveAnnualSpend + surgeAdjustment) * volatility.percent
        : 0;
    const finalAnnualSpend = Math.max(
      0,
      jpmorganCurveAnnualSpend + surgeAdjustment + volatilityAdjustment,
    );

    annualSpendScheduleByYear[year] = roundMoney(finalAnnualSpend);
    yearlySchedule.push({
      year,
      householdAge,
      inTravelPhase,
      currentPlanBaselineAnnualSpend: roundMoney(currentPlanBaselineAnnualSpend),
      modelBaselineAnnualSpend: roundMoney(modelBaselineAnnualSpend),
      jpmorganCurveAnnualSpend: roundMoney(jpmorganCurveAnnualSpend),
      finalAnnualSpend: roundMoney(finalAnnualSpend),
      curveMultiplier,
      protectedFixedCosts: roundMoney(protectedFixedCosts),
      curveSubjectAnnual: roundMoney(curveSubjectAnnual),
      travelOverlay: roundMoney(travelOverlay),
      surgeAdjustment: roundMoney(surgeAdjustment),
      volatilityAdjustment: roundMoney(volatilityAdjustment),
    });
  }

  return {
    id: preset.id,
    label: preset.label,
    status: 'complete',
    modelCompleteness:
      preset.id === 'current_faithful' ? 'faithful' : 'reconstructed',
    inferredAssumptions: buildInferredAssumptions({
      preset,
      partialModifiers,
      modifiers,
      nonHealthcareInflationGapSupplied:
        options.nonHealthcareInflationGap !== undefined,
    }),
    assumptionSources: {
      ...assumptionSources,
      ...buildPresetAssumptionSources({
        preset,
        nonHealthcareInflationGapSupplied:
          options.nonHealthcareInflationGap !== undefined,
      }),
    },
    warnings,
    provenance: buildProvenance(assumptions),
    modifiers,
    preset,
    annualSpendScheduleByYear,
    yearlySchedule,
    intermediateCalculations: {
      startYear,
      retirementYear,
      planningEndYear,
      householdAgeBasis: modifiers.householdAgeBasis,
      curveStartAge: modifiers.curveStartAge,
      inflationAssumption: assumptions.inflation,
      nonHealthcareInflationGap,
      realCurveRatioAnnual,
      jpmorganCurveSourceAnnualSpendByAge: jpmorganCurveSourceAnnualSpendByAge(),
      blanchettSmileProjectedAnnualSpendByAge:
        blanchettSmileProjectedAnnualSpendByAge(),
      blanchettSmileAnnualRealChangeByAge: blanchettSmileAnnualRealChangeByAge(),
      firstRetirementYearAnnualSpend:
        yearlySchedule.find((point) => point.year >= retirementYear)
          ?.finalAnnualSpend ?? null,
      age80AnnualSpend: findAnnualSpendAtOrAfterAge(yearlySchedule, 80),
      age95AnnualSpend: findAnnualSpendAtOrAfterAge(yearlySchedule, 95),
    },
  };
}

export function buildDefaultSpendingModelSchedules(
  data: SeedData,
  assumptions: MarketAssumptions,
  options: Omit<BuildSpendingModelScheduleOptions, 'presetId'> = {},
) {
  const { modifiers } = resolveHouseholdSpendingModifiers(options.modifiers);
  return buildDefaultSpendingModelPresetDefinitions(modifiers)
    .filter((preset) => preset.defaultSelected)
    .map((preset) =>
      buildSpendingModelSchedule(data, assumptions, {
        ...options,
        presetId: preset.id,
      }),
    );
}
