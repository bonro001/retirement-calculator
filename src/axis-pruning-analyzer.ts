import type { Policy, PolicyAxes, PolicyEvaluation } from './policy-miner-types';

/**
 * Adaptive axis-pruning analyzer.
 *
 * Pure function over a corpus of `PolicyEvaluation` records. Identifies
 * axis values (spend / SS / Roth) that produced ONLY infeasible
 * candidates — i.e. every (cross-axis) combination at that value
 * violated both north stars — and recommends a narrowed axis range
 * that drops them. The mining UI surfaces this as an "Apply narrower
 * range" button.
 *
 * Why this exists: the V1 policy axes (`buildDefaultPolicyAxes` in
 * `policy-axis-enumerator.ts`) are heuristic — 8 spend levels × 6 SS
 * ages × 6 SS ages × 6 Roth caps = 1,728 candidates. After a mine
 * completes, the household sees recommendations pinned at axis
 * extremes (e.g. recommended spend = $80k bottom of grid → "should I
 * actually spend less?"). They have no signal that the BOTTOM of the
 * grid produced 100% failures and the result is just the floor.
 *
 * This analyzer answers: "given the actual corpus, which axis values
 * are dominated everywhere?" The answer can prune the grid for the
 * next mine pass — fewer candidates, same coverage of the feasible
 * region, faster mine.
 *
 * Architectural placement:
 *   - Pure function (no engine calls) → cheap; runs in the browser.
 *   - Composes with the existing `evaluatePolicy` corpus shape; no
 *     changes to the miner, the cluster protocol, or storage.
 *   - Companion to spend-optimizer's infeasibility flag — that flag
 *     tells you the FRONTIER violates a constraint; this tells you
 *     the SEARCH RANGE was poorly chosen.
 */

export type PolicyAxisName =
  | 'annualSpendTodayDollars'
  | 'primarySocialSecurityClaimAge'
  | 'spouseSocialSecurityClaimAge'
  | 'rothConversionAnnualCeiling';

export interface AxisFeasibilityCheck {
  /** Solvent success rate floor. Default 0.85. */
  targetSolventRate: number;
  /** Legacy attainment rate floor. Default 0.85 — null skips legacy. */
  targetLegacyAttainmentRate: number | null;
}

export interface AxisValueAnalysis {
  /** The axis we're analyzing. */
  axis: PolicyAxisName;
  /** The specific value of that axis (e.g. $80,000 for the spend axis). */
  value: number;
  /** Total candidates at this value across all other axes. */
  totalCandidates: number;
  /** Candidates that satisfy BOTH constraints. */
  feasibleCandidates: number;
  /** Best (max) solvent rate observed at this axis value. */
  maxSolventRate: number;
  /** Best (max) legacy attainment observed (null if no legacy goal). */
  maxLegacyAttainmentRate: number | null;
  /** True iff every candidate at this value failed at least one
   *  constraint. The recommended-narrow range drops these values. */
  alwaysInfeasible: boolean;
}

export interface AxisAnalysis {
  axis: PolicyAxisName;
  /** Per-value feasibility breakdown. */
  values: AxisValueAnalysis[];
  /** Values that contributed feasibility to this axis. Subset of
   *  `values.map(v => v.value)` filtered to those NOT alwaysInfeasible. */
  feasibleValues: number[];
  /** Original axis values from the input axes spec — for the UI to
   *  show "before/after". */
  originalValues: number[];
  /** Whether the analyzer recommends pruning this axis. False when
   *  no value is alwaysInfeasible (no signal to prune) OR when ALL
   *  values are alwaysInfeasible (the whole axis is broken — pruning
   *  doesn't help; the household needs a fundamentally different
   *  strategy). */
  shouldPrune: boolean;
  /** Recommended narrowed list of values for this axis. Empty when
   *  `shouldPrune` is false; the original values are still valid. */
  recommendedValues: number[];
}

