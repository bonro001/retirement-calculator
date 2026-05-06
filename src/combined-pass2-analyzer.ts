/**
 * Combined pass-2 analyzer — merges cliff-refinement and rule-sweep
 * into a SINGLE pass-2 mine that produces full V2 fidelity on the
 * policies that contend for the recommendation.
 *
 * Why combined: today, cliff and rule sweep are separate pass-2 modes.
 * Running them sequentially means two extra mine sessions and two
 * "Use sweep axes →" clicks. For the household, the questions they
 * answer ("how precise is the max-spend?" and "which withdrawal
 * rule wins?") are part of the same decision. Combining them removes
 * a UX seam without changing the search semantics.
 *
 * Output axes:
 *   - Spend: $1k resolution across the feasibility cliff bracket (from
 *     cliff analyzer). Falls back to the contenders' spend bounding box
 *     when no cliff is detected (corpus uniformly feasible / infeasible).
 *   - Primary SS, Spouse SS, Roth: contender bounding box (from rule
 *     sweep analyzer). Narrowing these to contenders is correct:
 *     non-contender combinations aren't candidates for the
 *     recommendation regardless of which spend tier they sit at.
 *   - Withdrawal rule: ALL FOUR. So the contender box gets evaluated
 *     under every rule, including default — picking up any policy
 *     where a non-default rule beats default at the cliff.
 *
 * Estimated candidate count for a typical household:
 *   ~6 spend × ~4 primary SS × ~4 spouse SS × ~3 Roth × 4 rules ≈ 1,150
 * On the cluster: ~10-20 sec wall time. The pipeline (pass-1 + this
 * combined pass-2) lands at ~1m45s end-to-end.
 */

import {
  recommendCliffRefinement,
  type FeasibilityMetric,
} from './cliff-refinement-analyzer';
import { recommendRuleSweep } from './rule-sweep-analyzer';
import {
  ALL_WITHDRAWAL_RULES,
  buildDefaultPolicyAxes,
} from './policy-axis-enumerator';
import type { PolicyAxes, PolicyEvaluation } from './policy-miner-types';
import type { SeedData } from './types';

export interface CombinedPass2Recommendation {
  /** True when there are enough contenders to justify pass-2 work. */
  hasRecommendation: boolean;
  /** Pass-2 axes ready to feed into `axesOverride`. Default-grid shape
   *  when `hasRecommendation` is false. */
  axes: PolicyAxes;
  /** Did the cliff analyzer find a feasibility cliff to refine? When
   *  false, pass-2 still runs the rule sweep on the contenders' spend
   *  bounding box (no $1k zoom, just the contender spends). */
  hasCliff: boolean;
  /** How many pass-1 records made the contender cut. */
  contenderCount: number;
  /** Estimated pass-2 candidate count = box × 4 rules. */
  estimatedPass2Candidates: number;
  /** Spend bracket used. When `hasCliff`, this is the $1k cliff range;
   *  otherwise the contenders' bounding box. */
  spendLowerDollars: number;
  spendUpperDollars: number;
  /** Plain-English reason for the household. */
  rationale: string;
}

export function recommendCombinedPass2(
  evaluations: readonly PolicyEvaluation[],
  seedData: SeedData,
  feasibilityThreshold = 0.85,
  metric: FeasibilityMetric = 'legacy',
): CombinedPass2Recommendation {
  const baseAxes = buildDefaultPolicyAxes(seedData);

  if (evaluations.length === 0) {
    return {
      hasRecommendation: false,
      axes: baseAxes,
      hasCliff: false,
      contenderCount: 0,
      estimatedPass2Candidates: 0,
      spendLowerDollars: 0,
      spendUpperDollars: 0,
      rationale: 'Pass-1 corpus is empty — nothing to refine.',
    };
  }

  // Reuse the existing analyzers for their domain logic. We only need
  // their `axes` outputs; ignoring rationale/diagnostics they emit.
  const cliff = recommendCliffRefinement(
    [...evaluations],
    seedData,
    feasibilityThreshold,
    metric,
  );
  const sweep = recommendRuleSweep(evaluations, seedData);

  if (!sweep.hasRecommendation) {
    return {
      hasRecommendation: false,
      axes: baseAxes,
      hasCliff: cliff.hasRecommendation,
      contenderCount: sweep.contenderCount,
      estimatedPass2Candidates: 0,
      spendLowerDollars: 0,
      spendUpperDollars: 0,
      rationale:
        'Pass-1 produced no contenders within striking distance of the leader — no pass-2 refinement to do.',
    };
  }

  // Spend axis: prefer the $1k cliff bracket when present, fall back to
  // the contenders' bounding box. Either way, it's a tight band of the
  // spend levels that matter for the recommendation.
  const spends = cliff.hasRecommendation
    ? cliff.axes.annualSpendTodayDollars
    : sweep.axes.annualSpendTodayDollars;

  // SS / Roth: always use the contender bounding box. Non-contender
  // combinations aren't candidates for the recommendation under any
  // rule, so refining them at the cliff would be waste.
  const primarySS = sweep.axes.primarySocialSecurityClaimAge;
  const spouseSS = sweep.axes.spouseSocialSecurityClaimAge;
  const roth = sweep.axes.rothConversionAnnualCeiling;

  const combinedAxes: PolicyAxes = {
    annualSpendTodayDollars: spends,
    primarySocialSecurityClaimAge: primarySS,
    spouseSocialSecurityClaimAge: spouseSS,
    rothConversionAnnualCeiling: roth,
    // All four rules so the contender box gets a full rule comparison,
    // including default at the new $1k spend resolution.
    withdrawalRule: [...ALL_WITHDRAWAL_RULES],
  };

  const estimated =
    spends.length *
    primarySS.length *
    (spouseSS?.length ?? 1) *
    roth.length *
    ALL_WITHDRAWAL_RULES.length;

  if (estimated === 0) {
    return {
      hasRecommendation: false,
      axes: baseAxes,
      hasCliff: cliff.hasRecommendation,
      contenderCount: sweep.contenderCount,
      estimatedPass2Candidates: 0,
      spendLowerDollars: 0,
      spendUpperDollars: 0,
      rationale: 'Combined pass-2 axes are degenerate — skipping.',
    };
  }

  const lower = spends[0]!;
  const upper = spends[spends.length - 1]!;

  const cliffNote = cliff.hasRecommendation
    ? `$1k spend resolution across the cliff ($${(lower / 1000).toFixed(0)}k–$${(upper / 1000).toFixed(0)}k)`
    : `the contenders' spend range ($${(lower / 1000).toFixed(0)}k–$${(upper / 1000).toFixed(0)}k)`;

  return {
    hasRecommendation: true,
    axes: combinedAxes,
    hasCliff: cliff.hasRecommendation,
    contenderCount: sweep.contenderCount,
    estimatedPass2Candidates: estimated,
    spendLowerDollars: lower,
    spendUpperDollars: upper,
    rationale: `${sweep.contenderCount} contender${sweep.contenderCount === 1 ? '' : 's'} from pass-1. Pass-2 will refine ${cliffNote} across all four withdrawal rules — ~${estimated.toLocaleString()} candidates.`,
  };
}