export interface AxisPruningAnalysis {
  /** Per-axis feasibility breakdown. */
  axes: Record<PolicyAxisName, AxisAnalysis>;
  /** Recommended axes spec for the next mine pass. Equals input axes
   *  on any axis that doesn't recommend pruning. */
  recommendedAxes: PolicyAxes;
  /** Number of candidates the original grid would emit. */
  originalGridSize: number;
  /** Number of candidates the recommended grid would emit. */
  recommendedGridSize: number;
  /** True iff at least one axis recommends a non-trivial narrowing. */
  hasRecommendation: boolean;
  /** Total feasibility flag — false when the entire corpus has zero
   *  feasible candidates. Pruning is meaningless then; the UI should
   *  surface the infeasibility instead. */
  corpusHasFeasibleCandidates: boolean;
}

const ALL_AXES: PolicyAxisName[] = [
  'annualSpendTodayDollars',
  'primarySocialSecurityClaimAge',
  'spouseSocialSecurityClaimAge',
  'rothConversionAnnualCeiling',
];

function getAxisValueFromPolicy(
  policy: Policy,
  axis: PolicyAxisName,
): number | null {
  const v = policy[axis];
  return typeof v === 'number' ? v : null;
}

function isFeasible(
  e: PolicyEvaluation,
  check: AxisFeasibilityCheck,
): boolean {
  if (e.outcome.solventSuccessRate < check.targetSolventRate) return false;
  if (
    check.targetLegacyAttainmentRate !== null &&
    e.outcome.bequestAttainmentRate < check.targetLegacyAttainmentRate
  ) {
    return false;
  }
  return true;
}

function countCandidatesInAxes(axes: PolicyAxes): number {
  const spouseLen = axes.spouseSocialSecurityClaimAge?.length ?? 1;
  return (
    axes.annualSpendTodayDollars.length *
    axes.primarySocialSecurityClaimAge.length *
    spouseLen *
    axes.rothConversionAnnualCeiling.length
  );
}

function analyzeOneAxis(
  axis: PolicyAxisName,
  axisValues: number[] | null,
  evaluations: PolicyEvaluation[],
  check: AxisFeasibilityCheck,
): AxisAnalysis {
  if (axisValues === null) {
    // Spouse axis when there's no spouse SS record. Single null slot;
    // nothing to prune.
    return {
      axis,
      values: [],
      feasibleValues: [],
      originalValues: [],
      shouldPrune: false,
      recommendedValues: [],
    };
  }

  const valueAnalyses: AxisValueAnalysis[] = axisValues.map((v) => {
    const matching = evaluations.filter(
      (e) => getAxisValueFromPolicy(e.policy, axis) === v,
    );
    const feasible = matching.filter((e) => isFeasible(e, check));
    const maxSolvent = matching.length
      ? Math.max(...matching.map((e) => e.outcome.solventSuccessRate))
      : 0;
    const legacyValues = matching
      .map((e) => e.outcome.bequestAttainmentRate)
      .filter((x) => Number.isFinite(x));
    const maxLegacy =
      check.targetLegacyAttainmentRate !== null && legacyValues.length
        ? Math.max(...legacyValues)
        : null;
    return {
      axis,
      value: v,
      totalCandidates: matching.length,
      feasibleCandidates: feasible.length,
      maxSolventRate: maxSolvent,
      maxLegacyAttainmentRate: maxLegacy,
      // "Always infeasible" requires at least one observed candidate
      // at this value; an empty bucket means the value was never
      // sampled (rare but possible if the corpus is partial).
      alwaysInfeasible: matching.length > 0 && feasible.length === 0,
    };
  });

  const feasibleValues = valueAnalyses
    .filter((v) => !v.alwaysInfeasible && v.feasibleCandidates > 0)
    .map((v) => v.value);
  const someInfeasible = valueAnalyses.some((v) => v.alwaysInfeasible);
  const allInfeasible = valueAnalyses.every((v) => v.alwaysInfeasible);
  // Don't recommend pruning if the entire axis is infeasible — that
  // means pruning the grid won't help; the household has a deeper
  // problem (returns / runway / lifestyle) that no axis tweak fixes.
  const shouldPrune = someInfeasible && !allInfeasible;

  return {
    axis,
    values: valueAnalyses,
    feasibleValues,
    originalValues: axisValues.slice(),
    shouldPrune,
    recommendedValues: shouldPrune ? feasibleValues : axisValues.slice(),
  };
}

/**
 * Run the analyzer.
 *
 * @param evaluations the corpus to analyze (typically all
 *   PolicyEvaluation records for the current baseline + engine version)
 * @param axes the axes spec the corpus was generated from
 * @param check feasibility floors (default 0.85 / 0.85)
 */
export function analyzeAxisPruning(
  evaluations: PolicyEvaluation[],
  axes: PolicyAxes,
  check: AxisFeasibilityCheck = {
    targetSolventRate: 0.85,
    targetLegacyAttainmentRate: 0.85,
  },
): AxisPruningAnalysis {
  const axesByName: Record<PolicyAxisName, AxisAnalysis> = {
    annualSpendTodayDollars: analyzeOneAxis(
      'annualSpendTodayDollars',
      axes.annualSpendTodayDollars,
      evaluations,
      check,
    ),
    primarySocialSecurityClaimAge: analyzeOneAxis(
      'primarySocialSecurityClaimAge',
      axes.primarySocialSecurityClaimAge,
      evaluations,
      check,
    ),
    spouseSocialSecurityClaimAge: analyzeOneAxis(
      'spouseSocialSecurityClaimAge',
      axes.spouseSocialSecurityClaimAge,
      evaluations,
      check,
    ),
    rothConversionAnnualCeiling: analyzeOneAxis(
      'rothConversionAnnualCeiling',
      axes.rothConversionAnnualCeiling,
      evaluations,
      check,
    ),
  };

  const recommendedAxes: PolicyAxes = {
    annualSpendTodayDollars: axesByName.annualSpendTodayDollars.recommendedValues,
    primarySocialSecurityClaimAge:
      axesByName.primarySocialSecurityClaimAge.recommendedValues,
    spouseSocialSecurityClaimAge:
      axes.spouseSocialSecurityClaimAge === null
        ? null
        : axesByName.spouseSocialSecurityClaimAge.recommendedValues,
    rothConversionAnnualCeiling:
      axesByName.rothConversionAnnualCeiling.recommendedValues,
  };

  const hasRecommendation = ALL_AXES.some((a) => axesByName[a].shouldPrune);
  const corpusHasFeasibleCandidates = evaluations.some((e) => isFeasible(e, check));

  return {
    axes: axesByName,
    recommendedAxes,
    originalGridSize: countCandidatesInAxes(axes),
    recommendedGridSize: countCandidatesInAxes(recommendedAxes),
    hasRecommendation,
    corpusHasFeasibleCandidates,
  };
}

/**
 * Produce a 1-2 sentence human-readable summary of the analysis. The
 * UI uses this for the "Apply narrower range" callout subtitle.
 */
export function summarizeAxisPruning(
  analysis: AxisPruningAnalysis,
): string {
  if (!analysis.corpusHasFeasibleCandidates) {
    return (
      'No candidate in the current grid satisfies both north stars. ' +
      'Pruning the axes won’t help — the plan needs a deeper change ' +
      '(more savings, later retirement, or a relaxed constraint).'
    );
  }
  if (!analysis.hasRecommendation) {
    return (
      'Every axis value contributed at least one feasible candidate. ' +
      'No narrowing recommended — the current grid is already a good fit.'
    );
  }
  const drops = ALL_AXES.flatMap((a) => {
    const ax = analysis.axes[a];
    if (!ax.shouldPrune) return [];
    const dropped = ax.originalValues.filter(
      (v) => !ax.recommendedValues.includes(v),
    );
    return [{ axis: a, dropped }];
  });
  const dropDescriptions = drops.map((d) => {
    const label =
      d.axis === 'annualSpendTodayDollars'
        ? 'spend levels'
        : d.axis === 'primarySocialSecurityClaimAge'
          ? 'primary SS ages'
          : d.axis === 'spouseSocialSecurityClaimAge'
            ? 'spouse SS ages'
            : 'Roth ceilings';
    const sample = d.dropped.slice(0, 3).join(', ');
    const tail = d.dropped.length > 3 ? ', …' : '';
    return `${d.dropped.length} ${label} (${sample}${tail})`;
  });
  return (
    `Drop ${dropDescriptions.join(' and ')}. ` +
    `Grid shrinks from ${analysis.originalGridSize} to ` +
    `${analysis.recommendedGridSize} candidates without losing any feasible region.`
  );
}
